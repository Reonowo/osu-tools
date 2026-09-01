//! optional, additive trace of the slider tracking machine's own decisions.
//!
//! nothing here participates in judgement. every hook is a thread-local
//! record behind a flag that is OFF by default, so `simulate`'s output is
//! byte-identical whether or not a trace runs; the only cost on the normal
//! path is one thread-local boolean read per tracked slider update.
//!
//! it exists because one half of the slider-tracking divergence class is
//! invisible in the judgement timeline. when the engine DROPS an element
//! stable kept, the timeline says so (`hit: false`, or a point with no event
//! at all). when the engine KEEPS an element stable dropped, the timeline
//! records a plain hit and says nothing about how close the call was --
//! and "how close" is exactly the question that separates a deterministic
//! boundary (a map property, invariant across that map's plays) from cursor
//! noise (a play property). the signals recorded here are the three
//! boundaries the stable machine actually turns on: the x87 follow-radius
//! compare (`dst_sq_87 < mul87(r, r)`, STRICT less-than), the
//! `slide_start <= point.time` rescue gate, and how far behind the point's
//! own time the judging update arrived.
//!
//! consumer: `examples/probe_map_invariance.rs`

use std::cell::{Cell, RefCell};

use crate::beatmap::stable_points::StablePointKind;

/// the tracking state one update computed for one slider, as
/// `slider::update_for` computed it -- before the update's own
/// `sliding`/`slide_start` mutation, so `sliding_before` is the flag that
/// chose `radius_sq`
#[derive(Debug, Clone, Copy)]
pub struct TrackingSample {
    pub object_index: usize,
    pub time: f64,
    /// `dst_sq_87(cursor, ball)` -- squared, x87-rounded
    pub dist_sq: f32,
    /// `mul87(r_needed, r_needed)`, with `r_needed` already carrying the
    /// 2.4x follow expansion when `sliding_before`
    pub radius_sq: f32,
    /// the button-acceptance machine's answer
    pub acceptable: bool,
    pub sliding_before: bool,
    pub allowable: bool,
}

/// one nested point's judgement with the update's tracking state attached
#[derive(Debug, Clone, Copy)]
pub struct PointDecision {
    pub object_index: usize,
    /// position in the slider's own stable point list -- the play-invariant
    /// half of the element identity (the other half, kind and time, is a
    /// property of the map and is looked up from it)
    pub point_index: usize,
    pub point_time: f64,
    pub point_kind: StablePointKind,
    /// the update that judged it (a replay frame time, or a whole
    /// millisecond of the post-replay walk)
    pub judged_at: f64,
    pub hit: bool,
    pub allowable: bool,
    pub slide_start: f64,
    pub dist_sq: f32,
    pub radius_sq: f32,
    pub acceptable: bool,
    pub sliding_before: bool,
    /// the tracking sample of the update BEFORE the one that judged it, for
    /// the same slider. a point is due at `point_time` but judged at the
    /// first update at-or-past it, so this is what the machine saw one
    /// replay frame earlier -- the whole "the judging update arrived a frame
    /// late and the player had already left" question is decided by
    /// comparing the two
    pub previous: Option<TrackingSample>,
}

impl PointDecision {
    /// how far into the follow area the cursor sat, as a fraction of the
    /// allowed radius: `< 1` is inside, `>= 1` is the STRICT compare's
    /// failing side. 1.0 exactly is the boundary the whole class turns on
    pub fn radius_ratio(&self) -> f64 {
        if self.radius_sq <= 0.0 {
            return f64::INFINITY;
        }
        (f64::from(self.dist_sq) / f64::from(self.radius_sq)).sqrt()
    }

    /// slack in the `slide_start <= point.time` gate, in milliseconds:
    /// `>= 0` passed the gate, `0` sat exactly on it
    pub fn gate_slack(&self) -> f64 {
        self.point_time - self.slide_start
    }

    /// how far behind the point's own time the judging update arrived
    pub fn lag(&self) -> f64 {
        self.judged_at - self.point_time
    }

    /// whether the update BEFORE the judging one would have scored this
    /// point, had the point been due then. `allowable` at that update
    /// implies the slide was (re)started at or before it, so the
    /// `slide_start <= point.time` gate would have passed too -- the whole
    /// condition reduces to "was the previous sample allowable, and did it
    /// sit at or before the point's own time"
    pub fn would_score_one_update_earlier(&self) -> bool {
        match self.previous {
            Some(previous) => previous.allowable && previous.time <= self.point_time,
            None => false,
        }
    }
}

thread_local! {
    static ENABLED: Cell<bool> = const { Cell::new(false) };
    static LAST_SAMPLE: Cell<Option<TrackingSample>> = const { Cell::new(None) };
    /// the sample before `LAST_SAMPLE`, kept only while it belongs to the
    /// same slider -- a different object means a different tracking history
    static PREV_SAMPLE: Cell<Option<TrackingSample>> = const { Cell::new(None) };
    static DECISIONS: RefCell<Vec<PointDecision>> = const { RefCell::new(Vec::new()) };
}

