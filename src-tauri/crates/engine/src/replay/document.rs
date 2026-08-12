//! the editable replay document. holds the decoded file plus its converted
//! playback frames, applies mutations through an invertible-op undo/redo
//! stack, and keys export on its own dirty split: pristine -> verbatim
//! payload + trailer passthrough; metadata-only dirty -> the frame payload
//! carried verbatim under the edited header; frames dirty -> reserialize
//! with caller-supplied derived fields overlaid. every dirty export --
//! carried included -- recomputes the replay hash, writes the life bar
//! empty, and strips the unparsed lazer trailer.
//!
//! derived header fields (hit counts, max combo, total score) are not
//! editable here: the tauri layer regenerates them from the recomputed
//! judgement timeline via `score::derive_score` and passes the narrowed
//! result to [`ReplayDocument::export_with_derived`]

use crate::error::{resource_limit, EngineError, Result};
use crate::formats::beatmap::EARLY_VERSION_TIMING_OFFSET;
use crate::formats::osr::{
    encode_osr, EncodeOptions, OsrFile, OsrHeader, PayloadSource, ReplayAction, MAX_COORDINATE_VALUE,
    SEED_FRAME_DELTA,
};
use crate::limits;
use crate::math::Vec2;
use crate::replay::frames::{convert_frames, Buttons, ReplayFrame};
use crate::score::{replay_hash, DerivedFields};

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

