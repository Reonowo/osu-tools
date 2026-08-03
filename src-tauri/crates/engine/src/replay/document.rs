//! the editable replay document. holds the decoded file plus its converted
//! playback frames, applies mutations through an invertible-op undo/redo
//! stack, and keys export on the dirty marker per the spec's round-trip
//! rules: pristine -> verbatim payload + trailer passthrough; dirty ->
//! reserialize frames, strip the unparsed lazer trailer.
//!
//! derived header fields (hit counts, max combo, total score) are not
//! editable here: the tauri layer regenerates them from the recomputed
//! judgement timeline at export (spec, tauri commands section) and refuses
//! derived-field export while that derivation is unavailable

use crate::error::{EngineError, Result};
use crate::formats::osr::{
    encode_osr, EncodeOptions, OsrFile, OsrHeader, PayloadSource, ReplayAction,
    MAX_COORDINATE_VALUE, SEED_FRAME_DELTA,
};
use crate::formats::beatmap::EARLY_VERSION_TIMING_OFFSET;
use crate::math::Vec2;
use crate::replay::frames::{convert_frames, Buttons, ReplayFrame};

/// a finite position can still be un-exportable: `formats::osr`'s decoder
/// (mirroring lazer's `Parsing.ParseFloat`) rejects coordinates outside
/// +-131,072, so accepting one here would let a successful edit produce an
/// `.osr` that neither this crate nor lazer can reopen
fn validate_frame_position(pos: Vec2) -> Result<()> {
    if !pos.x.is_finite() || !pos.y.is_finite() {
        return Err(EngineError::InvalidArgument(format!(
            "frame position must be finite, got ({}, {})",
            pos.x, pos.y
        )));
    }
    if pos.x.abs() > MAX_COORDINATE_VALUE || pos.y.abs() > MAX_COORDINATE_VALUE {
        return Err(EngineError::InvalidArgument(format!(
            "frame position must stay within +-{MAX_COORDINATE_VALUE} (the .osr coordinate range), got ({}, {})",
            pos.x, pos.y
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
enum Op {
    MoveFrame { index: usize, from: Vec2, to: Vec2 },
    SetButtons { index: usize, from: Buttons, to: Buttons },
    InsertFrame { index: usize, frame: ReplayFrame },
    DeleteFrame { index: usize, frame: ReplayFrame },
    SetPlayerName { from: Option<String>, to: Option<String> },
    SetTimestamp { from: i64, to: i64 },
}

#[derive(Debug)]
pub struct ReplayDocument {
    file: OsrFile,
    beatmap_format_version: i32,
    frames: Vec<ReplayFrame>,
    undo_stack: Vec<Op>,
    redo_stack: Vec<Op>,
}

impl ReplayDocument {
    pub fn new(file: OsrFile, beatmap_format_version: i32) -> ReplayDocument {
        let frames = convert_frames(&file.actions, beatmap_format_version);
        ReplayDocument {
            file,
            beatmap_format_version,
            frames,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
        }
    }

    pub fn frames(&self) -> &[ReplayFrame] {
        &self.frames
    }

    pub fn header(&self) -> &OsrHeader {
        &self.file.header
    }

    /// the undo stack's depth is exactly the op distance from the pristine
    /// baseline, so emptiness is the dirty test (undoing back to the baseline
    /// empties it; redo refills it)
    pub fn dirty(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    // the setters skip identity edits outright: performing one would push a
    // do-nothing op, marking a byte-identical document dirty and costing its
    // export the pristine passthrough (verbatim payload + trailer)

    pub fn move_frame(&mut self, index: usize, to: Vec2) -> Result<()> {
        let from = self.frame_at(index)?.pos;
        validate_frame_position(to)?;
        if to == from {
            return Ok(());
        }
        self.perform(Op::MoveFrame { index, from, to });
        Ok(())
    }

    pub fn set_frame_buttons(&mut self, index: usize, buttons: Buttons) -> Result<()> {
        let from = self.frame_at(index)?.buttons;
        if buttons == from {
            return Ok(());
        }
        self.perform(Op::SetButtons { index, from, to: buttons });
        Ok(())
    }

    pub fn insert_frame(&mut self, frame: ReplayFrame) -> Result<usize> {
        if !frame.time.is_finite() || frame.time.fract() != 0.0 {
            return Err(EngineError::InvalidArgument(format!(
                "frame time must be an integral millisecond count, got {}",
                frame.time
            )));
        }
        validate_frame_position(frame.pos)?;
        let index = self.frames.partition_point(|f| f.time <= frame.time);
        self.perform(Op::InsertFrame { index, frame });
        Ok(index)
    }

    pub fn delete_frame(&mut self, index: usize) -> Result<()> {
        let frame = *self.frame_at(index)?;
        self.perform(Op::DeleteFrame { index, frame });
        Ok(())
    }

    pub fn set_player_name(&mut self, name: Option<String>) {
        if name == self.file.header.player_name {
            return;
        }
        let from = self.file.header.player_name.clone();
        self.perform(Op::SetPlayerName { from, to: name });
    }

    pub fn set_timestamp_ticks(&mut self, ticks: i64) {
        if ticks == self.file.header.timestamp_ticks {
            return;
        }
        let from = self.file.header.timestamp_ticks;
        self.perform(Op::SetTimestamp { from, to: ticks });
    }

    pub fn undo(&mut self) -> bool {
        match self.undo_stack.pop() {
            Some(op) => {
                let inverse = self.apply(op);
                self.redo_stack.push(inverse);
                true
            }
            None => false,
        }
    }

    pub fn redo(&mut self) -> bool {
        match self.redo_stack.pop() {
            Some(op) => {
                let inverse = self.apply(op);
                self.undo_stack.push(inverse);
                true
            }
            None => false,
        }
    }

    pub fn export(&self) -> Result<Vec<u8>> {
        if !self.dirty() {
            return encode_osr(
                &self.file,
                &EncodeOptions { payload: PayloadSource::VerbatimCompressed, include_trailer: true },
            );
        }

        // dirty: rebuild the action list from the edited frames. deltas are
        // exact because frame times are integral by construction (conversion
        // sums integer deltas; insert_frame enforces integral times). frames
        // the conversion dropped (intro frames, backwards-time frames) do not
        // reappear -- lazer's own re-encode drops them identically, since
        // legacyscoreencoder serializes the converted frame list
        let base_time: i64 = if self.beatmap_format_version < 5 {
            EARLY_VERSION_TIMING_OFFSET as i64
        } else {
            0
        };
        let mut actions = Vec::with_capacity(self.frames.len() + 1);
        let mut last_time = base_time;
        for frame in &self.frames {
            let time = frame.time as i64;
            actions.push(ReplayAction {
                // frame.time is an f64 that can round-trip to exactly
                // i64::MIN: f64 cannot represent every i64 near the extremes,
                // and the nearest representable double at that end is
                // i64::MIN itself, so `time` here can land there even when
                // convert_frames' own saturating_add never actually
                // saturated to produce it. a plain subtraction against the
                // previous frame's time would then overflow (e.g. `0 -
                // i64::MIN`), so this must use saturating_sub too
                delta: time.saturating_sub(last_time),
                x: frame.pos.x,
                y: frame.pos.y,
                z: frame.buttons.raw as i32,
            });
            last_time = time;
        }
        if let Some(seed) = self
            .file
            .actions
            .iter()
            .last()
            .filter(|a| a.delta == SEED_FRAME_DELTA)
        {
            actions.push(seed.clone());
        }

        let rebuilt = OsrFile {
            header: self.file.header.clone(),
            actions,
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer: Vec::new(),
        };
        encode_osr(
            &rebuilt,
            &EncodeOptions { payload: PayloadSource::Reserialize, include_trailer: false },
        )
    }

    fn frame_at(&self, index: usize) -> Result<&ReplayFrame> {
        self.frames.get(index).ok_or_else(|| {
            EngineError::InvalidArgument(format!(
                "frame index {index} out of range ({} frames)",
                self.frames.len()
            ))
        })
    }

    fn perform(&mut self, op: Op) {
        let inverse = self.apply(op);
        self.undo_stack.push(inverse);
        self.redo_stack.clear();
    }

    /// applies the op and returns its inverse
    fn apply(&mut self, op: Op) -> Op {
        match op {
            Op::MoveFrame { index, from, to } => {
                self.frames[index].pos = to;
                Op::MoveFrame { index, from: to, to: from }
            }
            Op::SetButtons { index, from, to } => {
                self.frames[index].buttons = to;
                Op::SetButtons { index, from: to, to: from }
            }
            Op::InsertFrame { index, frame } => {
                self.frames.insert(index, frame);
                Op::DeleteFrame { index, frame }
            }
            Op::DeleteFrame { index, frame } => {
                self.frames.remove(index);
                Op::InsertFrame { index, frame }
            }
            Op::SetPlayerName { from, to } => {
                self.file.header.player_name = to.clone();
                Op::SetPlayerName { from: to, to: from }
            }
            Op::SetTimestamp { from, to } => {
                self.file.header.timestamp_ticks = to;
                Op::SetTimestamp { from: to, to: from }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::osr::{decode_osr, encode_osr, EncodeOptions, OsrFile, OsrHeader, PayloadSource, ReplayAction};
    use crate::formats::GameMode;
    use crate::math::Vec2;
    use crate::replay::frames::Buttons;

    fn synthetic_file(version: u32, trailer: Vec<u8>) -> OsrFile {
        OsrFile {
            header: OsrHeader {
                mode: GameMode::Osu,
                version,
                beatmap_md5: Some("aabbccddeeff00112233445566778899".into()),
                player_name: Some("someone".into()),
                replay_md5: None,
                count_300: 10,
                count_100: 2,
                count_50: 1,
                count_geki: 0,
                count_katsu: 0,
                count_miss: 1,
                total_score: 123_456,
                max_combo: 42,
                perfect: false,
                mods: 0,
                life_graph: None,
                timestamp_ticks: 638_712_000_000_000_000,
                online_score_id: 0,
            },
            actions: vec![
                ReplayAction { delta: 100, x: 10.0, y: 20.0, z: 0 },
                ReplayAction { delta: 16, x: 11.0, y: 21.0, z: 1 },
                ReplayAction { delta: 16, x: 12.0, y: 22.0, z: 0 },
                ReplayAction { delta: -12345, x: 0.0, y: 0.0, z: 987_654 },
            ],
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer,
        }
    }

    /// canonical bytes for the synthetic file: encode once (reserialize fills
    /// the compressed payload), then decode back so verbatim export has real
    /// payload bytes to pass through
    fn canonical_roundtrip(version: u32, trailer: Vec<u8>) -> (Vec<u8>, OsrFile) {
        let built = synthetic_file(version, trailer);
        let bytes = encode_osr(
            &built,
            &EncodeOptions { payload: PayloadSource::Reserialize, include_trailer: true },
        )
        .unwrap();
        let decoded = decode_osr(&bytes).unwrap();
        (bytes, decoded)
    }

    /// same header shape as `synthetic_file`, but with a caller-supplied action
    /// list -- used for cases that need actions synthetic_file's fixed list
    /// can't express, like the i64-extreme deltas below
    fn file_with_actions(version: u32, actions: Vec<ReplayAction>) -> OsrFile {
        OsrFile {
            header: OsrHeader {
                mode: GameMode::Osu,
                version,
                beatmap_md5: Some("aabbccddeeff00112233445566778899".into()),
                player_name: Some("someone".into()),
                replay_md5: None,
                count_300: 10,
                count_100: 2,
                count_50: 1,
                count_geki: 0,
                count_katsu: 0,
                count_miss: 1,
                total_score: 123_456,
                max_combo: 42,
                perfect: false,
                mods: 0,
                life_graph: None,
                timestamp_ticks: 638_712_000_000_000_000,
                online_score_id: 0,
            },
            actions,
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer: Vec::new(),
        }
    }

    #[test]
    fn pristine_export_reproduces_the_original_bytes() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let doc = ReplayDocument::new(decoded, 14);
        assert!(!doc.dirty());
        assert_eq!(doc.export().unwrap(), bytes);
    }

    #[test]
    fn frames_come_from_the_conversion_pipeline() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let doc = ReplayDocument::new(decoded, 14);
        // three gameplay frames; the seed pseudo-frame is not a frame
        assert_eq!(doc.frames().len(), 3);
        assert_eq!(doc.frames()[1].time, 116.0);
        assert!(doc.frames()[1].buttons.left());
    }

    #[test]
    fn no_op_mutations_keep_the_document_pristine() {
        // a trailer makes the passthrough observable: dirty export strips it
        let (bytes, decoded) = canonical_roundtrip(20240101, vec![9, 9, 9]);
        let mut doc = ReplayDocument::new(decoded, 14);

        let unchanged_pos = doc.frames()[1].pos;
        let unchanged_buttons = doc.frames()[1].buttons;
        doc.move_frame(1, unchanged_pos).unwrap();
        doc.set_frame_buttons(1, unchanged_buttons).unwrap();
        doc.set_player_name(Some("someone".into()));
        doc.set_timestamp_ticks(638_712_000_000_000_000);

        // identity edits push no ops: nothing to undo, still pristine, and
        // export keeps the verbatim payload + trailer passthrough
        assert!(!doc.dirty());
        assert!(!doc.undo());
        assert_eq!(doc.export().unwrap(), bytes);
    }

    #[test]
    fn mutation_undo_redo_drive_the_dirty_marker() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);

        doc.move_frame(1, Vec2::new(99.0, 88.0)).unwrap();
        assert!(doc.dirty());
        assert_eq!(doc.frames()[1].pos, Vec2::new(99.0, 88.0));

        assert!(doc.undo());
        assert!(!doc.dirty());
        assert_eq!(doc.frames()[1].pos, Vec2::new(11.0, 21.0));
        // undone back to the pristine baseline: byte-identical export again
        assert_eq!(doc.export().unwrap(), bytes);

        assert!(doc.redo());
        assert!(doc.dirty());
        assert_eq!(doc.frames()[1].pos, Vec2::new(99.0, 88.0));
        assert!(!doc.redo());
    }

    #[test]
    fn a_new_mutation_clears_the_redo_stack() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(0, Vec2::new(1.0, 1.0)).unwrap();
        doc.undo();
        doc.set_frame_buttons(0, Buttons::new(Buttons::RIGHT_1)).unwrap();
        assert!(!doc.redo());
        assert!(doc.dirty());
    }

    #[test]
    fn metadata_edits_are_undoable_and_dirty() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.set_player_name(Some("edited".into()));
        assert!(doc.dirty());
        assert_eq!(doc.header().player_name.as_deref(), Some("edited"));
        doc.undo();
        assert_eq!(doc.header().player_name.as_deref(), Some("someone"));
        assert_eq!(doc.export().unwrap(), bytes);
    }

    #[test]
    fn insert_and_delete_keep_frames_sorted_and_invert_cleanly() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let idx = doc
            .insert_frame(ReplayFrame {
                time: 110.0,
                pos: Vec2::new(5.0, 5.0),
                buttons: Buttons::default(),
            })
            .unwrap();
        assert_eq!(idx, 1);
        assert_eq!(doc.frames().len(), 4);
        doc.delete_frame(0).unwrap();
        assert_eq!(doc.frames()[0].time, 110.0);
        doc.undo();
        doc.undo();
        assert!(!doc.dirty());
        assert_eq!(doc.frames().len(), 3);
    }

    #[test]
    fn insert_rejects_non_integral_times_and_non_finite_positions() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        // stable's format stores integral frame deltas; a fractional insert
        // would silently corrupt the export
        let bad_time = ReplayFrame { time: 110.5, pos: Vec2::ZERO, buttons: Buttons::default() };
        assert!(matches!(doc.insert_frame(bad_time), Err(EngineError::InvalidArgument(_))));
        let bad_pos = ReplayFrame {
            time: 110.0,
            pos: Vec2::new(f32::NAN, 0.0),
            buttons: Buttons::default(),
        };
        assert!(matches!(doc.insert_frame(bad_pos), Err(EngineError::InvalidArgument(_))));
        assert!(!doc.dirty());
    }

    #[test]
    fn edits_outside_the_osr_coordinate_range_are_rejected() {
        // formats::osr::parse_coordinate rejects |coord| > 131072 on decode,
        // so accepting such an edit would export a replay this crate (and
        // lazer) refuses to reopen; the decoder's bound is inclusive, so
        // exactly 131072 stays editable
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);

        assert!(matches!(
            doc.move_frame(0, Vec2::new(131_073.0, 0.0)),
            Err(EngineError::InvalidArgument(_))
        ));
        let out_of_range = ReplayFrame {
            time: 110.0,
            pos: Vec2::new(0.0, -131_073.0),
            buttons: Buttons::default(),
        };
        assert!(matches!(doc.insert_frame(out_of_range), Err(EngineError::InvalidArgument(_))));
        assert!(!doc.dirty());

        doc.move_frame(0, Vec2::new(131_072.0, -131_072.0)).unwrap();
        let reopened = decode_osr(&doc.export().unwrap()).unwrap();
        assert_eq!(reopened.actions[0].x, 131_072.0);
        assert_eq!(reopened.actions[0].y, -131_072.0);
    }

    #[test]
    fn dirty_export_reserializes_frames_and_keeps_the_seed_frame() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(2, Vec2::new(200.0, 210.0)).unwrap();
        let exported = doc.export().unwrap();

        let re = decode_osr(&exported).unwrap();
        // the edited motion survived
        assert_eq!(re.actions.len(), 4);
        assert_eq!(re.actions[2].x, 200.0);
        // deltas rebuilt from frame times: 100, 16, 16
        assert_eq!(re.actions[0].delta, 100);
        assert_eq!(re.actions[1].delta, 16);
        // the terminal seed pseudo-frame rides along verbatim
        assert_eq!(re.actions[3].delta, -12345);
        assert_eq!(re.actions[3].z, 987_654);
    }

    #[test]
    fn dirty_export_strips_the_lazer_trailer() {
        // spec parity rule 3: passthrough eligibility is final-state. a lazer
        // version file needs the framed empty score-info array in place of the
        // stripped blob (formats::osr::encode_osr handles that framing)
        let trailer = vec![0x04, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef];
        let (bytes, decoded) = canonical_roundtrip(30000001, trailer.clone());
        let mut doc = ReplayDocument::new(decoded, 14);

        assert!(doc.export().unwrap().ends_with(&trailer));
        assert_eq!(doc.export().unwrap(), bytes);

        doc.move_frame(0, Vec2::new(1.0, 2.0)).unwrap();
        let exported = doc.export().unwrap();
        let re = decode_osr(&exported).unwrap();
        assert_eq!(re.trailer, 0i32.to_le_bytes());
    }

    #[test]
    fn out_of_range_index_is_rejected_without_mutating_or_dirtying() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let out_of_range = doc.frames().len();

        assert!(matches!(
            doc.move_frame(out_of_range, Vec2::new(1.0, 2.0)),
            Err(EngineError::InvalidArgument(_))
        ));
        assert!(matches!(
            doc.set_frame_buttons(out_of_range, Buttons::new(Buttons::RIGHT_1)),
            Err(EngineError::InvalidArgument(_))
        ));
        assert!(matches!(doc.delete_frame(out_of_range), Err(EngineError::InvalidArgument(_))));

        // every rejected call left the document exactly as it started
        assert!(!doc.dirty());
        assert_eq!(doc.export().unwrap(), bytes);
    }

    #[test]
    fn undo_and_redo_on_a_never_mutated_document_return_false() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        assert!(!doc.undo());
        assert!(!doc.redo());
        assert!(!doc.dirty());
    }

    #[test]
    fn export_saturates_frame_time_deltas_at_the_i64_extremes() {
        // two individually-valid deltas whose recomputed gap needs an
        // out-of-range subtraction: `i64::MIN + 1` then `i64::MAX` sum
        // exactly to 0 (convert_frames' own saturating_add never actually
        // saturates here), but the first frame's time only round-trips to
        // i64::MIN because f64 cannot represent `i64::MIN + 1` exactly and
        // rounds it to the nearest double, which is i64::MIN itself -- so
        // the two frames land at i64::MIN then 0, and rebuilding the gap
        // between them as a plain subtraction is `0 - i64::MIN`, which
        // overflows i64::MAX by one
        let extreme = file_with_actions(
            20240101,
            vec![
                ReplayAction { delta: i64::MIN + 1, x: 1.0, y: 1.0, z: 0 },
                ReplayAction { delta: i64::MAX, x: 2.0, y: 2.0, z: 0 },
            ],
        );
        let bytes = encode_osr(
            &extreme,
            &EncodeOptions { payload: PayloadSource::Reserialize, include_trailer: true },
        )
        .unwrap();
        let decoded = decode_osr(&bytes).unwrap();
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.set_player_name(Some("edited".into()));

        // must not panic (this is the profile the unguarded subtraction
        // panicked in) and must not return an error
        assert!(doc.export().is_ok());
    }
}
