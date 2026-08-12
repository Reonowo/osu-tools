//! the LoadedScene json contract (spec, tauri layer): everything the
//! frontend needs for one loaded replay, in one payload. engine types cross
//! this boundary as dtos so the engine's internal shapes can evolve without
//! breaking the frontend; the render plan serializes itself (its shape is
//! its contract). the simulation union makes an invalid state
//! unrepresentable: a judgement timeline exists only inside the
//! authoritative arm

use std::path::PathBuf;

use engine::beatmap::difficulty::HitGrade;
use engine::formats::beatmap::Beatmap;
use engine::formats::osr::OsrHeader;
use engine::render_plan::RenderPlan;
use engine::replay::frames::ReplayFrame;
use engine::simulation::score::JudgementKind;
use engine::simulation::{JudgementEvent, JudgementTimeline};
use serde::{Deserialize, Serialize};

use crate::error::Warning;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedScene {
    /// session identity, stamped by install_scene; a plain json number
    /// (install counter, nowhere near 2^53)
    pub epoch: u64,
    pub beatmap: BeatmapMeta,
    pub replay: ReplayMeta,
    pub frames: Vec<FrameDto>,
    pub render_plan: RenderPlan,
    pub simulation: SimulationDto,
    /// absolute path for tauri's convertFileSrc; the command layer has
    /// already allowed it on the asset protocol scope
    pub audio_path: Option<String>,
    pub background_path: Option<String>,
    pub warnings: Vec<Warning>,
    /// the header-vs-simulated comparison, shipped only for pre-lazer
    /// authoritative scenes; always describes the loaded file, never
    /// in-session edits
    pub integrity: Option<IntegrityDto>,
}

/// the integrity report (spec, integrity report section): per-field
/// header-vs-simulated rows, the combo-section cross-check triple, and the
/// life-bar presence note. the replay hash is deliberately excluded --
/// its formula varies across client generations, so a mismatch there would
/// not distinguish tampering from version skew
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityDto {
    pub rows: Vec<IntegrityRowDto>,
    pub cross_check: CrossCheckDto,
    pub life_bar_present: bool,
}

/// one compared field; `perfect` rides as 0/1 so every row shares a shape
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityRowDto {
    pub field: &'static str,
    pub header: u64,
    pub simulated: u64,
    #[serde(rename = "match")]
    pub matches: bool,
}