fn validate_frame_time(time: f64) -> Result<()> {
    if !time.is_finite() || time.fract() != 0.0 {
        return Err(EngineError::InvalidArgument(format!(
            "frame time must be an integral millisecond count, got {time}"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone)]
enum Op {
    MoveFrame {
        index: usize,
        from: Vec2,
        to: Vec2,
    },
    SetButtons {
        index: usize,
        from: Buttons,
        to: Buttons,
    },
    InsertFrame {
        index: usize,
        frame: ReplayFrame,
    },
    DeleteFrame {
        index: usize,
        frame: ReplayFrame,
    },
    SetPlayerName {
        from: Option<String>,
        to: Option<String>,
    },
    SetTimestamp {
        from: i64,
        to: i64,
    },
    Restore {
        frames: Vec<ReplayFrame>,
        player_name: Option<String>,
        timestamp_ticks: i64,
    },
    Batch(Vec<Op>),
}

/// which dirtiness kinds an op on the undo stack contributes to
fn op_kinds(op: &Op) -> (bool, bool) {
    match op {
        Op::MoveFrame { .. } | Op::SetButtons { .. } | Op::InsertFrame { .. } | Op::DeleteFrame { .. } => {
            (true, false)
        }
        Op::SetPlayerName { .. } | Op::SetTimestamp { .. } => (false, true),
        Op::Restore { .. } => (true, true),
        Op::Batch(ops) => ops.iter().fold((false, false), |acc, op| {
            let (f, m) = op_kinds(op);
            (acc.0 || f, acc.1 || m)
        }),
    }
}

/// members an op retains on the history stack -- the unit the retention
/// budget counts, since entry count alone admits unbounded memory: a batch
/// weighs its member total and a restore snapshot its frame count, the
/// payloads that make those entries heavy
fn op_members(op: &Op) -> usize {
    match op {
        Op::Batch(ops) => ops.iter().map(op_members).sum(),
        Op::Restore { frames, .. } => frames.len().max(1),
        _ => 1,
    }
}

/// one member of an edit batch -- the public counterpart of the private op,
/// carrying intent (no captured from-values; those are read at application)
#[derive(Debug, Clone)]
pub enum EditMember {
    MoveFrame { index: usize, to: Vec2 },
    SetButtons { index: usize, buttons: Buttons },
    InsertFrame { frame: ReplayFrame },
    DeleteFrame { index: usize },
    SetPlayerName { name: Option<String> },
    SetTimestamp { ticks: i64 },
}

/// what an applied op changed, in the wire delta's fixed coordinate spaces:
/// `removed` holds pre-op indices, `inserted` and `updated` post-op indices,
/// all ascending
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BatchApplied {
    pub updated: Vec<usize>,
    pub removed: Vec<usize>,
    pub inserted: Vec<usize>,
    pub full_replace: bool,
}

/// accumulates change indices while ops apply. application-moment indices
/// are directly usable for deletes (pre space) and inserts (post space) in
/// both batch shapes this document produces; content updates recorded before
/// any structural member are pre-space and normalized at finalize, updates
/// recorded after all structural members are already post-space. mixed
/// shapes are not produced anywhere and are debug-asserted against
#[derive(Default)]
struct ChangeRecorder {
    updated_pre: Vec<usize>,
    updated_post: Vec<usize>,
    removed_pre: Vec<usize>,
    inserted_post: Vec<usize>,
    structure_applied: bool,
    full_replace: bool,
}

impl ChangeRecorder {
    fn record_update(&mut self, index: usize) {
        if self.structure_applied {
            self.updated_post.push(index);
        } else {
            self.updated_pre.push(index);
        }
    }

    fn record_delete(&mut self, index: usize) {
        self.removed_pre.push(index);
        self.structure_applied = true;
    }

    fn record_insert(&mut self, index: usize) {
        self.inserted_post.push(index);
        self.structure_applied = true;
    }

    fn finalize(mut self) -> BatchApplied {
        debug_assert!(
            self.updated_pre.is_empty() || self.updated_post.is_empty(),
            "a batch must keep updates all-before or all-after structural members"
        );
        self.removed_pre.sort_unstable();
        self.inserted_post.sort_unstable();
        self.updated_pre.sort_unstable();
        // removal dominates: a frame the same batch deleted emits no update
        self.updated_pre
            .retain(|i| self.removed_pre.binary_search(i).is_err());
        let mut updated = to_post_indices(&self.updated_pre, &self.removed_pre, &self.inserted_post);
        updated.extend(self.updated_post);
        updated.sort_unstable();
        updated.dedup();
        BatchApplied {
            updated,
            removed: self.removed_pre,
            inserted: self.inserted_post,
            full_replace: self.full_replace,
        }
    }
}

/// maps ascending pre-batch indices to post-batch positions: shift down past
/// removals below, then up past insertions landing at or below the running
/// position. both walks are two-pointer over the ascending inputs
fn to_post_indices(pre: &[usize], removed_pre: &[usize], inserted_post: &[usize]) -> Vec<usize> {
    let mut out = Vec::with_capacity(pre.len());
    let mut removed_iter = removed_pre.iter().peekable();
    let mut removed_below = 0usize;
    let mut insert_iter = inserted_post.iter().peekable();
    let mut inserts_below = 0usize;
    for &p in pre {
        while removed_iter.peek().is_some_and(|&&r| r < p) {
            removed_below += 1;
            removed_iter.next();
        }
        let intermediate = p - removed_below;
        while insert_iter
            .peek()
            .is_some_and(|&&i| i <= intermediate + inserts_below)
        {
            inserts_below += 1;
            insert_iter.next();
        }
        out.push(intermediate + inserts_below);
    }
    out
}

#[derive(Debug)]
pub struct ReplayDocument {
    file: OsrFile,
    beatmap_format_version: i32,
    frames: Vec<ReplayFrame>,
    /// the header as decoded, retained so revert_all can restore the fields
    /// metadata edits mutate in place
    baseline_header: OsrHeader,
    undo_stack: Vec<Op>,
    redo_stack: Vec<Op>,
    undo_frame_ops: usize,
    undo_meta_ops: usize,
    evicted_frames: bool,
    evicted_meta: bool,
    /// members currently retained across `undo_stack`'s entries -- what the
    /// retention budget bounds
    retained_members: usize,
    /// normally `limits::MAX_UNDO_RETAINED_MEMBERS`; a field so its boundary
    /// tests can drive it with small numbers
    retention_budget: usize,
    /// what the most recent mutation's push displaced -- kept until the next
    /// stack movement so `rollback_last` can reverse the whole mutation
    rollback_checkpoint: Option<RollbackCheckpoint>,
}

/// what a mutation's push displaced, retained so `rollback_last` can fully
/// reverse it: the entries evicted past the caps (oldest first, with the
/// eviction flags as they stood before latching) and the redo stack the
/// push cleared
#[derive(Debug)]
struct RollbackCheckpoint {
    evicted: Vec<Op>,
    evicted_frames_before: bool,
    evicted_meta_before: bool,
    redo_stack: Vec<Op>,
}

impl ReplayDocument {
    pub fn new(file: OsrFile, beatmap_format_version: i32) -> ReplayDocument {
        let frames = convert_frames(&file.actions, beatmap_format_version);
        let baseline_header = file.header.clone();
        ReplayDocument {
            file,
            beatmap_format_version,
            frames,
            baseline_header,
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            undo_frame_ops: 0,
            undo_meta_ops: 0,
            evicted_frames: false,
            evicted_meta: false,
            retained_members: 0,
            retention_budget: limits::MAX_UNDO_RETAINED_MEMBERS,
            rollback_checkpoint: None,
        }
    }

    pub fn frames(&self) -> &[ReplayFrame] {
        &self.frames
    }

    pub fn header(&self) -> &OsrHeader {
        &self.file.header
    }

    /// whether the frame stream differs from the pristine baseline, as far
    /// as the op history can prove: any frame-touching op on the undo stack,
    /// or one that was evicted past recovery. two mutually-cancelling edits
    /// read dirty -- the same false positive the single bit always had
    pub fn frames_dirty(&self) -> bool {
        self.undo_frame_ops > 0 || self.evicted_frames
    }

    pub fn metadata_dirty(&self) -> bool {
        self.undo_meta_ops > 0 || self.evicted_meta
    }

    /// keys export's pristine-passthrough vs. reserialize choice: verbatim
    /// payload + trailer passthrough while pristine, frame reserialize with
    /// the trailer stripped once dirty (spec's round-trip rules)
    pub fn dirty(&self) -> bool {
        self.frames_dirty() || self.metadata_dirty()
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
        self.perform(Op::SetButtons {
            index,
            from,
            to: buttons,
        });
        Ok(())
    }

    pub fn insert_frame(&mut self, frame: ReplayFrame) -> Result<usize> {
        validate_frame_time(frame.time)?;
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

    pub fn undo(&mut self) -> Option<BatchApplied> {
        let op = self.pop_undo()?;
        let mut rec = ChangeRecorder::default();
        let inverse = self.apply(op, &mut rec);
        self.redo_stack.push(inverse);
        Some(rec.finalize())
    }

    pub fn redo(&mut self) -> Option<BatchApplied> {
        let op = self.redo_stack.pop()?;
        let mut rec = ChangeRecorder::default();
        let inverse = self.apply(op, &mut rec);
        // a redo push can never evict: the preceding undo left both the
        // depth and the retained members below what already fit
        let _ = self.push_undo(inverse);
        self.rollback_checkpoint = None;
        Some(rec.finalize())
    }

    /// restores the pristine baseline directly from the retained original --
    /// frames recomputed from the untouched action list, header fields from
    /// the construction-time clone -- as one undoable step. None when the
    /// document already sits at the baseline
    pub fn revert_all(&mut self) -> Option<BatchApplied> {
        let baseline_frames = convert_frames(&self.file.actions, self.beatmap_format_version);
        let at_baseline = self.frames == baseline_frames
            && self.file.header.player_name == self.baseline_header.player_name
            && self.file.header.timestamp_ticks == self.baseline_header.timestamp_ticks;
        if at_baseline {
            return None;
        }
        let mut rec = ChangeRecorder::default();
        let op = Op::Restore {
            frames: baseline_frames,
            player_name: self.baseline_header.player_name.clone(),
            timestamp_ticks: self.baseline_header.timestamp_ticks,
        };
        let inverse = self.apply(op, &mut rec);
        let redo_stack = std::mem::take(&mut self.redo_stack);
        let (evicted, evicted_frames_before, evicted_meta_before) = self.push_undo(inverse);
        self.rollback_checkpoint = Some(RollbackCheckpoint {
            evicted,
            evicted_frames_before,
            evicted_meta_before,
            redo_stack,
        });
        Some(rec.finalize())
    }

    /// publishes the most recent mutation: releases the rollback checkpoint
    /// its push stashed, freeing the displaced entries and the cleared redo
    /// stack. the dual of `rollback_last` -- every mutation a caller may
    /// still roll back ends in exactly one of the two
    pub fn commit_last(&mut self) {
        self.rollback_checkpoint = None;
    }

    /// reverts and discards the most recent undo entry -- the recovery path
    /// for a mutation whose re-simulation failed. everything the push
    /// displaced comes back from the checkpoint: evicted entries rejoin the
    /// stack front, the eviction flags unlatch to their prior values, and
    /// the cleared redo stack is reinstated, so the failed command leaves
    /// the document, history, and dirty markers exactly as it found them
    pub fn rollback_last(&mut self) {
        let checkpoint = self.rollback_checkpoint.take();
        if let Some(op) = self.pop_undo() {
            let mut discard = ChangeRecorder::default();
            self.apply(op, &mut discard);
            if let Some(checkpoint) = checkpoint {
                for op in &checkpoint.evicted {
                    let (ef, em) = op_kinds(op);
                    self.undo_frame_ops += ef as usize;
                    self.undo_meta_ops += em as usize;
                    self.retained_members += op_members(op);
                }
                self.undo_stack.splice(0..0, checkpoint.evicted);
                self.evicted_frames = checkpoint.evicted_frames_before;
                self.evicted_meta = checkpoint.evicted_meta_before;
                self.redo_stack = checkpoint.redo_stack;
            }
        }
    }

    pub fn undo_depth(&self) -> usize {
        self.undo_stack.len()
    }

    pub fn redo_depth(&self) -> usize {
        self.redo_stack.len()
    }

    /// the three-path export, branching on the document's own dirty split.
    ///
    /// - **pristine** -> the original bytes re-emitted identically, trailer
    ///   included; `derived` is ignored entirely.
    /// - **metadata-only dirty** -> the compressed frame payload carried
    ///   verbatim under the edited header, so "frames are untouched" is
    ///   literally true of the bytes; `derived` is ignored (the original
    ///   simulation-derived fields still describe the play).
    /// - **frames dirty** -> the action list reserialized from the edited
    ///   frames with `derived` overlaid onto the header; refusing (typed)
    ///   when `derived` is absent, since a frame-dirty header without
    ///   regenerated fields would describe a different play.
    ///
    /// every dirty export -- carried included -- recomputes the replay hash
    /// from the (possibly edited) player name and timestamp, writes the life
    /// bar empty (never a stale health graph), and strips the unparsed lazer
    /// trailer per the final-state passthrough rule. a revert-all'd document
    /// is content-equal to baseline but marker-dirty, and deliberately takes
    /// this conservative dirty path rather than passthrough
    pub fn export_with_derived(&self, derived: Option<&DerivedFields>) -> Result<Vec<u8>> {
        if !self.dirty() {
            return encode_osr(
                &self.file,
                &EncodeOptions {
                    payload: PayloadSource::VerbatimCompressed,
                    include_trailer: true,
                },
            );
        }

        // the dirty-header overlay shared by both dirty paths: recomputed
        // hash (its inputs include the two editable metadata fields), empty
        // life bar written as lazer writes it (present-empty string,
        // legacyscoreencoder.cs:117/202-206)
        let mut header = self.file.header.clone();
        header.replay_md5 = Some(replay_hash(
            header.player_name.as_deref().unwrap_or(""),
            header.timestamp_ticks,
        )?);
        header.life_graph = Some(String::new());

        if !self.frames_dirty() {
            // carried: the retained compressed payload rides along verbatim
            let carried = OsrFile {
                header,
                actions: Vec::new(),
                compressed_payload: self.file.compressed_payload.clone(),
                decompressed_payload: Vec::new(),
                trailer: Vec::new(),
            };
            return encode_osr(
                &carried,
                &EncodeOptions {
                    payload: PayloadSource::VerbatimCompressed,
                    include_trailer: false,
                },
            );
        }

        let Some(derived) = derived else {
            return Err(EngineError::InvalidArgument(
                "a frame-dirty export requires regenerated derived fields".into(),
            ));
        };
        derived.overlay_onto(&mut header);

        // rebuild the action list from the edited frames. deltas are
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
            header,
            actions,
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer: Vec::new(),
        };
        encode_osr(
            &rebuilt,
            &EncodeOptions {
                payload: PayloadSource::Reserialize,
                include_trailer: false,
            },
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

    /// the sole entry point onto `undo_stack`: keeps the per-kind counters
    /// and the retained-member total in step with what's actually held, and
    /// evicts oldest entries past `MAX_UNDO_DEPTH` or the retention budget,
    /// latching the evicted kind(s) permanently dirty since their ops are no
    /// longer reachable to undo back to pristine. the entry just pushed is
    /// never evicted, so one over-budget step still lands. returns what it
    /// evicted (oldest first) with the flags as they stood before latching,
    /// for callers keeping a rollback checkpoint
    fn push_undo(&mut self, op: Op) -> (Vec<Op>, bool, bool) {
        let (f, m) = op_kinds(&op);
        self.undo_frame_ops += f as usize;
        self.undo_meta_ops += m as usize;
        self.retained_members += op_members(&op);
        self.undo_stack.push(op);
        let (frames_before, meta_before) = (self.evicted_frames, self.evicted_meta);
        let mut evicted = Vec::new();
        while self.undo_stack.len() > 1
            && (self.undo_stack.len() > limits::MAX_UNDO_DEPTH
                || self.retained_members > self.retention_budget)
        {
            let oldest = self.undo_stack.remove(0);
            let (ef, em) = op_kinds(&oldest);
            self.undo_frame_ops -= ef as usize;
            self.undo_meta_ops -= em as usize;
            self.retained_members -= op_members(&oldest);
            self.evicted_frames |= ef;
            self.evicted_meta |= em;
            evicted.push(oldest);
        }
        (evicted, frames_before, meta_before)
    }

    /// the sole entry point off `undo_stack`, keeping the counters in step
    fn pop_undo(&mut self) -> Option<Op> {
        let op = self.undo_stack.pop()?;
        self.rollback_checkpoint = None;
        let (f, m) = op_kinds(&op);
        self.undo_frame_ops -= f as usize;
        self.undo_meta_ops -= m as usize;
        self.retained_members -= op_members(&op);
        Some(op)
    }

    fn perform(&mut self, op: Op) {
        let mut rec = ChangeRecorder::default();
        let inverse = self.apply(op, &mut rec);
        // the single-op setters have no rollback protocol: whatever the push
        // displaced is gone for good, exactly as before
        let _ = self.push_undo(inverse);
        self.rollback_checkpoint = None;
        self.redo_stack.clear();
    }

    /// applies the op, records what it changed, and returns its inverse
    fn apply(&mut self, op: Op, rec: &mut ChangeRecorder) -> Op {
        match op {
            Op::MoveFrame { index, from, to } => {
                self.frames[index].pos = to;
                rec.record_update(index);
                Op::MoveFrame {
                    index,
                    from: to,
                    to: from,
                }
            }
            Op::SetButtons { index, from, to } => {
                self.frames[index].buttons = to;
                rec.record_update(index);
                Op::SetButtons {
                    index,
                    from: to,
                    to: from,
                }
            }
            Op::InsertFrame { index, frame } => {
                self.frames.insert(index, frame);
                rec.record_insert(index);
                Op::DeleteFrame { index, frame }
            }
            Op::DeleteFrame { index, frame } => {
                self.frames.remove(index);
                rec.record_delete(index);
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
            Op::Restore {
                frames,
                player_name,
                timestamp_ticks,
            } => {
                let prev_frames = std::mem::replace(&mut self.frames, frames);
                let prev_name = std::mem::replace(&mut self.file.header.player_name, player_name);
                let prev_ticks = std::mem::replace(&mut self.file.header.timestamp_ticks, timestamp_ticks);
                rec.full_replace = true;
                Op::Restore {
                    frames: prev_frames,
                    player_name: prev_name,
                    timestamp_ticks: prev_ticks,
                }
            }
            Op::Batch(ops) => {
                let mut inverses = Vec::with_capacity(ops.len());
                for op in ops {
                    inverses.push(self.apply(op, rec));
                }
                inverses.reverse();
                Op::Batch(inverses)
            }
        }
    }

    /// applies a mixed member list as one undo step. members apply
    /// sequentially; a validation failure mid-batch rolls the applied prefix
    /// back through its inverses, so the document is never half-edited.
    /// identity members are skipped; `Ok(None)` means every member was one
    /// and nothing was pushed. the cardinality bound is on what the batch
    /// leaves (1..=MAX_REPLAY_FRAMES), so a batch may empty the stream in
    /// transit as long as inserts refill it
    pub fn apply_edit_batch(&mut self, members: Vec<EditMember>) -> Result<Option<BatchApplied>> {
        self.apply_edit_batch_bounded(members, limits::MAX_EDIT_BATCH_MEMBERS, limits::MAX_REPLAY_FRAMES)
    }

    /// both bounds are parameters so their boundary tests can drive them
    /// with small inputs, mirroring simulation's sweep-budget pattern
    fn apply_edit_batch_bounded(
        &mut self,
        members: Vec<EditMember>,
        cap: usize,
        max_frames: usize,
    ) -> Result<Option<BatchApplied>> {
        if members.len() > cap {
            return Err(resource_limit(
                "MAX_EDIT_BATCH_MEMBERS",
                cap as u64,
                members.len() as u64,
            ));
        }

        // distinct deletes make the final-count check exact
        let mut delete_indices: Vec<usize> = members
            .iter()
            .filter_map(|m| match m {
                EditMember::DeleteFrame { index } => Some(*index),
                _ => None,
            })
            .collect();
        delete_indices.sort_unstable();
        if delete_indices.windows(2).any(|w| w[0] == w[1]) {
            return Err(EngineError::InvalidArgument(
                "duplicate delete index in one batch".into(),
            ));
        }
        let inserts = members
            .iter()
            .filter(|m| matches!(m, EditMember::InsertFrame { .. }))
            .count();
        let final_count = (self.frames.len() + inserts).saturating_sub(delete_indices.len());
        if final_count == 0 {
            return Err(EngineError::InvalidArgument(
                "a batch may not leave the frame stream empty".into(),
            ));
        }
        if final_count > max_frames {
            return Err(resource_limit(
                "MAX_REPLAY_FRAMES",
                max_frames as u64,
                final_count as u64,
            ));
        }

        let mut rec = ChangeRecorder::default();
        let mut inverses: Vec<Op> = Vec::new();
        for member in members {
            if let Err(e) = self.apply_member(member, &mut rec, &mut inverses) {
                // roll the applied prefix back so a failed batch leaves the
                // document byte-identical
                let mut discard = ChangeRecorder::default();
                while let Some(inverse) = inverses.pop() {
                    self.apply(inverse, &mut discard);
                }
                return Err(e);
            }
        }
        if inverses.is_empty() {
            return Ok(None);
        }
        inverses.reverse();
        // the redo stack clears as on any new mutation, but into the
        // checkpoint: a failed re-simulation hands it back via rollback_last
        let redo_stack = std::mem::take(&mut self.redo_stack);
        let (evicted, evicted_frames_before, evicted_meta_before) = self.push_undo(Op::Batch(inverses));
        self.rollback_checkpoint = Some(RollbackCheckpoint {
            evicted,
            evicted_frames_before,
            evicted_meta_before,
            redo_stack,
        });
        Ok(Some(rec.finalize()))
    }

    /// validates and applies one member, accumulating its inverse; identity
    /// members apply nothing and accumulate nothing
    fn apply_member(
        &mut self,
        member: EditMember,
        rec: &mut ChangeRecorder,
        inverses: &mut Vec<Op>,
    ) -> Result<()> {
        match member {
            EditMember::MoveFrame { index, to } => {
                let from = self.frame_at(index)?.pos;
                validate_frame_position(to)?;
                if to != from {
                    inverses.push(self.apply(Op::MoveFrame { index, from, to }, rec));
                }
            }
            EditMember::SetButtons { index, buttons } => {
                let from = self.frame_at(index)?.buttons;
                if buttons != from {
                    inverses.push(self.apply(
                        Op::SetButtons {
                            index,
                            from,
                            to: buttons,
                        },
                        rec,
                    ));
                }
            }
            EditMember::InsertFrame { frame } => {
                validate_frame_time(frame.time)?;
                validate_frame_position(frame.pos)?;
                let index = self.frames.partition_point(|f| f.time <= frame.time);
                inverses.push(self.apply(Op::InsertFrame { index, frame }, rec));
            }
            EditMember::DeleteFrame { index } => {
                let frame = *self.frame_at(index)?;
                inverses.push(self.apply(Op::DeleteFrame { index, frame }, rec));
            }
            EditMember::SetPlayerName { name } => {
                if name != self.file.header.player_name {
                    let from = self.file.header.player_name.clone();
                    inverses.push(self.apply(Op::SetPlayerName { from, to: name }, rec));
                }
            }
            EditMember::SetTimestamp { ticks } => {
                if ticks != self.file.header.timestamp_ticks {
                    let from = self.file.header.timestamp_ticks;
                    inverses.push(self.apply(Op::SetTimestamp { from, to: ticks }, rec));
                }
            }
        }
        Ok(())
    }

    pub fn move_frames(&mut self, moves: &[(usize, Vec2)]) -> Result<Option<BatchApplied>> {
        self.apply_edit_batch(
            moves
                .iter()
                .map(|&(index, to)| EditMember::MoveFrame { index, to })
                .collect(),
        )
    }

    pub fn set_buttons_bulk(&mut self, sets: &[(usize, Buttons)]) -> Result<Option<BatchApplied>> {
        self.apply_edit_batch(
            sets.iter()
                .map(|&(index, buttons)| EditMember::SetButtons { index, buttons })
                .collect(),
        )
    }

    /// descending application keeps every pre-batch index valid at its
    /// moment of application without index math
    pub fn delete_frames(&mut self, indices: &[usize]) -> Result<Option<BatchApplied>> {
        let mut sorted = indices.to_vec();
        sorted.sort_unstable_by(|a, b| b.cmp(a));
        self.apply_edit_batch(
            sorted
                .into_iter()
                .map(|index| EditMember::DeleteFrame { index })
                .collect(),
        )
    }

    /// ascending-time application makes every insert's application index its
    /// final post-batch index; the stable sort keeps caller order among
    /// equal times
    pub fn insert_frames(&mut self, frames: Vec<ReplayFrame>) -> Result<Option<BatchApplied>> {
        let mut frames = frames;
        frames.sort_by(|a, b| a.time.total_cmp(&b.time));
        self.apply_edit_batch(
            frames
                .into_iter()
                .map(|frame| EditMember::InsertFrame { frame })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::osr::{
        decode_osr, encode_osr, EncodeOptions, OsrFile, OsrHeader, PayloadSource, ReplayAction,
    };
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
                ReplayAction {
                    delta: 100,
                    x: 10.0,
                    y: 20.0,
                    z: 0,
                },
                ReplayAction {
                    delta: 16,
                    x: 11.0,
                    y: 21.0,
                    z: 1,
                },
                ReplayAction {
                    delta: 16,
                    x: 12.0,
                    y: 22.0,
                    z: 0,
                },
                ReplayAction {
                    delta: -12345,
                    x: 0.0,
                    y: 0.0,
                    z: 987_654,
                },
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
            &EncodeOptions {
                payload: PayloadSource::Reserialize,
                include_trailer: true,
            },
        )
        .unwrap();
        let decoded = decode_osr(&bytes).unwrap();
        (bytes, decoded)
    }

    /// arbitrary regenerated fields for tests that exercise the export
    /// mechanics rather than the derivation (the derivation itself is
    /// covered by score's own tests and the fixture goldens)
    fn derived() -> DerivedFields {
        DerivedFields {
            count_300: 42,
            count_100: 7,
            count_50: 3,
            count_geki: 11,
            count_katsu: 5,
            count_miss: 1,
            max_combo: 99,
            perfect: false,
            total_score: 123_456,
        }
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
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
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
        assert!(doc.undo().is_none());
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn mutation_undo_redo_drive_the_dirty_marker() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);

        doc.move_frame(1, Vec2::new(99.0, 88.0)).unwrap();
        assert!(doc.dirty());
        assert_eq!(doc.frames()[1].pos, Vec2::new(99.0, 88.0));

        assert!(doc.undo().is_some());
        assert!(!doc.dirty());
        assert_eq!(doc.frames()[1].pos, Vec2::new(11.0, 21.0));
        // undone back to the pristine baseline: byte-identical export again
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);

        assert!(doc.redo().is_some());
        assert!(doc.dirty());
        assert_eq!(doc.frames()[1].pos, Vec2::new(99.0, 88.0));
        assert!(doc.redo().is_none());
    }

    #[test]
    fn a_new_mutation_clears_the_redo_stack() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(0, Vec2::new(1.0, 1.0)).unwrap();
        doc.undo();
        doc.set_frame_buttons(0, Buttons::new(Buttons::RIGHT_1)).unwrap();
        assert!(doc.redo().is_none());
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
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
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
        let bad_time = ReplayFrame {
            time: 110.5,
            pos: Vec2::ZERO,
            buttons: Buttons::default(),
        };
        assert!(matches!(
            doc.insert_frame(bad_time),
            Err(EngineError::InvalidArgument(_))
        ));
        let bad_pos = ReplayFrame {
            time: 110.0,
            pos: Vec2::new(f32::NAN, 0.0),
            buttons: Buttons::default(),
        };
        assert!(matches!(
            doc.insert_frame(bad_pos),
            Err(EngineError::InvalidArgument(_))
        ));
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
        assert!(matches!(
            doc.insert_frame(out_of_range),
            Err(EngineError::InvalidArgument(_))
        ));
        assert!(!doc.dirty());

        doc.move_frame(0, Vec2::new(131_072.0, -131_072.0)).unwrap();
        let reopened = decode_osr(&doc.export_with_derived(Some(&derived())).unwrap()).unwrap();
        assert_eq!(reopened.actions[0].x, 131_072.0);
        assert_eq!(reopened.actions[0].y, -131_072.0);
    }

    #[test]
    fn dirty_export_reserializes_frames_and_keeps_the_seed_frame() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(2, Vec2::new(200.0, 210.0)).unwrap();
        let exported = doc.export_with_derived(Some(&derived())).unwrap();

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

        assert!(doc.export_with_derived(None).unwrap().ends_with(&trailer));
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);

        doc.move_frame(0, Vec2::new(1.0, 2.0)).unwrap();
        let exported = doc.export_with_derived(Some(&derived())).unwrap();
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
        assert!(matches!(
            doc.delete_frame(out_of_range),
            Err(EngineError::InvalidArgument(_))
        ));

        // every rejected call left the document exactly as it started
        assert!(!doc.dirty());
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn undo_and_redo_on_a_never_mutated_document_return_false() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        assert!(doc.undo().is_none());
        assert!(doc.redo().is_none());
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
                ReplayAction {
                    delta: i64::MIN + 1,
                    x: 1.0,
                    y: 1.0,
                    z: 0,
                },
                ReplayAction {
                    delta: i64::MAX,
                    x: 2.0,
                    y: 2.0,
                    z: 0,
                },
            ],
        );
        let bytes = encode_osr(
            &extreme,
            &EncodeOptions {
                payload: PayloadSource::Reserialize,
                include_trailer: true,
            },
        )
        .unwrap();
        let decoded = decode_osr(&bytes).unwrap();
        let mut doc = ReplayDocument::new(decoded, 14);
        // a frame edit, so the export takes the regenerating path -- the
        // only one that rebuilds deltas (a metadata edit would carry the
        // payload verbatim and never reach the subtraction)
        doc.move_frame(0, Vec2::new(5.0, 5.0)).unwrap();

        // must not panic (this is the profile the unguarded subtraction
        // panicked in) and must not return an error
        assert!(doc.export_with_derived(Some(&derived())).is_ok());
    }

    #[test]
    fn a_mixed_batch_is_one_undo_step_and_reports_fixed_spaces() {
        // frames from canonical_roundtrip: [t=100, t=116, t=132] at (10,20)/(11,21)/(12,22)
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);

        let report = doc
            .apply_edit_batch(vec![
                EditMember::MoveFrame {
                    index: 0,
                    to: Vec2::new(50.0, 60.0),
                },
                EditMember::SetButtons {
                    index: 2,
                    buttons: Buttons::new(Buttons::RIGHT_1),
                },
                EditMember::DeleteFrame { index: 1 },
                EditMember::InsertFrame {
                    frame: ReplayFrame {
                        time: 105.0,
                        pos: Vec2::new(1.0, 2.0),
                        buttons: Buttons::default(),
                    },
                },
            ])
            .unwrap()
            .unwrap();

        // pre-op: [f0, f1, f2] -> delete 1, insert t=105 after f0
        // post-op: [f0(moved), ins(105), f2(buttons)]
        assert_eq!(report.removed, vec![1]);
        assert_eq!(report.inserted, vec![1]);
        assert_eq!(report.updated, vec![0, 2]);
        assert!(!report.full_replace);
        assert_eq!(doc.frames().len(), 3);
        assert_eq!(doc.frames()[1].time, 105.0);
        assert_eq!(doc.undo_depth(), 1);

        // one undo restores everything the batch did
        assert!(doc.undo().is_some());
        assert_eq!(doc.undo_depth(), 0);
        assert!(!doc.dirty());
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn undo_of_a_batch_reports_in_the_post_undo_spaces() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.apply_edit_batch(vec![
            EditMember::MoveFrame {
                index: 0,
                to: Vec2::new(50.0, 60.0),
            },
            EditMember::DeleteFrame { index: 1 },
            EditMember::InsertFrame {
                frame: ReplayFrame {
                    time: 105.0,
                    pos: Vec2::new(1.0, 2.0),
                    buttons: Buttons::default(),
                },
            },
        ])
        .unwrap()
        .unwrap();

        // post-batch array: [f0(moved), ins(105), f2]; undoing removes the
        // insert (pre-undo index 1), restores f1 (post-undo index 1), and
        // moves f0 back (post-undo index 0)
        let report = doc.undo().unwrap();
        assert_eq!(report.removed, vec![1]);
        assert_eq!(report.inserted, vec![1]);
        assert_eq!(report.updated, vec![0]);
    }

    #[test]
    fn a_failing_member_rolls_back_the_applied_prefix() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let out_of_range = doc.frames().len();

        let err = doc.apply_edit_batch(vec![
            EditMember::MoveFrame {
                index: 0,
                to: Vec2::new(50.0, 60.0),
            },
            EditMember::DeleteFrame { index: out_of_range },
        ]);
        assert!(matches!(err, Err(EngineError::InvalidArgument(_))));

        // the applied move was rolled back: byte-identical, not dirty, no step
        assert!(!doc.dirty());
        assert_eq!(doc.undo_depth(), 0);
        assert!(doc.redo().is_none());
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn an_all_identity_batch_pushes_nothing() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let unchanged_pos = doc.frames()[0].pos;
        let unchanged_buttons = doc.frames()[1].buttons;

        let report = doc
            .apply_edit_batch(vec![
                EditMember::MoveFrame {
                    index: 0,
                    to: unchanged_pos,
                },
                EditMember::SetButtons {
                    index: 1,
                    buttons: unchanged_buttons,
                },
                EditMember::SetPlayerName {
                    name: Some("someone".into()),
                },
            ])
            .unwrap();
        assert!(report.is_none());
        assert!(!doc.dirty());
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn a_batch_may_not_empty_the_stream_but_may_pass_through_empty() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);

        let err = doc.apply_edit_batch(vec![
            EditMember::DeleteFrame { index: 2 },
            EditMember::DeleteFrame { index: 1 },
            EditMember::DeleteFrame { index: 0 },
        ]);
        assert!(matches!(err, Err(EngineError::InvalidArgument(_))));
        assert!(!doc.dirty());

        // deleting everything and inserting a replacement is legal: the
        // cardinality bound is on what the batch leaves, not its transit
        let report = doc.apply_edit_batch(vec![
            EditMember::DeleteFrame { index: 2 },
            EditMember::DeleteFrame { index: 1 },
            EditMember::DeleteFrame { index: 0 },
            EditMember::InsertFrame {
                frame: ReplayFrame {
                    time: 10.0,
                    pos: Vec2::new(0.0, 0.0),
                    buttons: Buttons::default(),
                },
            },
        ]);
        assert!(report.unwrap().is_some());
        assert_eq!(doc.frames().len(), 1);
    }

    #[test]
    fn a_batch_may_not_exceed_the_frame_cap() {
        // the bound is parameterized (like the member cap) so the boundary
        // drives with a small budget instead of four million frames
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let insert = |t: f64| EditMember::InsertFrame {
            frame: ReplayFrame {
                time: t,
                pos: Vec2::new(0.0, 0.0),
                buttons: Buttons::default(),
            },
        };
        // 3 existing frames, max 4: one insert fits exactly
        assert!(doc
            .apply_edit_batch_bounded(vec![insert(500.0)], usize::MAX, 4)
            .is_ok());
        match doc.apply_edit_batch_bounded(vec![insert(600.0)], usize::MAX, 4) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_REPLAY_FRAMES",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn duplicate_delete_indices_are_rejected() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let err = doc.apply_edit_batch(vec![
            EditMember::DeleteFrame { index: 1 },
            EditMember::DeleteFrame { index: 1 },
        ]);
        assert!(matches!(err, Err(EngineError::InvalidArgument(_))));
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn batch_member_cap_boundary() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let at_limit: Vec<EditMember> = (0..3)
            .map(|_| EditMember::SetPlayerName {
                name: Some("x".into()),
            })
            .collect();
        assert!(doc
            .apply_edit_batch_bounded(at_limit, 3, limits::MAX_REPLAY_FRAMES)
            .is_ok());
        let past: Vec<EditMember> = (0..4)
            .map(|_| EditMember::SetPlayerName {
                name: Some("x".into()),
            })
            .collect();
        match doc.apply_edit_batch_bounded(past, 3, limits::MAX_REPLAY_FRAMES) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_EDIT_BATCH_MEMBERS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn equal_time_inserts_keep_their_member_order_after_existing_frames() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        // two inserts at the existing frame 1's exact time (116): both land
        // after it, in member order, distinguishable by their buttons
        let report = doc
            .insert_frames(vec![
                ReplayFrame {
                    time: 116.0,
                    pos: Vec2::new(1.0, 1.0),
                    buttons: Buttons::new(Buttons::LEFT_1),
                },
                ReplayFrame {
                    time: 116.0,
                    pos: Vec2::new(2.0, 2.0),
                    buttons: Buttons::new(Buttons::LEFT_2),
                },
            ])
            .unwrap()
            .unwrap();
        assert_eq!(report.inserted, vec![2, 3]);
        assert_eq!(doc.frames()[2].buttons.raw, Buttons::LEFT_1);
        assert_eq!(doc.frames()[3].buttons.raw, Buttons::LEFT_2);
    }

    #[test]
    fn delete_frames_canonicalizes_unsorted_input() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let report = doc.delete_frames(&[0, 2]).unwrap().unwrap();
        assert_eq!(report.removed, vec![0, 2]);
        assert_eq!(doc.frames().len(), 1);
        assert_eq!(doc.frames()[0].time, 116.0);
    }

    #[test]
    fn single_op_undo_reports_its_target() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(1, Vec2::new(99.0, 88.0)).unwrap();
        let report = doc.undo().unwrap();
        assert_eq!(report.updated, vec![1]);
        assert!(report.removed.is_empty() && report.inserted.is_empty());
        let report = doc.redo().unwrap();
        assert_eq!(report.updated, vec![1]);
    }

    #[test]
    fn dirtiness_splits_by_kind() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);

        doc.set_player_name(Some("renamed".into()));
        assert!(doc.metadata_dirty());
        assert!(!doc.frames_dirty());
        assert!(doc.dirty());

        doc.move_frame(0, Vec2::new(5.0, 5.0)).unwrap();
        assert!(doc.frames_dirty());

        // undoing the move leaves only the metadata edit
        doc.undo();
        assert!(!doc.frames_dirty());
        assert!(doc.metadata_dirty());

        doc.undo();
        assert!(!doc.dirty());
    }

    #[test]
    fn a_mixed_batch_dirties_both_kinds() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.apply_edit_batch(vec![
            EditMember::MoveFrame {
                index: 0,
                to: Vec2::new(5.0, 5.0),
            },
            EditMember::SetPlayerName {
                name: Some("renamed".into()),
            },
        ])
        .unwrap();
        assert!(doc.frames_dirty() && doc.metadata_dirty());
        doc.undo();
        assert!(!doc.dirty());
    }

    #[test]
    fn undo_depth_cap_evicts_the_oldest_and_dirtiness_sticks() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);

        // one more edit than the cap: the first one's op evicts
        for i in 0..=limits::MAX_UNDO_DEPTH {
            doc.move_frame(0, Vec2::new(i as f32 + 1.0, 0.0)).unwrap();
        }
        assert_eq!(doc.undo_depth(), limits::MAX_UNDO_DEPTH);

        // walking the whole remaining stack back cannot reach the baseline:
        // the evicted op is unreachable, so the marker must stay dirty even
        // though the stack is empty
        while doc.undo().is_some() {}
        assert_eq!(doc.undo_depth(), 0);
        assert!(doc.frames_dirty());
        assert!(doc.dirty());
        assert_ne!(doc.export_with_derived(Some(&derived())).unwrap(), bytes);
    }

    #[test]
    fn revert_all_restores_the_baseline_as_one_undoable_step() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let baseline_frames: Vec<ReplayFrame> = doc.frames().to_vec();

        doc.move_frame(0, Vec2::new(5.0, 5.0)).unwrap();
        doc.set_player_name(Some("renamed".into()));
        doc.delete_frame(2).unwrap();

        let report = doc.revert_all().unwrap();
        assert!(report.full_replace);
        assert_eq!(doc.frames(), &baseline_frames[..]);
        assert_eq!(doc.header().player_name.as_deref(), Some("someone"));
        // content equals baseline, but the marker stays conservative: the
        // restore op itself sits on the undo stack
        assert!(doc.dirty());

        // the revert is one undoable step back to the pre-revert state
        let undone = doc.undo().unwrap();
        assert!(undone.full_replace);
        assert_eq!(doc.frames().len(), baseline_frames.len() - 1);
        assert_eq!(doc.header().player_name.as_deref(), Some("renamed"));
    }

    #[test]
    fn revert_all_at_the_baseline_is_an_identity() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        assert!(doc.revert_all().is_none());
        assert!(!doc.dirty());
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);

        // an edit undone back to baseline is also at the baseline
        doc.move_frame(0, Vec2::new(5.0, 5.0)).unwrap();
        doc.undo();
        assert!(doc.revert_all().is_none());
    }

    #[test]
    fn revert_all_recovers_an_evicted_history() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        let baseline_frames: Vec<ReplayFrame> = doc.frames().to_vec();
        for i in 0..=limits::MAX_UNDO_DEPTH {
            doc.move_frame(0, Vec2::new(i as f32 + 1.0, 0.0)).unwrap();
        }
        // undo cannot reach the baseline any more (task 2), revert_all can
        assert!(doc.revert_all().is_some());
        assert_eq!(doc.frames(), &baseline_frames[..]);
    }

    #[test]
    fn rollback_last_discards_the_step_it_reverts() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.apply_edit_batch(vec![EditMember::MoveFrame {
            index: 0,
            to: Vec2::new(5.0, 5.0),
        }])
        .unwrap()
        .unwrap();

        doc.rollback_last();
        assert!(!doc.dirty());
        assert_eq!(doc.undo_depth(), 0);
        assert!(doc.redo().is_none(), "a rolled-back step must not be redoable");
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn commit_last_finalizes_the_eviction_its_push_forced() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        for i in 0..limits::MAX_UNDO_DEPTH {
            doc.move_frame(0, Vec2::new(i as f32 + 1.0, 0.0)).unwrap();
        }
        doc.apply_edit_batch(vec![EditMember::MoveFrame {
            index: 0,
            to: Vec2::new(0.5, 0.5),
        }])
        .unwrap()
        .unwrap();

        // publication releases the checkpoint: the eviction is final, so a
        // later rollback (contractually unreachable, but the checkpoint must
        // not linger) reverts only its own entry and the latch stays
        doc.commit_last();
        doc.rollback_last();
        assert_eq!(doc.undo_depth(), limits::MAX_UNDO_DEPTH - 1);
        while doc.undo().is_some() {}
        assert!(doc.frames_dirty());
    }

    #[test]
    fn undo_history_evicts_by_retained_members_too() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.retention_budget = 4;
        let batch = |x: f32| {
            vec![
                EditMember::MoveFrame {
                    index: 0,
                    to: Vec2::new(x, 0.0),
                },
                EditMember::MoveFrame {
                    index: 1,
                    to: Vec2::new(x, 1.0),
                },
            ]
        };

        doc.apply_edit_batch(batch(1.0)).unwrap().unwrap();
        doc.apply_edit_batch(batch(2.0)).unwrap().unwrap();
        assert_eq!(doc.undo_depth(), 2);

        // the third two-member batch crosses the four-member budget: the
        // oldest entry evicts even though the depth cap is nowhere near
        doc.apply_edit_batch(batch(3.0)).unwrap().unwrap();
        assert_eq!(doc.undo_depth(), 2);
        while doc.undo().is_some() {}
        assert!(doc.frames_dirty(), "the evicted step keeps the marker latched");
    }

    #[test]
    fn the_newest_entry_survives_a_budget_it_alone_exceeds() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.retention_budget = 1;
        doc.apply_edit_batch(vec![
            EditMember::MoveFrame {
                index: 0,
                to: Vec2::new(1.0, 0.0),
            },
            EditMember::MoveFrame {
                index: 1,
                to: Vec2::new(1.0, 1.0),
            },
        ])
        .unwrap()
        .unwrap();
        assert_eq!(doc.undo_depth(), 1);
        assert!(doc.undo().is_some());
        assert!(!doc.dirty());
    }

    #[test]
    fn rollback_last_restores_the_redo_stack_its_push_cleared() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.apply_edit_batch(vec![EditMember::MoveFrame {
            index: 0,
            to: Vec2::new(5.0, 5.0),
        }])
        .unwrap()
        .unwrap();
        doc.undo().unwrap();
        assert_eq!(doc.redo_depth(), 1);

        // a new mutation clears the redo stack as always, but its failure
        // hands the entries back instead of stranding them
        doc.apply_edit_batch(vec![EditMember::MoveFrame {
            index: 1,
            to: Vec2::new(9.0, 9.0),
        }])
        .unwrap()
        .unwrap();
        assert_eq!(doc.redo_depth(), 0);
        doc.rollback_last();
        assert_eq!(doc.redo_depth(), 1);

        let report = doc.redo().unwrap();
        assert_eq!(report.updated, vec![0]);
        assert_eq!(doc.frames()[0].pos, Vec2::new(5.0, 5.0));
    }

    #[test]
    fn rollback_last_reverses_an_eviction_its_push_forced() {
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        for i in 0..limits::MAX_UNDO_DEPTH {
            doc.move_frame(0, Vec2::new(i as f32 + 1.0, 0.0)).unwrap();
        }

        // the batch push at the cap evicts the oldest entry; rolling the
        // failed mutation back must reverse the eviction too, or the command
        // permanently loses an undo step and latches the dirty marker. the
        // mutation goes through apply_edit_batch -- the checkpointed path
        // the commands actually roll back; the single-op setters keep none
        doc.apply_edit_batch(vec![EditMember::MoveFrame {
            index: 0,
            to: Vec2::new(0.5, 0.5),
        }])
        .unwrap()
        .unwrap();
        doc.rollback_last();
        assert_eq!(doc.undo_depth(), limits::MAX_UNDO_DEPTH);

        // the restored history still walks all the way back to pristine
        while doc.undo().is_some() {}
        assert!(!doc.dirty());
        assert_eq!(doc.export_with_derived(None).unwrap(), bytes);
    }

    #[test]
    fn a_carried_export_reuses_the_compressed_payload_byte_range_verbatim() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let payload = decoded.compressed_payload.clone();
        assert!(!payload.is_empty());
        let mut doc = ReplayDocument::new(decoded, 14);

        doc.set_player_name(Some("renamed".into()));
        assert!(doc.metadata_dirty() && !doc.frames_dirty());
        let exported = doc.export_with_derived(None).unwrap();

        // the source's compressed payload appears as a contiguous byte range
        // of the output -- carried, not re-compressed
        assert!(
            exported.windows(payload.len()).any(|w| w == payload.as_slice()),
            "the verbatim compressed payload must appear in the carried export"
        );

        let re = decode_osr(&exported).unwrap();
        assert_eq!(re.compressed_payload, payload);
        assert_eq!(re.header.player_name.as_deref(), Some("renamed"));
        // the original simulation-derived fields still describe the play
        assert_eq!(re.header.count_300, 10);
        assert_eq!(re.header.total_score, 123_456);
        // and the frames decode to the same motion the source carried
        assert_eq!(re.actions.len(), 4);
        assert_eq!(re.actions[1].x, 11.0);
    }

    #[test]
    fn every_dirty_export_recomputes_the_hash_and_empties_the_life_bar() {
        // carried: hash covers the edited name and the untouched ticks
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.set_player_name(Some("renamed".into()));
        let re = decode_osr(&doc.export_with_derived(None).unwrap()).unwrap();
        assert_eq!(
            re.header.replay_md5.as_deref(),
            Some(crate::score::replay_hash("renamed", 638_712_000_000_000_000).unwrap().as_str())
        );
        assert_eq!(re.header.life_graph.as_deref(), Some(""));

        // regenerating: same overlay on the frame-dirty path
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(0, Vec2::new(1.0, 2.0)).unwrap();
        let re = decode_osr(&doc.export_with_derived(Some(&derived())).unwrap()).unwrap();
        assert_eq!(
            re.header.replay_md5.as_deref(),
            Some(crate::score::replay_hash("someone", 638_712_000_000_000_000).unwrap().as_str())
        );
        assert_eq!(re.header.life_graph.as_deref(), Some(""));
    }

    #[test]
    fn a_carried_export_strips_the_lazer_trailer() {
        let trailer = vec![0x04, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef];
        let (_, decoded) = canonical_roundtrip(30000001, trailer);
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.set_timestamp_ticks(638_000_000_000_000_000);
        let re = decode_osr(&doc.export_with_derived(None).unwrap()).unwrap();
        // the framed empty score-info array replaces the stripped blob
        assert_eq!(re.trailer, 0i32.to_le_bytes());
    }

    #[test]
    fn a_regenerating_export_overlays_the_derived_fields() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(0, Vec2::new(1.0, 2.0)).unwrap();

        let fields = derived();
        let re = decode_osr(&doc.export_with_derived(Some(&fields)).unwrap()).unwrap();
        assert_eq!(re.header.count_300, fields.count_300);
        assert_eq!(re.header.count_100, fields.count_100);
        assert_eq!(re.header.count_50, fields.count_50);
        assert_eq!(re.header.count_geki, fields.count_geki);
        assert_eq!(re.header.count_katsu, fields.count_katsu);
        assert_eq!(re.header.count_miss, fields.count_miss);
        assert_eq!(re.header.max_combo, fields.max_combo);
        assert_eq!(re.header.perfect, fields.perfect);
        assert_eq!(re.header.total_score, fields.total_score);
    }

    #[test]
    fn a_frame_dirty_export_without_derived_fields_fails_typed() {
        let (_, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.move_frame(0, Vec2::new(1.0, 2.0)).unwrap();
        assert!(matches!(
            doc.export_with_derived(None),
            Err(EngineError::InvalidArgument(_))
        ));
    }

    #[test]
    fn a_reverted_document_exports_through_the_regenerating_path() {
        // TODO.md's revert-all corner: content-equal to baseline but
        // marker-dirty on both kinds, so export deliberately reserializes
        // (hash recomputed, life bar emptied, trailer stripped) instead of
        // passing the original bytes through
        let (bytes, decoded) = canonical_roundtrip(20240101, Vec::new());
        let mut doc = ReplayDocument::new(decoded, 14);
        doc.set_player_name(Some("renamed".into()));
        doc.revert_all().unwrap();
        assert!(doc.frames_dirty() && doc.metadata_dirty());

        // the marker-dirty document refuses a derived-free export like any
        // frame-dirty one
        assert!(doc.export_with_derived(None).is_err());

        let exported = doc.export_with_derived(Some(&derived())).unwrap();
        assert_ne!(exported, bytes, "revert-all must not silently passthrough");
        let re = decode_osr(&exported).unwrap();
        // baseline content under a conservative dirty header
        assert_eq!(re.header.player_name.as_deref(), Some("someone"));
        assert_eq!(re.header.life_graph.as_deref(), Some(""));
        assert_eq!(re.actions.len(), 4);
    }
}
