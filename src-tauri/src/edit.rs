//! the editor wire contract and the pure translation from wire ops to the
//! engine's canonical batch. one apply_edit call = one engine batch = one
//! undo step; every index in a call refers to the pre-batch frame array,
//! unique across the call per target kind

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use engine::math::Vec2;
use engine::replay::document::{BatchApplied, EditMember};
use engine::replay::frames::{Buttons, ReplayFrame};

use crate::error::IpcError;
use crate::scene::{FrameDto, SimulationDto};

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EditOp {
    MoveFrames { moves: Vec<FrameMove> },
    InsertFrames { frames: Vec<FrameDto> },
    DeleteFrames { indices: Vec<usize> },
    SetButtons { sets: Vec<ButtonSet> },
    SetPlayerName { name: Option<String> },
    SetTimestamp { ticks: String },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameMove {
    pub index: usize,
    pub x: f32,
    pub y: f32,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ButtonSet {
    pub index: usize,
    pub buttons: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditDelta {
    pub revision: u64,
    pub frames: Option<FrameChanges>,
    pub player_name: Option<String>,
    /// decimal string, the ReplayMeta.timestampTicks convention
    pub timestamp_ticks: String,
    /// the union of the two split flags, kept for the dirty chip
    pub dirty: bool,
    /// the document's dirty split: the export dialog keys its path
    /// expectation off which kind of dirty the session is
    pub frames_dirty: bool,
    pub metadata_dirty: bool,
    pub can_undo: bool,
    pub can_redo: bool,
    pub history: HistoryDto,
    pub simulation: Option<SimulationDto>,
}

/// the three change lists have fixed coordinate spaces so a mixed batch is
/// unambiguous whatever order its members ran in: removed holds pre-op
/// indices, inserted and updated post-op indices, all ascending
#[derive(Debug, Clone, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum FrameChanges {
    Delta {
        updated: Vec<IndexedFrame>,
        inserted: Vec<IndexedFrame>,
        removed: Vec<usize>,
    },
    Full {
        full_frames: Vec<FrameDto>,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexedFrame {
    pub index: usize,
    pub frame: FrameDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryDto {
    pub labels: Vec<String>,
    pub cursor: usize,
}

/// deltas fall back to the full stream when the change list exceeds this
/// fraction of the frame count (spec: revert_all, mass undo)
const FULL_FRAMES_THRESHOLD: f64 = 0.2;

fn invalid(message: impl Into<String>) -> IpcError {
    IpcError::InvalidEdit {
        message: message.into(),
    }
}

pub fn ops_touch_frames(ops: &[EditOp]) -> bool {
    ops.iter()
        .any(|op| !matches!(op, EditOp::SetPlayerName { .. } | EditOp::SetTimestamp { .. }))
}

pub fn frame_changed(report: &BatchApplied) -> bool {
    report.full_replace
        || !(report.updated.is_empty() && report.removed.is_empty() && report.inserted.is_empty())
}

/// translates wire ops into the engine's canonical member order: content
/// updates in encounter order (their targets are untouched pre-batch
/// positions), deletes descending, inserts stable-sorted by time (preserving
/// ops-vector then array order among equal times), then metadata. rejects
/// oversized calls, empty calls, empty container ops, per-kind duplicate
/// targets, and unparseable ticks
pub fn translate_ops(ops: &[EditOp]) -> Result<Vec<EditMember>, IpcError> {
    translate_ops_bounded(ops, engine::limits::MAX_EDIT_BATCH_MEMBERS)
}

/// the cap is a parameter so its boundary test can drive it with small
/// inputs, mirroring the engine's budget-parameterized pattern
fn translate_ops_bounded(ops: &[EditOp], cap: usize) -> Result<Vec<EditMember>, IpcError> {
    if ops.is_empty() {
        return Err(invalid("apply_edit carries no ops"));
    }
    // the weighted count preflights the engine's member cap before any
    // translation work: one weight per indexed target or inserted frame,
    // scalar metadata ops weigh one, so the wire-level rule and the
    // document-level cap agree by construction
    let weighted: usize = ops
        .iter()
        .map(|op| match op {
            EditOp::MoveFrames { moves } => moves.len().max(1),
            EditOp::SetButtons { sets } => sets.len().max(1),
            EditOp::DeleteFrames { indices } => indices.len().max(1),
            EditOp::InsertFrames { frames } => frames.len().max(1),
            EditOp::SetPlayerName { .. } | EditOp::SetTimestamp { .. } => 1,
        })
        .sum();
    if weighted > cap {
        return Err(IpcError::ResourceLimit {
            cap: "MAX_EDIT_BATCH_MEMBERS".into(),
            limit: cap as u64,
            actual: weighted as u64,
        });
    }
    let mut updates: Vec<EditMember> = Vec::new();
    let mut moved: HashSet<usize> = HashSet::new();
    let mut buttons_set: HashSet<usize> = HashSet::new();
    let mut deletes: Vec<usize> = Vec::new();
    let mut inserts: Vec<FrameDto> = Vec::new();
    let mut metadata: Vec<EditMember> = Vec::new();

    for op in ops {
        match op {
            EditOp::MoveFrames { moves } => {
                if moves.is_empty() {
                    return Err(invalid("moveFrames carries no moves"));
                }
                for m in moves {
                    if !moved.insert(m.index) {
                        return Err(invalid(format!(
                            "frame {} moved twice in one apply_edit",
                            m.index
                        )));
                    }
                    updates.push(EditMember::MoveFrame {
                        index: m.index,
                        to: Vec2::new(m.x, m.y),
                    });
                }
            }
            EditOp::SetButtons { sets } => {
                if sets.is_empty() {
                    return Err(invalid("setButtons carries no sets"));
                }
                for s in sets {
                    if !buttons_set.insert(s.index) {
                        return Err(invalid(format!(
                            "frame {} has its buttons set twice in one apply_edit",
                            s.index
                        )));
                    }
                    updates.push(EditMember::SetButtons {
                        index: s.index,
                        buttons: Buttons::new(s.buttons),
                    });
                }
            }
            EditOp::DeleteFrames { indices } => {
                if indices.is_empty() {
                    return Err(invalid("deleteFrames carries no indices"));
                }
                deletes.extend_from_slice(indices);
            }
            EditOp::InsertFrames { frames } => {
                if frames.is_empty() {
                    return Err(invalid("insertFrames carries no frames"));
                }
                inserts.extend_from_slice(frames);
            }
            EditOp::SetPlayerName { name } => {
                metadata.push(EditMember::SetPlayerName { name: name.clone() });
            }
            EditOp::SetTimestamp { ticks } => {
                let ticks: i64 = ticks
                    .trim()
                    .parse()
                    .map_err(|_| invalid("timestamp ticks must be a decimal integer string"))?;
                metadata.push(EditMember::SetTimestamp { ticks });
            }
        }
    }

    deletes.sort_unstable();
    if deletes.windows(2).any(|w| w[0] == w[1]) {
        return Err(invalid("frame deleted twice in one apply_edit"));
    }
    deletes.reverse();
    // stable: keeps ops-vector then array order among equal times
    inserts.sort_by(|a, b| a.time.total_cmp(&b.time));

    let mut members = updates;
    members.extend(deletes.into_iter().map(|index| EditMember::DeleteFrame { index }));
    members.extend(inserts.into_iter().map(|f| EditMember::InsertFrame {
        frame: ReplayFrame {
            time: f.time,
            pos: Vec2::new(f.x, f.y),
            buttons: Buttons::new(f.buttons),
        },
    }));
    members.extend(metadata);
    Ok(members)
}

pub fn full_frames(frames: &[ReplayFrame]) -> FrameChanges {
    FrameChanges::Full {
        full_frames: frames.iter().map(FrameDto::from_frame).collect(),
    }
}

/// the delta's frames field for a report over the post-op frame array: None
/// for metadata-only reports, the fullFrames fallback past the threshold or
/// for a full replace, the three fixed-space lists otherwise
pub fn frame_changes(report: &BatchApplied, frames: &[ReplayFrame]) -> Option<FrameChanges> {
    if report.full_replace {
        return Some(full_frames(frames));
    }
    if !frame_changed(report) {
        return None;
    }
    let touched = report.updated.len() + report.removed.len() + report.inserted.len();
    if (touched as f64) > (frames.len() as f64) * FULL_FRAMES_THRESHOLD {
        return Some(full_frames(frames));
    }
    let indexed = |indices: &[usize]| -> Vec<IndexedFrame> {
        indices
            .iter()
            .map(|&index| IndexedFrame {
                index,
                frame: FrameDto::from_frame(&frames[index]),
            })
            .collect()
    };
    Some(FrameChanges::Delta {
        updated: indexed(&report.updated),
        inserted: indexed(&report.inserted),
        removed: report.removed.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::math::Vec2;
    use engine::replay::frames::{Buttons, ReplayFrame};

    fn frame(time: f64) -> ReplayFrame {
        ReplayFrame {
            time,
            pos: Vec2::new(0.0, 0.0),
            buttons: Buttons::default(),
        }
    }

    #[test]
    fn ops_deserialize_from_the_camel_case_wire() {
        let ops: Vec<EditOp> = serde_json::from_value(serde_json::json!([
            { "kind": "moveFrames", "moves": [{ "index": 1, "x": 2.5, "y": 3.5 }] },
            { "kind": "insertFrames", "frames": [{ "time": 10.0, "x": 1.0, "y": 2.0, "buttons": 5 }] },
            { "kind": "deleteFrames", "indices": [4] },
            { "kind": "setButtons", "sets": [{ "index": 0, "buttons": 10 }] },
            { "kind": "setPlayerName", "name": null },
            { "kind": "setTimestamp", "ticks": "638712000000000001" }
        ]))
        .unwrap();
        assert_eq!(ops.len(), 6);
    }

    #[test]
    fn translation_orders_updates_deletes_desc_inserts_by_time_then_metadata() {
        let ops = vec![
            EditOp::DeleteFrames { indices: vec![2, 7] },
            EditOp::SetTimestamp { ticks: "5".into() },
            EditOp::InsertFrames {
                frames: vec![
                    FrameDto {
                        time: 300.0,
                        x: 0.0,
                        y: 0.0,
                        buttons: 0,
                    },
                    FrameDto {
                        time: 100.0,
                        x: 0.0,
                        y: 0.0,
                        buttons: 0,
                    },
                ],
            },
            EditOp::MoveFrames {
                moves: vec![FrameMove {
                    index: 1,
                    x: 9.0,
                    y: 9.0,
                }],
            },
            EditOp::InsertFrames {
                frames: vec![FrameDto {
                    time: 100.0,
                    x: 1.0,
                    y: 1.0,
                    buttons: 1,
                }],
            },
        ];
        let members = translate_ops(&ops).unwrap();
        let kinds: Vec<&'static str> = members
            .iter()
            .map(|m| match m {
                EditMember::MoveFrame { .. } => "move",
                EditMember::SetButtons { .. } => "buttons",
                EditMember::DeleteFrame { .. } => "delete",
                EditMember::InsertFrame { .. } => "insert",
                EditMember::SetPlayerName { .. } | EditMember::SetTimestamp { .. } => "meta",
            })
            .collect();
        assert_eq!(
            kinds,
            vec!["move", "delete", "delete", "insert", "insert", "insert", "meta"]
        );
        // deletes descending
        assert!(matches!(members[1], EditMember::DeleteFrame { index: 7 }));
        assert!(matches!(members[2], EditMember::DeleteFrame { index: 2 }));
        // inserts time-sorted, ops-vector then array order among the two t=100
        let insert_times: Vec<(f64, u32)> = members
            .iter()
            .filter_map(|m| match m {
                EditMember::InsertFrame { frame } => Some((frame.time, frame.buttons.raw)),
                _ => None,
            })
            .collect();
        assert_eq!(insert_times, vec![(100.0, 0), (100.0, 1), (300.0, 0)]);
    }

    #[test]
    fn empty_calls_and_empty_containers_are_invalid() {
        assert!(matches!(translate_ops(&[]), Err(IpcError::InvalidEdit { .. })));
        let ops = vec![EditOp::MoveFrames { moves: vec![] }];
        assert!(matches!(translate_ops(&ops), Err(IpcError::InvalidEdit { .. })));
    }

    #[test]
    fn the_weighted_count_preflights_the_member_cap() {
        // three delete targets weigh 3, the metadata op weighs 1: 4 total
        let ops = vec![
            EditOp::DeleteFrames {
                indices: vec![0, 1, 2],
            },
            EditOp::SetPlayerName { name: None },
        ];
        assert!(translate_ops_bounded(&ops, 4).is_ok());
        match translate_ops_bounded(&ops, 3) {
            Err(IpcError::ResourceLimit {
                cap,
                limit: 3,
                actual: 4,
            }) => assert_eq!(cap, "MAX_EDIT_BATCH_MEMBERS"),
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn cross_op_duplicates_are_invalid_per_target_kind() {
        // the same frame moved twice across two ops: invalid
        let ops = vec![
            EditOp::MoveFrames {
                moves: vec![FrameMove {
                    index: 1,
                    x: 0.0,
                    y: 0.0,
                }],
            },
            EditOp::MoveFrames {
                moves: vec![FrameMove {
                    index: 1,
                    x: 5.0,
                    y: 5.0,
                }],
            },
        ];
        assert!(matches!(translate_ops(&ops), Err(IpcError::InvalidEdit { .. })));
        // moved and buttons-set and deleted: three distinct kinds, permitted
        let ops = vec![
            EditOp::MoveFrames {
                moves: vec![FrameMove {
                    index: 1,
                    x: 0.0,
                    y: 0.0,
                }],
            },
            EditOp::SetButtons {
                sets: vec![ButtonSet { index: 1, buttons: 5 }],
            },
            EditOp::DeleteFrames { indices: vec![1] },
        ];
        assert!(translate_ops(&ops).is_ok());
    }

    #[test]
    fn timestamp_ticks_parse_or_reject() {
        let ops = vec![EditOp::SetTimestamp {
            ticks: "638712000000000001".into(),
        }];
        assert!(matches!(
            translate_ops(&ops).unwrap()[0],
            EditMember::SetTimestamp {
                ticks: 638_712_000_000_000_001
            }
        ));
        let ops = vec![EditOp::SetTimestamp {
            ticks: "not-a-number".into(),
        }];
        assert!(matches!(translate_ops(&ops), Err(IpcError::InvalidEdit { .. })));
    }

    #[test]
    fn frame_changes_respects_the_full_frames_threshold() {
        let frames: Vec<ReplayFrame> = (0..30).map(|i| frame(i as f64 * 16.0)).collect();
        let small = BatchApplied {
            updated: vec![0, 1],
            ..Default::default()
        };
        assert!(matches!(
            frame_changes(&small, &frames),
            Some(FrameChanges::Delta { .. })
        ));
        // 7 of 30 touched crosses 20%
        let large = BatchApplied {
            updated: (0..7).collect(),
            ..Default::default()
        };
        assert!(matches!(
            frame_changes(&large, &frames),
            Some(FrameChanges::Full { .. })
        ));
        let replace = BatchApplied {
            full_replace: true,
            ..Default::default()
        };
        assert!(matches!(
            frame_changes(&replace, &frames),
            Some(FrameChanges::Full { .. })
        ));
        let nothing = BatchApplied::default();
        assert!(frame_changes(&nothing, &frames).is_none());
    }

    #[test]
    fn frame_changes_serialize_in_the_wire_shape() {
        let frames: Vec<ReplayFrame> = (0..30).map(|i| frame(i as f64)).collect();
        let report = BatchApplied {
            updated: vec![3],
            inserted: vec![5],
            removed: vec![9],
            ..Default::default()
        };
        let v = serde_json::to_value(frame_changes(&report, &frames).unwrap()).unwrap();
        assert_eq!(v["updated"][0]["index"], 3);
        assert_eq!(v["updated"][0]["frame"]["time"], 3.0);
        assert_eq!(v["inserted"][0]["index"], 5);
        assert_eq!(v["removed"][0], 9);
        let v = serde_json::to_value(full_frames(&frames[..2])).unwrap();
        assert_eq!(v["fullFrames"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn ops_touch_frames_ignores_metadata() {
        assert!(!ops_touch_frames(&[EditOp::SetPlayerName { name: None }]));
        assert!(ops_touch_frames(&[
            EditOp::SetPlayerName { name: None },
            EditOp::DeleteFrames { indices: vec![0] }
        ]));
    }

    #[test]
    fn edit_delta_serializes_with_the_frozen_wire_field_names() {
        let delta = EditDelta {
            revision: 1,
            frames: Some(FrameChanges::Delta {
                updated: vec![IndexedFrame {
                    index: 0,
                    frame: FrameDto {
                        time: 0.0,
                        x: 0.0,
                        y: 0.0,
                        buttons: 0,
                    },
                }],
                inserted: Vec::new(),
                removed: Vec::new(),
            }),
            player_name: Some("player".into()),
            timestamp_ticks: "638712000000000001".into(),
            dirty: true,
            frames_dirty: true,
            metadata_dirty: false,
            can_undo: true,
            can_redo: false,
            history: HistoryDto {
                labels: vec!["move".into()],
                cursor: 1,
            },
            simulation: None,
        };
        let v = serde_json::to_value(&delta).unwrap();
        let fields: std::collections::HashSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(
            fields,
            [
                "revision",
                "frames",
                "playerName",
                "timestampTicks",
                "dirty",
                "framesDirty",
                "metadataDirty",
                "canUndo",
                "canRedo",
                "history",
                "simulation",
            ]
            .into_iter()
            .collect()
        );
        let history_fields: std::collections::HashSet<&str> = v["history"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(history_fields, ["labels", "cursor"].into_iter().collect());
    }
}
