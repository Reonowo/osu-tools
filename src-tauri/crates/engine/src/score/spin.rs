//! every spinner's counted half turns, merged into the judgement stream by
//! the emission position the simulator stamped on each one.
//!
//! shared because both folds over the timeline need the same walk: the HP
//! fold pays a gain per half turn (`health.rs`) and the score curve steps a
//! tick or a bonus per half turn (`scorev1.rs`). the two differ only in what
//! a turn is WORTH and in which turns they skip -- HP skips the first half
//! turn of each disc, the score clamps at the disc's possible half spins --
//! so the merge itself, which is the subtle half, lives here once.

use crate::beatmap::{ProcessedBeatmap, ProcessedKind};
use crate::simulation::JudgementTimeline;

/// one counted half turn of one spinner, placed against the judgement stream
/// by the emission position its increment carries
pub(super) struct SpinTurn {
    /// the index of the judgement event this turn was emitted before
    pub emission_index: usize,
    pub time: f64,
    /// this turn's 1-based ordinal within its OWN spinner
    pub half: i64,
    /// `stable_half_spins_required + 3` for this turn's spinner -- the gate
    /// past which every second half turn is a bonus. carried on the turn so a
    /// consumer never re-fetches the object
    pub gate: i64,
    /// this turn's spinner's `total_half_spins_possible` -- how many half turns
    /// the disc could have earned at all, NOT whether this one counts
    pub possible_halves: i64,
}

impl SpinTurn {
    /// whether stable pays this half turn as a bonus (1100 / 2N) rather than
    /// as an ordinary turn: past the gate by an even amount
    pub fn is_bonus(&self) -> bool {
        self.half > self.gate && (self.half - self.gate) % 2 == 0
    }
}

/// every spinner's counted half turns in firing order.
///
/// i64 throughout: a crafted requirement can sit at i32::MAX, where
/// `required + 3` would overflow.
///
/// a mismatched processed/timeline pair degrades to skipped records rather
/// than an out-of-bounds panic, on the same terms as the folds themselves
pub(super) fn spin_turns(processed: &ProcessedBeatmap, timeline: &JudgementTimeline) -> Vec<SpinTurn> {
    let mut turns = Vec::new();
    for scoring in &timeline.spinner_scoring {
        let Some(object) = processed.objects.get(scoring.object_index) else {
            continue;
        };
        let ProcessedKind::Spinner(spinner) = &object.kind else {
            continue;
        };
        let gate = i64::from(spinner.stable_half_spins_required) + 3;
        let possible = i64::from(spinner.total_half_spins_possible);
        for (index, increment) in scoring.increments.iter().enumerate() {
            turns.push(SpinTurn {
                emission_index: increment.emission_index,
                time: increment.time,
                half: index as i64 + 1,
                gate,
                possible_halves: possible,
            });
        }
    }
    // emission position first -- it is the only key that places an increment
    // against a judgement stamped with the same millisecond -- then TIME,
    // because the turns were collected one disc at a time and a crafted map
    // can leave two discs turning across the same emission position (no
    // judgement is emitted between their frames, so every increment of both
    // carries it). flattening disc by disc there would hand the HP fold's
    // `Drain` one disc's whole run before the other's first turn, and it
    // cannot rewind. within one disc the times are already non-decreasing, so
    // this only ever merges the discs against each other, and the sort stays
    // stable for two that turned in the very same frame
    turns.sort_by(|a, b| {
        a.emission_index
            .cmp(&b.emission_index)
            .then_with(|| a.time.total_cmp(&b.time))
    });
    turns
}