/// begins a trace on this thread, dropping whatever a previous one left.
/// pair with [`finish`] -- a trace left running only costs memory, never
/// correctness
pub fn start() {
    ENABLED.with(|e| e.set(true));
    LAST_SAMPLE.with(|s| s.set(None));
    PREV_SAMPLE.with(|s| s.set(None));
    DECISIONS.with(|d| d.borrow_mut().clear());
}

/// stops the trace and yields every point decision recorded since [`start`],
/// in emission order
pub fn finish() -> Vec<PointDecision> {
    ENABLED.with(|e| e.set(false));
    LAST_SAMPLE.with(|s| s.set(None));
    PREV_SAMPLE.with(|s| s.set(None));
    DECISIONS.with(|d| std::mem::take(&mut *d.borrow_mut()))
}

fn enabled() -> bool {
    ENABLED.with(|e| e.get())
}

/// `slider::update_for` hook: the update's tracking state, held until the
/// point walk of that same update reads it back
pub(crate) fn note_tracking(sample: TrackingSample) {
    if !enabled() {
        return;
    }
    let previous = LAST_SAMPLE.with(|s| s.get());
    // <= not <: frames sharing a timestamp each run their own update, and
    // the update before a duplicate-time one is a real machine state -- a
    // strict compare would erase the history exactly on those runs
    PREV_SAMPLE.with(|s| {
        s.set(previous.filter(|p| p.object_index == sample.object_index && p.time <= sample.time))
    });
    LAST_SAMPLE.with(|s| s.set(Some(sample)));
}

/// `slider::process_ticks_stable` hook: one judged point, joined with the
/// tracking sample of the update that judged it
#[allow(clippy::too_many_arguments)]
pub(crate) fn note_point(
    object_index: usize,
    point_index: usize,
    point_time: f64,
    point_kind: StablePointKind,
    judged_at: f64,
    hit: bool,
    allowable: bool,
    slide_start: f64,
) {
    if !enabled() {
        return;
    }
    // the point walk only ever runs from inside update_for, so the last
    // sample is this update's; a missing one would mean that stopped being
    // true, and is recorded as an impossible-to-mistake sentinel rather
    // than silently averaged into the boundary statistics
    let sample = LAST_SAMPLE.with(|s| s.get());
    let (dist_sq, radius_sq, acceptable, sliding_before) = match sample {
        Some(s) if s.object_index == object_index && s.time == judged_at => {
            (s.dist_sq, s.radius_sq, s.acceptable, s.sliding_before)
        }
        _ => (f32::NAN, f32::NAN, false, false),
    };
    let previous = PREV_SAMPLE.with(|s| s.get()).filter(|p| p.object_index == object_index);
    DECISIONS.with(|d| {
        d.borrow_mut().push(PointDecision {
            object_index,
            point_index,
            point_time,
            point_kind,
            judged_at,
            hit,
            allowable,
            slide_start,
            dist_sq,
            radius_sq,
            acceptable,
            sliding_before,
            previous,
        })
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::frames::Buttons;
    use crate::simulation::simulate;
    use crate::simulation::test_support::{frame, slider_map, wrap};

    #[test]
    fn a_trace_records_every_point_and_leaves_the_timeline_untouched() {
        let beatmap = slider_map(2.0, 0);
        let end_t = beatmap.objects[0].end_time;
        let frames = wrap(vec![
            frame(1000.0, 100.0, 100.0, Buttons::LEFT_1),
            frame(1250.0, 170.0, 100.0, Buttons::LEFT_1),
            frame(end_t, 200.0, 100.0, Buttons::LEFT_1),
            frame(end_t + 50.0, 200.0, 100.0, 0),
        ]);
        let untraced = simulate(&beatmap, &frames).unwrap();

        start();
        let traced = simulate(&beatmap, &frames).unwrap();
        let decisions = finish();

        assert_eq!(untraced, traced, "a trace must not perturb the timeline");
        // tick then tail, both scored, both inside the follow area
        assert_eq!(decisions.len(), 2);
        assert!(decisions.iter().all(|d| d.hit && d.radius_ratio() < 1.0));
        assert_eq!(decisions[0].point_index, 0);
        assert_eq!(decisions[1].point_index, 1);
        assert!(decisions[1].gate_slack() >= 0.0);
    }

    #[test]
    fn tracing_off_records_nothing() {
        let beatmap = slider_map(2.0, 0);
        let frames = wrap(vec![frame(1000.0, 100.0, 100.0, Buttons::LEFT_1)]);
        simulate(&beatmap, &frames).unwrap();
        assert!(finish().is_empty());
    }
}