/// TODO.md's identity stated outright: `sections - (geki + katsu)` is the
/// number of sections the header claims contained a miss. `geki_katsu` reads
/// the header's own fields (the analyst's view of the loaded file), and the
/// implied count is signed so a header claiming more geki+katu than the map
/// has sections reads as the inconsistency it is
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrossCheckDto {
    pub sections: u32,
    pub geki_katsu: u32,
    pub sections_with_miss: i64,
    /// the header's miss count, restated beside the implication it checks
    pub count_miss: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatmapMeta {
    pub title: String,
    pub artist: String,
    pub creator: String,
    pub version: String,
    pub beatmap_id: i32,
    pub beatmap_set_id: i32,
    pub format_version: i32,
    /// plan 4's signed clock needs this before audio zero
    pub audio_lead_in: f64,
    pub circle_size: f32,
    pub approach_rate: f32,
    pub overall_difficulty: f32,
    pub hp_drain_rate: f32,
    pub md5: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayMeta {
    pub player_name: Option<String>,
    pub version: u32,
    pub mods: u32,
    pub count_300: u16,
    pub count_100: u16,
    pub count_50: u16,
    pub count_geki: u16,
    pub count_katsu: u16,
    pub count_miss: u16,
    pub total_score: u32,
    pub max_combo: u16,
    pub perfect: bool,
    /// .net datetime ticks, verbatim from the header; a string because the
    /// value (~6.4e17 for any current date) exceeds json's 2^53 safe-integer
    /// range and would silently round in the webview's JSON.parse
    pub timestamp_ticks: String,
    /// string for the same reason as timestamp_ticks
    pub online_score_id: String,
    pub beatmap_md5: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameDto {
    pub time: f64,
    pub x: f32,
    pub y: f32,
    /// raw button bitfield (left1=1, right1=2, left2=4, right2=8, smoke=16)
    pub buttons: u32,
}

impl FrameDto {
    pub fn from_frame(f: &ReplayFrame) -> FrameDto {
        FrameDto {
            time: f.time,
            x: f.pos.x,
            y: f.pos.y,
            buttons: f.buttons.raw,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SimulationDto {
    Authoritative {
        events: Vec<JudgementEventDto>,
        totals: TotalsDto,
    },
    NotSimulated {
        reason: NotSimulatedReason,
    },
}

impl SimulationDto {
    pub fn authoritative(timeline: &JudgementTimeline) -> SimulationDto {
        SimulationDto::Authoritative {
            events: timeline.events.iter().map(JudgementEventDto::from).collect(),
            totals: TotalsDto {
                count_300: timeline.totals.count_300,
                count_100: timeline.totals.count_100,
                count_50: timeline.totals.count_50,
                count_miss: timeline.totals.count_miss,
                max_combo: timeline.totals.max_combo,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotSimulatedReason {
    UnsupportedMods,
    BeatmapMismatch,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotalsDto {
    pub count_300: u32,
    pub count_100: u32,
    pub count_50: u32,
    pub count_miss: u32,
    pub max_combo: u32,
}

/// the answer `export_replay` returns: where the file landed, how big it is,
/// and -- for regenerating exports only -- the nine derived values the
/// written header now claims. passthrough and carried exports ship `None`
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub bytes: u64,
    pub regenerated: Option<RegeneratedDto>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegeneratedDto {
    pub count_300: u16,
    pub count_100: u16,
    pub count_50: u16,
    pub count_geki: u16,
    pub count_katsu: u16,
    pub count_miss: u16,
    pub max_combo: u16,
    pub perfect: bool,
    pub total_score: u32,
}

impl From<&engine::score::DerivedFields> for RegeneratedDto {
    fn from(fields: &engine::score::DerivedFields) -> Self {
        RegeneratedDto {
            count_300: fields.count_300,
            count_100: fields.count_100,
            count_50: fields.count_50,
            count_geki: fields.count_geki,
            count_katsu: fields.count_katsu,
            count_miss: fields.count_miss,
            max_combo: fields.max_combo,
            perfect: fields.perfect,
            total_score: fields.total_score,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JudgementEventDto {
    pub time: f64,
    pub object_index: usize,
    pub kind: JudgementKindDto,
    pub combo_after: u32,
    pub accuracy_after: f64,
}

impl From<&JudgementEvent> for JudgementEventDto {
    fn from(e: &JudgementEvent) -> JudgementEventDto {
        JudgementEventDto {
            time: e.time,
            object_index: e.object_index,
            kind: JudgementKindDto::from(&e.kind),
            combo_after: e.combo_after,
            accuracy_after: e.accuracy_after,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum JudgementKindDto {
    Circle { grade: GradeDto },
    SliderHead { hit: bool },
    SliderTick { hit: bool },
    SliderRepeat { hit: bool },
    SliderTail { hit: bool },
    SliderAggregate { grade: GradeDto },
    SpinnerSpin,
    SpinnerBonus,
    SpinnerFinal { grade: GradeDto },
}

impl From<&JudgementKind> for JudgementKindDto {
    fn from(kind: &JudgementKind) -> JudgementKindDto {
        match *kind {
            JudgementKind::Circle(g) => JudgementKindDto::Circle { grade: g.into() },
            JudgementKind::SliderHead { hit } => JudgementKindDto::SliderHead { hit },
            JudgementKind::SliderTick { hit } => JudgementKindDto::SliderTick { hit },
            JudgementKind::SliderRepeat { hit } => JudgementKindDto::SliderRepeat { hit },
            JudgementKind::SliderTail { hit } => JudgementKindDto::SliderTail { hit },
            JudgementKind::SliderAggregate(g) => JudgementKindDto::SliderAggregate { grade: g.into() },
            JudgementKind::SpinnerSpin => JudgementKindDto::SpinnerSpin,
            JudgementKind::SpinnerBonus => JudgementKindDto::SpinnerBonus,
            JudgementKind::SpinnerFinal(g) => JudgementKindDto::SpinnerFinal { grade: g.into() },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GradeDto {
    Great,
    Ok,
    Meh,
    Miss,
}

impl From<HitGrade> for GradeDto {
    fn from(g: HitGrade) -> GradeDto {
        match g {
            HitGrade::Great => GradeDto::Great,
            HitGrade::Ok => GradeDto::Ok,
            HitGrade::Meh => GradeDto::Meh,
            HitGrade::Miss => GradeDto::Miss,
        }
    }
}

impl IntegrityDto {
    /// compares the loaded header against the load-time derivation. the
    /// derivation is the same one export overlays, so the viewer surfaces in
    /// reverse exactly the constraints its own exports satisfy
    pub fn compare(header: &OsrHeader, derived: &engine::score::DerivedScore) -> IntegrityDto {
        let row = |field: &'static str, header: u64, simulated: u64| IntegrityRowDto {
            field,
            header,
            simulated,
            matches: header == simulated,
        };
        let rows = vec![
            row("count300", u64::from(header.count_300), u64::from(derived.count_300)),
            row("count100", u64::from(header.count_100), u64::from(derived.count_100)),
            row("count50", u64::from(header.count_50), u64::from(derived.count_50)),
            row("countGeki", u64::from(header.count_geki), u64::from(derived.count_geki)),
            row(
                "countKatsu",
                u64::from(header.count_katsu),
                u64::from(derived.count_katsu),
            ),
            row("countMiss", u64::from(header.count_miss), u64::from(derived.count_miss)),
            row("maxCombo", u64::from(header.max_combo), u64::from(derived.max_combo)),
            row("perfect", u64::from(header.perfect), u64::from(derived.perfect)),
            row("totalScore", u64::from(header.total_score), derived.total_score),
        ];
        let geki_katsu = u32::from(header.count_geki) + u32::from(header.count_katsu);
        IntegrityDto {
            rows,
            cross_check: CrossCheckDto {
                sections: derived.sections,
                geki_katsu,
                sections_with_miss: i64::from(derived.sections) - i64::from(geki_katsu),
                count_miss: header.count_miss,
            },
            // an empty life graph carries no information either way, so
            // "present" means non-empty
            life_bar_present: header.life_graph.as_deref().is_some_and(|graph| !graph.is_empty()),
        }
    }
}

#[allow(clippy::too_many_arguments)]
pub fn assemble_scene(
    map: &Beatmap,
    map_md5: &str,
    header: &OsrHeader,
    frames: &[ReplayFrame],
    render_plan: RenderPlan,
    simulation: SimulationDto,
    audio_path: Option<PathBuf>,
    background_path: Option<PathBuf>,
    warnings: Vec<Warning>,
    integrity: Option<IntegrityDto>,
) -> LoadedScene {
    LoadedScene {
        epoch: 0,
        beatmap: BeatmapMeta {
            title: map.title.clone(),
            artist: map.artist.clone(),
            creator: map.creator.clone(),
            version: map.version.clone(),
            beatmap_id: map.beatmap_id,
            beatmap_set_id: map.beatmap_set_id,
            format_version: map.format_version,
            audio_lead_in: map.audio_lead_in,
            circle_size: map.circle_size,
            approach_rate: map.approach_rate,
            overall_difficulty: map.overall_difficulty,
            hp_drain_rate: map.hp_drain_rate,
            md5: map_md5.to_string(),
        },
        replay: ReplayMeta {
            player_name: header.player_name.clone(),
            version: header.version,
            mods: header.mods,
            count_300: header.count_300,
            count_100: header.count_100,
            count_50: header.count_50,
            count_geki: header.count_geki,
            count_katsu: header.count_katsu,
            count_miss: header.count_miss,
            total_score: header.total_score,
            max_combo: header.max_combo,
            perfect: header.perfect,
            timestamp_ticks: header.timestamp_ticks.to_string(),
            online_score_id: header.online_score_id.to_string(),
            beatmap_md5: header.beatmap_md5.clone(),
        },
        frames: frames.iter().map(FrameDto::from_frame).collect(),
        render_plan,
        simulation,
        audio_path: audio_path.map(|p| p.to_string_lossy().into_owned()),
        background_path: background_path.map(|p| p.to_string_lossy().into_owned()),
        warnings,
        integrity,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::beatmap::difficulty::HitGrade;
    use engine::simulation::score::JudgementKind;
    use engine::simulation::{HitTotals, JudgementEvent, JudgementTimeline};
    use serde_json::json;

    #[test]
    fn judgement_kinds_serialize_type_tagged() {
        let kind = JudgementKindDto::from(&JudgementKind::Circle(HitGrade::Great));
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "circle", "grade": "great" })
        );

        let kind = JudgementKindDto::from(&JudgementKind::SliderHead { hit: false });
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderHead", "hit": false })
        );

        let kind = JudgementKindDto::from(&JudgementKind::SliderAggregate(HitGrade::Ok));
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "sliderAggregate", "grade": "ok" })
        );

        let kind = JudgementKindDto::from(&JudgementKind::SpinnerBonus);
        assert_eq!(
            serde_json::to_value(&kind).unwrap(),
            json!({ "type": "spinnerBonus" })
        );
    }

    #[test]
    fn the_simulation_union_is_status_tagged() {
        let timeline = JudgementTimeline {
            events: vec![JudgementEvent {
                time: 1030.0,
                object_index: 0,
                kind: JudgementKind::Circle(HitGrade::Meh),
                combo_after: 1,
                accuracy_after: 50.0 / 300.0,
            }],
            totals: HitTotals {
                count_300: 0,
                count_100: 0,
                count_50: 1,
                count_miss: 0,
                max_combo: 1,
            },
        };
        let v = serde_json::to_value(SimulationDto::authoritative(&timeline)).unwrap();
        assert_eq!(v["status"], "authoritative");
        assert_eq!(
            v["totals"],
            json!({ "count300": 0, "count100": 0, "count50": 1, "countMiss": 0, "maxCombo": 1 })
        );
        assert_eq!(v["events"][0]["objectIndex"], 0);
        assert_eq!(v["events"][0]["comboAfter"], 1);
        assert_eq!(v["events"][0]["kind"]["grade"], "meh");

        let v = serde_json::to_value(SimulationDto::NotSimulated {
            reason: NotSimulatedReason::UnsupportedMods,
        })
        .unwrap();
        assert_eq!(
            v,
            json!({ "status": "notSimulated", "reason": "unsupportedMods" })
        );
    }

    #[test]
    fn assembled_scenes_carry_the_full_camel_case_contract() {
        let map = engine::formats::beatmap::decode_beatmap_bytes(
            &std::fs::read(
                crate::testutil::fixtures_dir()
                    .join("beatmaps")
                    .join("stacking-v14.osu"),
            )
            .unwrap(),
        )
        .unwrap();
        let processed = engine::beatmap::process_beatmap(&map).unwrap();
        let render_plan = engine::render_plan::build_render_plan(&map, &processed);
        let mut header = crate::testutil::test_header("abc123", 0);
        // both values sit past 2^53: they must cross as lossless strings
        header.timestamp_ticks = 638_712_000_000_000_001;
        header.online_score_id = u64::MAX;
        let frames = vec![engine::replay::frames::ReplayFrame {
            time: 16.0,
            pos: engine::math::Vec2::new(100.0, 200.0),
            buttons: engine::replay::frames::Buttons::new(1),
        }];

        let scene = assemble_scene(
            &map,
            "abc123",
            &header,
            &frames,
            render_plan,
            SimulationDto::NotSimulated {
                reason: NotSimulatedReason::BeatmapMismatch,
            },
            Some(std::path::PathBuf::from(r"C:\somewhere\audio.mp3")),
            None,
            vec![crate::error::Warning::AudioMissing],
            None,
        );
        let v = serde_json::to_value(&scene).unwrap();

        assert_eq!(v["epoch"], 0);
        assert_eq!(v["beatmap"]["title"], "Stacking Fixture");
        assert_eq!(v["beatmap"]["md5"], "abc123");
        assert_eq!(v["beatmap"]["audioLeadIn"], map.audio_lead_in);
        assert_eq!(v["replay"]["mods"], 0);
        assert_eq!(v["replay"]["playerName"], "test");
        assert_eq!(v["replay"]["timestampTicks"], "638712000000000001");
        assert_eq!(v["replay"]["onlineScoreId"], "18446744073709551615");
        assert_eq!(
            v["frames"][0],
            json!({ "time": 16.0, "x": 100.0, "y": 200.0, "buttons": 1 })
        );
        assert_eq!(v["renderPlan"]["playfield"]["width"], 512.0);
        assert_eq!(v["simulation"]["status"], "notSimulated");
        assert_eq!(v["audioPath"], r"C:\somewhere\audio.mp3");
        assert_eq!(v["backgroundPath"], serde_json::Value::Null);
        assert_eq!(v["warnings"][0]["kind"], "audioMissing");
        assert_eq!(v["integrity"], serde_json::Value::Null);
    }

    #[test]
    fn integrity_reports_serialize_with_the_frozen_wire_field_names() {
        let mut header = crate::testutil::test_header("abc123", 0);
        header.count_geki = 100;
        header.count_katsu = 3;
        header.count_miss = 2;
        header.life_graph = Some("0|1".into());
        let derived = engine::score::DerivedScore {
            count_300: 1,
            count_100: 0,
            count_50: 0,
            count_geki: 99,
            count_katsu: 3,
            count_miss: 2,
            max_combo: 1,
            perfect: true,
            total_score: 300,
            sections: 105,
            sections_with_miss: 2,
        };
        let report = IntegrityDto::compare(&header, &derived);
        let v = serde_json::to_value(&report).unwrap();

        let fields: std::collections::HashSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(fields, ["rows", "crossCheck", "lifeBarPresent"].into_iter().collect());

        // rows cover every compared field, in a fixed render order, with the
        // hash deliberately absent
        let row_fields: Vec<&str> = v["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["field"].as_str().unwrap())
            .collect();
        assert_eq!(
            row_fields,
            [
                "count300",
                "count100",
                "count50",
                "countGeki",
                "countKatsu",
                "countMiss",
                "maxCombo",
                "perfect",
                "totalScore",
            ]
        );
        assert_eq!(
            v["rows"][3],
            serde_json::json!({ "field": "countGeki", "header": 100, "simulated": 99, "match": false })
        );
        assert_eq!(v["rows"][0]["match"], true);
        // perfect rides as 0/1 under the shared row shape
        assert_eq!(v["rows"][7]["header"], 1);

        assert_eq!(
            v["crossCheck"],
            serde_json::json!({ "sections": 105, "gekiKatsu": 103, "sectionsWithMiss": 2, "countMiss": 2 })
        );
        assert_eq!(v["lifeBarPresent"], true);

        // an empty life graph reads as absent
        header.life_graph = Some(String::new());
        assert!(!IntegrityDto::compare(&header, &derived).life_bar_present);
        header.life_graph = None;
        assert!(!IntegrityDto::compare(&header, &derived).life_bar_present);
    }

    #[test]
    fn export_results_serialize_with_the_frozen_wire_field_names() {
        let result = ExportResult {
            path: r"C:\somewhere\replay (edited).osr".into(),
            bytes: 1234,
            regenerated: Some(RegeneratedDto {
                count_300: 100,
                count_100: 5,
                count_50: 1,
                count_geki: 20,
                count_katsu: 3,
                count_miss: 2,
                max_combo: 250,
                perfect: false,
                total_score: 1_234_567,
            }),
        };
        let v = serde_json::to_value(&result).unwrap();
        let fields: std::collections::HashSet<&str> =
            v.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(fields, ["path", "bytes", "regenerated"].into_iter().collect());
        let regenerated: std::collections::HashSet<&str> = v["regenerated"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            regenerated,
            [
                "count300",
                "count100",
                "count50",
                "countGeki",
                "countKatsu",
                "countMiss",
                "maxCombo",
                "perfect",
                "totalScore",
            ]
            .into_iter()
            .collect()
        );

        let passthrough = ExportResult {
            path: "x".into(),
            bytes: 9,
            regenerated: None,
        };
        assert_eq!(serde_json::to_value(&passthrough).unwrap()["regenerated"], serde_json::Value::Null);
    }
}
