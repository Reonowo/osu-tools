//! deterministic judgement simulation over (processed beatmap, replay frames).
//!
//! semantics are stable's own replay-time rules, ported from danser-go
//! (`@ 8331b0ff`, the community-verified stable port) -- the legacy path a
//! pre-lazer `.osr` was actually scored under. per docs/adr/0001 stable
//! end-values are the oracle: where the pinned lazer source disagrees with
//! what stable wrote into `.osr` headers, this module follows stable and the
//! divergence from lazer is documented at the site. the reference map (file,
//! line, and semantics per mechanism) is
//! `.scratch/engine-parity-pass/stable-tracking-reference.md`.
//!
//! # the frame-driven walk
//!
//! stable judges everything at replay frame times (danser
//! rcontroller.go:541-642, post-20190506 handling): per frame, in order --
//! button machinery, the click walk over the processed objects, the normal
//! walk (slider tracking with the one-unfinished-slider gate, spinner
//! segments), the post walk (slider head timeout and end aggregate, circle
//! timeout, spinner finalize) -- all with that frame's RAW cursor sample,
//! never an interpolated one. between frames nothing is judged. after the
//! last frame a synthetic once-per-millisecond walk with released buttons
//! and the frozen cursor resolves whatever remains (rcontroller.go:630-641).
//!
//! a per-millisecond cadence between frames (zero-order-held cursor) was
//! built and measured against the full sweep during the parity pass: it
//! rescued elements the live client demonstrably dropped (held positions
//! outlive the real cursor's departure) and lost 13 points of all-eight
//! parity -- the frame-batch model is the validated one. its known cost is
//! intra-frame ordering: two deadlines landing on one frame apply in walk
//! order, not due-time order (the L033 residual class, triaged in
//! `.scratch/engine-parity-pass/`).
//!
//! objects live on a `processed` list from their fade-in time
//! (`start - preempt`) until judged, and leave it at millisecond
//! granularity -- after the frame group that judged them, not within it
//! (danser drains in `OsuRuleSet.Update` after the frame's processing).
//! membership drives the note lock and the stack shield, which is what
//! resolves the note-lock predecessor lifetime question (parity issue 06)
//! on this path: see `presses::can_be_hit_stable`.
//!
//! # event time conventions
//!
//! every judgement lands at the update that decided it -- a replay frame
//! time, or a whole-millisecond tick of the post-replay walk. an unjudged
//! object whose window closes mid-gap therefore resolves at the NEXT frame.
//! real stable input has frames every few milliseconds throughout, so these
//! times sit within one frame gap of the live client's

pub(crate) mod buttons;
pub(crate) mod presses;
pub mod score;
pub(crate) mod slider;
pub(crate) mod spinner;

use std::cell::Cell;

use crate::beatmap::difficulty::HitGrade;
use crate::beatmap::{ProcessedBeatmap, ProcessedKind};
use crate::error::{resource_limit, EngineError, Result};
use crate::limits;
use crate::replay::frames::{Buttons, ReplayFrame};
use buttons::ButtonMachine;
use score::{JudgementKind, ScoreState};

#[derive(Debug, Clone, PartialEq)]
pub struct JudgementEvent {
    pub time: f64,
    pub object_index: usize,
    pub kind: JudgementKind,
    pub combo_after: u32,
    pub accuracy_after: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct HitTotals {
    pub count_300: u32,
    pub count_100: u32,
    pub count_50: u32,
    pub count_miss: u32,
    pub max_combo: u32,
}

/// one spinner's stable scoring-rotation count at the end of simulation --
/// the half-spin tally stable's own disc physics produced (see
/// `spinner::StableSpinState`). carried on the timeline so the achieved
/// scorev1 fold can apply stable's tick model without disturbing the
/// lazer-parity spin/bonus events
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SpinnerScoring {
    pub object_index: usize,
    pub scoring_half_spins: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct JudgementTimeline {
    pub events: Vec<JudgementEvent>,
    pub totals: HitTotals,
    /// one record per spinner object, in object order
    pub spinner_scoring: Vec<SpinnerScoring>,
}

#[derive(Debug)]
pub(crate) enum ObjectState {
    Circle(CircleState),
    Slider(slider::SliderState),
    Spinner(spinner::SpinnerState),
}

#[derive(Debug, Default)]
pub(crate) struct CircleState {
    pub judged: bool,
}

pub(crate) struct Ctx<'a> {
    pub beatmap: &'a ProcessedBeatmap,
    pub frames: &'a [ReplayFrame],
    pub states: Vec<ObjectState>,
    pub score: ScoreState,
    pub events: Vec<JudgementEvent>,
    /// stable's processed list: object indices born (`start - preempt <=
    /// now`) and not yet drained, in start-time order. every walk -- clicks,
    /// note lock, tracking, post -- iterates this, so its length bounds the
    /// per-update cost the way lazer's alive list bounds its own
    pub processed: Vec<usize>,
    /// index of the first object not yet born; objects are start-time
    /// ordered, so this cursor only moves forward
    pub next_born: usize,
    /// the per-frame gameplay-button machinery (danser difficultyPlayer)
    pub buttons: ButtonMachine,
    /// stable's circle radius (danser difficulty.go:126-127): the f64 range
    /// times the 1.00041 allowance, narrowed to f32 once. deliberately not
    /// the renderer's lazer scale -- the two round differently in the last
    /// f32 bit for fractional circle sizes, and the x87 follow compare needs
    /// stable's exact input
    pub stable_radius: f32,
    /// every spinner's object index, computed once so the frame-instant
    /// rotation sweep never scans the full object list (see spinner.rs)
    pub spinner_indices: Vec<usize>,
    /// monotonic cursor into `spinner_indices` below which every spinner is
    /// permanently finished -- advanced by spinner::advance_first_active
    pub first_active_spinner: usize,
    /// per-update walk steps spent so far, charged against
    /// limits::MAX_SIMULATION_SWEEP_STEPS by the driver. a Cell because
    /// can_be_hit_stable walks under a shared borrow
    pub sweep_steps: Cell<u64>,
}

impl Ctx<'_> {
    pub fn emit(&mut self, time: f64, object_index: usize, kind: JudgementKind) {
        self.score.apply(&kind);
        self.events.push(JudgementEvent {
            time,
            object_index,
            kind,
            combo_after: self.score.combo,
            accuracy_after: self.score.accuracy(),
        });
    }

    /// one walk step (click, note-lock, tracking, post, or spinner sweep),
    /// charged against limits::MAX_SIMULATION_SWEEP_STEPS by the driver
    pub fn charge_sweep_step(&self) {
        self.sweep_steps.set(self.sweep_steps.get() + 1);
    }
}

/// frames must be time-sorted ascending -- `replay::frames::convert_frames`
/// guarantees this for every replay this crate decodes (and already applies
/// stable's own first-frame fixups, intro-frame removal and seed-frame drop,
/// so the walk consumes the converted stream as-is); an empty frame list is
/// rejected below rather than assumed away
pub fn simulate(beatmap: &ProcessedBeatmap, frames: &[ReplayFrame]) -> Result<JudgementTimeline> {
    simulate_with_sweep_budget(beatmap, frames, limits::MAX_SIMULATION_SWEEP_STEPS)
}

/// the sweep-step budget is a parameter (production passes
/// limits::MAX_SIMULATION_SWEEP_STEPS) so its boundary test can drive the
/// cap with a small input, mirroring path::approximator's max_vertices
fn simulate_with_sweep_budget(
    beatmap: &ProcessedBeatmap,
    frames: &[ReplayFrame],
    sweep_budget: u64,
) -> Result<JudgementTimeline> {
    if frames.is_empty() {
        return Err(EngineError::InvalidArgument(
            "cannot simulate a replay with no frames".into(),
        ));
    }
    let states: Vec<ObjectState> = beatmap
        .objects
        .iter()
        .map(|obj| match &obj.kind {
            ProcessedKind::Circle => ObjectState::Circle(CircleState::default()),
            ProcessedKind::Slider(s) => ObjectState::Slider(slider::SliderState::new(obj.start_time, s)),
            ProcessedKind::Spinner(_) => ObjectState::Spinner(spinner::SpinnerState::default()),
        })
        .collect();

    let spinner_indices: Vec<usize> = beatmap
        .objects
        .iter()
        .enumerate()
        .filter(|(_, obj)| matches!(obj.kind, ProcessedKind::Spinner(_)))
        .map(|(i, _)| i)
        .collect();

    // stable's integer 50-window (danser Hit50 = int64 of the f64 range):
    // meh() is floor(range) - 0.5, so + 0.5 recovers the truncated integer.
    // circle timeout and slider head timeout compare strictly against it
    let hit50 = beatmap.windows.meh() + 0.5;

    let mut ctx = Ctx {
        beatmap,
        frames,
        states,
        score: ScoreState::default(),
        events: Vec::new(),
        processed: Vec::new(),
        next_born: 0,
        buttons: ButtonMachine::default(),
        stable_radius: beatmap.stable_radius,
        spinner_indices,
        first_active_spinner: 0,
        sweep_steps: Cell::new(0),
    };

    // the frame walk: frames sharing a timestamp form one group -- each
    // frame gets its own full update, the drain runs once per group (danser
    // drains per millisecond, after that millisecond's frames). between
    // groups, every whole millisecond runs the intermediate walks with the
    // held cursor and settled (edge-free) buttons -- the live cadence the
    // module doc describes
    let mut group_start = 0usize;
    while group_start < frames.len() {
        let time = frames[group_start].time;
        let mut group_end = group_start + 1;
        while group_end < frames.len() && frames[group_end].time == time {
            group_end += 1;
        }
        birth(&mut ctx, time);
        for frame_index in group_start..group_end {
            ctx.buttons.update(frames[frame_index].buttons);
            let cursor_pos = frames[frame_index].pos;
            presses::update_clicks(&mut ctx, time, cursor_pos);
            update_normal(&mut ctx, time, cursor_pos, Some(frame_index));
            update_post(&mut ctx, time, hit50);
            // checked per frame entry rather than per group: a group can
            // hold arbitrarily many zero-delta frames, so a per-group check
            // would let one group overshoot unboundedly
            if ctx.sweep_steps.get() > sweep_budget {
                return Err(resource_limit(
                    "MAX_SIMULATION_SWEEP_STEPS",
                    sweep_budget,
                    ctx.sweep_steps.get(),
                ));
            }
        }
        drain(&mut ctx);
        group_start = group_end;
    }

    // the post-replay walk (rcontroller.go:630-641): once per millisecond
    // with released buttons and the frozen last cursor position, until every
    // object resolves. terminates because every object has a fixed terminal
    // time (timeout, end, or finalize), all bounded by the last end_time
    // plus the 50-window; the sweep budget backstops it regardless
    let last = frames.last().expect("emptiness rejected above");
    let mut time = last.time.floor() + 1.0;
    while ctx.next_born < beatmap.objects.len() || !ctx.processed.is_empty() {
        birth(&mut ctx, time);
        ctx.buttons.update(Buttons::default());
        // released buttons produce no click edges, so the click walk is
        // skipped outright
        update_normal(&mut ctx, time, last.pos, None);
        update_post(&mut ctx, time, hit50);
        drain(&mut ctx);
        ctx.charge_sweep_step();
        if ctx.sweep_steps.get() > sweep_budget {
            return Err(resource_limit(
                "MAX_SIMULATION_SWEEP_STEPS",
                sweep_budget,
                ctx.sweep_steps.get(),
            ));
        }
        time += 1.0;
    }

    let totals = HitTotals {
        count_300: ctx.score.count_300,
        count_100: ctx.score.count_100,
        count_50: ctx.score.count_50,
        count_miss: ctx.score.count_miss,
        max_combo: ctx.score.max_combo,
    };
    // spinner states persist to the end of the run, so the records read
    // straight off the final states rather than being collected mid-loop
    let spinner_scoring = ctx
        .spinner_indices
        .iter()
        .map(|&index| SpinnerScoring {
            object_index: index,
            scoring_half_spins: match &ctx.states[index] {
                ObjectState::Spinner(state) => state.stable.scoring_rotation_count,
                _ => unreachable!("spinner_indices only holds spinner objects"),
            },
        })
        .collect();
    Ok(JudgementTimeline {
        events: ctx.events,
        totals,
        spinner_scoring,
    })
}

/// moves every object whose fade-in time has arrived onto the processed
/// list (danser ruleset.go:306-319 queue drain). objects are start-time
/// ordered with a uniform preempt, so the cursor never skips
fn birth(ctx: &mut Ctx<'_>, time: f64) {
    while ctx.next_born < ctx.beatmap.objects.len()
        && ctx.beatmap.objects[ctx.next_born].start_time - ctx.beatmap.preempt <= time
    {
        ctx.processed.push(ctx.next_born);
        ctx.next_born += 1;
    }
}

/// the normal walk: spinner rotation for frame updates, then slider tracking
/// under stable's one-unfinished-slider gate (ruleset.go:444-472 -- only
/// the FIRST slider with an unjudged end receives tracking per update;
/// every later slider is skipped that pass)
fn update_normal(ctx: &mut Ctx<'_>, time: f64, cursor_pos: crate::math::Vec2, frame_index: Option<usize>) {
    if let Some(frame_index) = frame_index {
        spinner::process_frame_segment(ctx, frame_index);
        spinner::process_stable_scoring_frame(ctx, frame_index);
    }
    let mut unfinished_slider_seen = false;
    let mut idx = 0;
    while idx < ctx.processed.len() {
        let index = ctx.processed[idx];
        idx += 1;
        if !matches!(ctx.beatmap.objects[index].kind, ProcessedKind::Slider(_)) {
            continue;
        }
        ctx.charge_sweep_step();
        if unfinished_slider_seen {
            continue;
        }
        let is_hit = matches!(&ctx.states[index], ObjectState::Slider(s) if s.is_hit);
        if !is_hit {
            unfinished_slider_seen = true;
            // slider.go:244 -- tracking begins at the TRUNCATED start time
            // (`time >= int64(GetStartTime())`)
            if time >= (ctx.beatmap.objects[index].start_time as i64) as f64 {
                slider::update_for(ctx, index, time, cursor_pos);
            }
        }
    }
}

/// the post walk (ruleset.go:474-484): every processed object's end-of-life
/// checks at this update's time, in list order
fn update_post(ctx: &mut Ctx<'_>, time: f64, hit50: f64) {
    let mut idx = 0;
    while idx < ctx.processed.len() {
        let index = ctx.processed[idx];
        idx += 1;
        ctx.charge_sweep_step();
        match &ctx.beatmap.objects[index].kind {
            ProcessedKind::Circle => {
                // circle.go:104 -- timeout strictly past int64(end) + hit50
                let judged = matches!(&ctx.states[index], ObjectState::Circle(c) if c.judged);
                if !judged && time > (ctx.beatmap.objects[index].end_time as i64) as f64 + hit50 {
                    match &mut ctx.states[index] {
                        ObjectState::Circle(c) => c.judged = true,
                        _ => unreachable!("kind matched circle above"),
                    }
                    ctx.emit(time, index, JudgementKind::Circle(HitGrade::Miss));
                }
            }
            ProcessedKind::Slider(_) => slider::update_post_for(ctx, index, time, hit50),
            ProcessedKind::Spinner(_) => {
                let finished = matches!(&ctx.states[index], ObjectState::Spinner(s) if s.finished);
                if !finished && time >= ctx.beatmap.objects[index].end_time {
                    // finalize flushes the segment between the last frame and
                    // its own clamp at end_time, so a late first-update-past-
                    // the-end loses no rotation
                    spinner::finalize(ctx, index, time);
                }
            }
        }
    }
}

/// removes judged objects from the processed list (danser
/// ruleset.go:289-304 UpdatePost drain). runs after a frame group, never
/// inside one: an object judged this millisecond still occupies its slot
/// for the rest of the millisecond's processing
fn drain(ctx: &mut Ctx<'_>) {
    let states = &ctx.states;
    ctx.processed.retain(|&index| match &states[index] {
        ObjectState::Circle(c) => !c.judged,
        ObjectState::Slider(s) => !s.finished(),
        ObjectState::Spinner(s) => !s.finished,
    });
}

/// shared test-map builders and replay-frame helpers, split out so both
/// this module's tests and slider.rs's (and later spinner.rs's / the
/// integration tests') can build on the same base maps
#[cfg(test)]
pub(crate) mod test_support {
    use crate::beatmap::{process_beatmap, NestedKind, ProcessedBeatmap, ProcessedKind};
    use crate::formats::beatmap::{
        Beatmap, HitObject, HitObjectKind, PathControlPoint, PathType, SliderData, TimingPoint,
    };
    use crate::formats::GameMode;
    use crate::math::Vec2;
    use crate::replay::frames::{Buttons, ReplayFrame};

    fn base_map(hit_objects: Vec<HitObject>) -> Beatmap {
        Beatmap {
            format_version: 14,
            mode: GameMode::Osu,
            title: String::new(),
            artist: String::new(),
            creator: String::new(),
            version: String::new(),
            beatmap_id: 0,
            beatmap_set_id: 0,
            audio_file: String::new(),
            audio_lead_in: 0.0,
            background_file: String::new(),
            stack_leniency: 0.7,
            hp_drain_rate: 5.0,
            circle_size: 4.0,
            overall_difficulty: 5.0, // windows 49.5 / 99.5 / 149.5 (stable ints 50/100/150)
            approach_rate: 9.0,      // preempt 600
            slider_multiplier: 1.4,
            slider_tick_rate: 1.0,
            combo_colors: Vec::new(),
            default_sample_bank: crate::formats::samples::SampleBank::Normal,
            default_sample_volume: 100,
            samples_match_playback_rate: false,
            breaks: Vec::new(),
            timing_points: vec![TimingPoint {
                time: 0.0,
                beat_len: 500.0,
            }],
            difficulty_points: Vec::new(),
            hit_objects,
        }
    }

    pub(crate) fn circle_map(times_positions: &[(f64, f32, f32)]) -> ProcessedBeatmap {
        let map = base_map(
            times_positions
                .iter()
                .map(|&(t, x, y)| HitObject {
                    start_time: t,
                    pos: Vec2::new(x, y),
                    new_combo: false,
                    combo_offset: 0,
                    samples: Vec::new(),
                    kind: HitObjectKind::Circle,
                })
                .collect(),
        );
        process_beatmap(&map).unwrap()
    }

    /// control points as in task 5's tests: a two-point linear segment whose
    /// expected distance pins the path length exactly
    fn linear_slider(start_time: f64, pos: Vec2, length: f64, repeat_count: i32) -> HitObject {
        HitObject {
            start_time,
            pos,
            new_combo: false,
            combo_offset: 0,
            samples: Vec::new(),
            kind: HitObjectKind::Slider(SliderData {
                control_points: vec![
                    PathControlPoint {
                        pos: Vec2::ZERO,
                        path_type: Some(PathType::Linear),
                    },
                    PathControlPoint {
                        pos: Vec2::new(length as f32, 0.0),
                        path_type: None,
                    },
                ],
                expected_distance: Some(length),
                repeat_count,
                node_samples: Vec::new(),
            }),
        }
    }

    /// od 5, ar 9, cs 4, sm 1.4, beat 500 (velocity 0.28); one linear slider
    /// at (100, 100), length 100, tail at (200, 100). duration = 100 / 0.28
    pub(crate) fn slider_map(tick_rate: f64, repeat_count: i32) -> ProcessedBeatmap {
        slider_map_with_circle_size(tick_rate, repeat_count, 4.0)
    }

    /// same as slider_map but with a configurable circle size, for tests
    /// that need a specific head-radius-to-tick-distance ratio (circle size
    /// changes only the head/follow radius, never velocity or tick/tail
    /// placement, which come from slider_multiplier/beat_len/tick_rate alone)
    pub(crate) fn slider_map_with_circle_size(
        tick_rate: f64,
        repeat_count: i32,
        circle_size: f32,
    ) -> ProcessedBeatmap {
        let mut map = base_map(vec![linear_slider(
            1000.0,
            Vec2::new(100.0, 100.0),
            100.0,
            repeat_count,
        )]);
        map.slider_tick_rate = tick_rate;
        map.circle_size = circle_size;
        process_beatmap(&map).unwrap()
    }

    /// the first slider's first tick time, for tests reasoning about
    /// tick/tail ordering
    pub(crate) fn beatmap_tick_time(beatmap: &ProcessedBeatmap) -> f64 {
        let ProcessedKind::Slider(s) = &beatmap.objects[0].kind else {
            panic!("beatmap_tick_time expects a slider as the first object")
        };
        s.nested
            .iter()
            .find(|n| n.kind == NestedKind::Tick)
            .expect("beatmap_tick_time expects at least one tick")
            .time
    }

    /// the base map with a single spinner starting at 1000, given duration
    /// and overall difficulty (which sets spins_required/max_bonus_spins)
    pub(crate) fn spinner_map(duration: f64, od: f32) -> ProcessedBeatmap {
        let mut map = base_map(vec![HitObject {
            start_time: 1000.0,
            pos: Vec2::ZERO,
            new_combo: false,
            combo_offset: 0,
            samples: Vec::new(),
            kind: HitObjectKind::Spinner { duration },
        }]);
        map.overall_difficulty = od;
        process_beatmap(&map).unwrap()
    }

    /// four-object map exercising every judgement kind in one timeline:
    /// circle at 1000, slider at 2000 (tick rate 2 -> one tick, matching
    /// slider_map's velocity/tick-distance derivation), spinner 4000-6000
    /// (od 5 -> spins_required 5, same numbers as spinner_map(2000.0, 5.0)),
    /// circle at 6500. reuses base_map's od 5 / ar 9 / cs 4 / sm 1.4
    /// defaults so every difficulty-derived number matches the single-object
    /// test maps built from the same builders
    pub(crate) fn mixed_map() -> ProcessedBeatmap {
        let mut map = base_map(vec![
            HitObject {
                start_time: 1000.0,
                pos: Vec2::new(256.0, 192.0),
                new_combo: false,
                combo_offset: 0,
                samples: Vec::new(),
                kind: HitObjectKind::Circle,
            },
            linear_slider(2000.0, Vec2::new(100.0, 100.0), 100.0, 0),
            HitObject {
                start_time: 4000.0,
                pos: Vec2::ZERO,
                new_combo: false,
                combo_offset: 0,
                samples: Vec::new(),
                kind: HitObjectKind::Spinner { duration: 2000.0 },
            },
            HitObject {
                start_time: 6500.0,
                pos: Vec2::new(256.0, 192.0),
                new_combo: false,
                combo_offset: 0,
                samples: Vec::new(),
                kind: HitObjectKind::Circle,
            },
        ]);
        map.slider_tick_rate = 2.0;
        process_beatmap(&map).unwrap()
    }

    /// held circular frames spanning a spinner's window, reusing task 16's
    /// spinner-test generator pattern (spinner.rs's `spin_frames`): steps
    /// fixed at 8-per-revolution/10ms apart, starting at the object's own
    /// start time. holds RIGHT_1 rather than LEFT_1 -- deliberately distinct
    /// from a following circle press, so that press's own rising edge still
    /// registers instead of being read as an already-held button
    pub(crate) fn spin_frames_for(
        beatmap: &ProcessedBeatmap,
        object_index: usize,
        revolutions: f64,
    ) -> Vec<ReplayFrame> {
        let obj = &beatmap.objects[object_index];
        let steps_per_rev = 8u32;
        let total_steps = (revolutions * steps_per_rev as f64).ceil() as u32;
        (0..=total_steps)
            .map(|i| {
                let theta = i as f64 * std::f64::consts::TAU / steps_per_rev as f64;
                frame(
                    obj.start_time + i as f64 * 10.0,
                    obj.position.x + 100.0 * theta.cos() as f32,
                    obj.position.y + 100.0 * theta.sin() as f32,
                    Buttons::RIGHT_1,
                )
            })
            .collect()
    }

    pub(crate) fn frame(time: f64, x: f32, y: f32, raw: u32) -> ReplayFrame {
        ReplayFrame {
            time,
            pos: Vec2::new(x, y),
            buttons: Buttons::new(raw),
        }
    }

    /// idle frame well before everything plus a trailing idle frame, so
    /// button edges are unambiguous and late timeouts have a frame to land
    /// on (stable resolves everything at update times; the trailing frame
    /// at 100_000 is where a wholly-unattended object's timeout lands)
    pub(crate) fn wrap(frames: Vec<ReplayFrame>) -> Vec<ReplayFrame> {
        let mut all = vec![frame(-1000.0, 0.0, 0.0, 0)];
        all.extend(frames);
        all.push(frame(100_000.0, 0.0, 0.0, 0));
        all
    }
}

#[cfg(test)]
mod tests {
    use super::score::JudgementKind;
    use super::test_support::{circle_map, frame, wrap};
    use super::*;
    use crate::beatmap::difficulty::HitGrade;
    use crate::replay::frames::Buttons;

    #[test]
    fn simulating_with_no_frames_is_rejected() {
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let result = simulate(&beatmap, &[]);
        assert!(matches!(result, Err(EngineError::InvalidArgument(_))));
    }

    #[test]
    fn sweep_step_budget_boundary() {
        // one circle, one press frame. hand-count of charged steps:
        // frame -1000 (wrap lead): nothing born, no edges -> 0.
        // frame 1000 (press): birth -> processed [0]; click walk: 1 per-
        // object step + can_be_hit_stable's shield-position walk (1) and
        // note-lock walk breaking at the target (1) = 3; normal walk 0 (no
        // sliders); post walk 1 (the circle's visit). = 4.
        // frame 100_000: circle drained, everything resolved -> 0.
        // post-replay walk: never entered (nothing left). total = 4
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let frames = wrap(vec![frame(1000.0, 256.0, 192.0, Buttons::LEFT_1)]);

        let timeline = simulate_with_sweep_budget(&beatmap, &frames, 4).unwrap();
        assert_eq!(timeline.totals.count_300, 1);

        match simulate_with_sweep_budget(&beatmap, &frames, 3) {
            Err(EngineError::ResourceLimit {
                cap: "MAX_SIMULATION_SWEEP_STEPS",
                ..
            }) => {}
            other => panic!("expected ResourceLimit, got {other:?}"),
        }
    }

    #[test]
    fn a_press_on_the_circle_in_the_great_window_judges_great() {
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![frame(1010.0, 256.0, 192.0, Buttons::LEFT_1)]),
        )
        .unwrap();
        assert_eq!(timeline.events.len(), 1);
        let e = &timeline.events[0];
        assert_eq!(e.time, 1010.0);
        assert_eq!(e.object_index, 0);
        assert_eq!(e.kind, JudgementKind::Circle(HitGrade::Great));
        assert_eq!(e.combo_after, 1);
        assert_eq!(timeline.totals.count_300, 1);
        assert_eq!(timeline.totals.max_combo, 1);
    }

    #[test]
    fn window_edges_step_through_ok_meh_and_early_miss() {
        // stable windows at od 5 are the truncated integers 50/100/150 with
        // strict less-than (danser GetResultForDelta), which the half-ms
        // windows reproduce exactly for the integral deltas real input
        // produces: 49 -> 300, 50 -> 100, 100 -> 50, 149 -> 50, 150 -> miss
        for (offset, expected) in [
            (49.0, JudgementKind::Circle(HitGrade::Great)),
            (50.0, JudgementKind::Circle(HitGrade::Ok)),
            (100.0, JudgementKind::Circle(HitGrade::Meh)),
            (149.0, JudgementKind::Circle(HitGrade::Meh)),
            (150.0, JudgementKind::Circle(HitGrade::Miss)), // a late click inside 400 judges miss
            (-160.0, JudgementKind::Circle(HitGrade::Miss)), // early press inside 400
        ] {
            let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
            let timeline = simulate(
                &beatmap,
                &wrap(vec![frame(1000.0 + offset, 256.0, 192.0, Buttons::LEFT_1)]),
            )
            .unwrap();
            assert_eq!(timeline.events[0].kind, expected, "offset {offset}");
        }
    }

    #[test]
    fn an_unclicked_circle_misses_at_the_first_update_past_the_window() {
        // stable resolves timeouts at update times only: with no frames
        // between the window's close and the trailing wrap frame, the miss
        // lands on that trailing frame -- and a frame exactly at end + 150
        // is NOT yet a miss (strict greater-than, circle.go:104)
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(&beatmap, &wrap(vec![frame(1150.0, 50.0, 50.0, 0)])).unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(timeline.events[0].time, 100_000.0);

        let timeline = simulate(&beatmap, &wrap(vec![frame(1151.0, 50.0, 50.0, 0)])).unwrap();
        assert_eq!(timeline.events[0].time, 1151.0);
        assert_eq!(timeline.totals.count_miss, 1);
    }

    #[test]
    fn a_press_far_outside_the_miss_window_shakes_and_consumes_nothing_judgeable() {
        // 600ms early is at-or-past the 400ms hittable range -> shake, no
        // judgement; the circle still times out on its own later
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(&beatmap, &wrap(vec![frame(400.0, 256.0, 192.0, Buttons::LEFT_1)])).unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(timeline.events[0].time, 100_000.0);
    }

    #[test]
    fn note_lock_shakes_a_press_while_an_earlier_object_is_unhit() {
        // ruleset.go:650-660: b is locked while a (end + 3 < b's start) is
        // unhit. the lock reads batch with the frame: a's timeout lands in
        // the POST walk of the frame past its window, and the click walk
        // runs first -- so a press for b on that very frame is still
        // locked; only a later press can hit b. (an expiry-aware read was
        // measured and rejected -- see the note in presses.rs)
        let beatmap = circle_map(&[(1200.0, 100.0, 100.0), (1300.0, 300.0, 100.0)]);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![
                frame(1250.0, 300.0, 100.0, Buttons::LEFT_1), // locked: a unhit
                frame(1260.0, 300.0, 100.0, 0),
                frame(1360.0, 300.0, 100.0, Buttons::LEFT_1), // still locked: a times out post-click this frame
                frame(1370.0, 300.0, 100.0, 0),
                frame(1380.0, 300.0, 100.0, Buttons::LEFT_1), // a resolved and drained -> b hittable
            ]),
        )
        .unwrap();
        let a_events: Vec<_> = timeline.events.iter().filter(|e| e.object_index == 0).collect();
        assert_eq!(a_events.len(), 1);
        assert_eq!(a_events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(a_events[0].time, 1360.0);
        let b_events: Vec<_> = timeline.events.iter().filter(|e| e.object_index == 1).collect();
        assert_eq!(b_events.len(), 1);
        assert_eq!(b_events[0].kind, JudgementKind::Circle(HitGrade::Ok)); // 80ms late
        assert_eq!(b_events[0].time, 1380.0);
    }

    #[test]
    fn overlapping_circles_consume_presses_topmost_first() {
        // same position, 100ms apart: the earlier circle draws on top and
        // eats the first press; the second press falls to the later circle
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0), (1100.0, 256.0, 192.0)]);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![
                frame(1000.0, 256.0, 192.0, Buttons::LEFT_1),
                frame(1050.0, 256.0, 192.0, 0),
                frame(1100.0, 256.0, 192.0, Buttons::LEFT_1),
            ]),
        )
        .unwrap();
        assert_eq!(timeline.events.len(), 2);
        assert_eq!(timeline.events[0].object_index, 0);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Great));
        assert_eq!(timeline.events[1].object_index, 1);
        assert_eq!(timeline.events[1].kind, JudgementKind::Circle(HitGrade::Great));
    }

    #[test]
    fn two_buttons_in_one_frame_are_two_edges_left_first() {
        // one click walk sees both edges: the earlier circle consumes left,
        // the later circle consumes right in the same pass (the earlier one
        // is judged mid-walk, so it neither locks nor shields the later)
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0), (1049.0, 256.0, 192.0)]);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![frame(
                1000.0,
                256.0,
                192.0,
                Buttons::LEFT_1 | Buttons::RIGHT_1,
            )]),
        )
        .unwrap();
        assert_eq!(timeline.events.len(), 2);
        assert_eq!(timeline.events[0].object_index, 0);
        assert_eq!(timeline.events[1].object_index, 1);
        assert_eq!(timeline.events[1].kind, JudgementKind::Circle(HitGrade::Great)); // 49ms early
    }

    #[test]
    fn a_press_off_every_circle_hits_nothing() {
        // out of range with a clickable action is a positional miss: edges
        // are kept, nothing judges, the circle times out on the trailing frame
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(&beatmap, &wrap(vec![frame(1000.0, 500.0, 50.0, Buttons::LEFT_1)])).unwrap();
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(timeline.events[0].time, 100_000.0);
    }

    #[test]
    fn previous_object_already_judged_does_not_block_the_press() {
        // a judged predecessor leaves the processed list at the end of its
        // frame group (drain at millisecond granularity), so by the later
        // press it neither locks nor shields -- the stable-membership
        // answer to what lazer models with drawable lifetimes
        let beatmap = circle_map(&[
            (1200.0, 256.0, 192.0),
            (1250.0, 256.0, 192.0),
            (1290.0, 256.0, 192.0),
        ]);
        assert!(beatmap.objects[1].stack_height > 0);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![
                frame(1200.0, 256.0, 192.0, Buttons::LEFT_1), // hits circle 0
                frame(1210.0, 256.0, 192.0, 0),
                frame(1290.0, 256.0, 192.0, Buttons::LEFT_1), // circle 0 drained, so circle 1 proceeds
            ]),
        )
        .unwrap();
        let judged: Vec<_> = timeline.events.iter().map(|e| e.object_index).collect();
        assert_eq!(judged[0], 0);
        assert_eq!(judged[1], 1);
    }

    #[test]
    fn stacked_unjudged_previous_object_ignores_the_press() {
        // ruleset.go:636-648 -- the immediate predecessor in the processed
        // list (stacked, unhit) swallows the press entirely -- no shake, no
        // judgement -- even though it sits nowhere near the cursor: the
        // shield is list/state-based, not geometric
        let beatmap = circle_map(&[
            (1200.0, 100.0, 100.0), // "prev": far from the target, stacks with the object below
            (1250.0, 300.0, 100.0), // target: under the cursor
            (1290.0, 100.0, 100.0), // seeds prev's stack height; never touched by any press
        ]);
        assert!(beatmap.objects[0].stack_height > 0);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![frame(1250.0, 300.0, 100.0, Buttons::LEFT_1)]),
        )
        .unwrap();
        // the press is swallowed entirely: every object still times out on
        // the trailing frame, none of them from the press itself
        assert_eq!(timeline.events.len(), 3);
        for e in &timeline.events {
            assert_eq!(e.kind, JudgementKind::Circle(HitGrade::Miss));
            assert_eq!(e.time, 100_000.0);
        }
        assert_eq!(timeline.events[0].object_index, 0);
        assert_eq!(timeline.events[1].object_index, 1);
        assert_eq!(timeline.events[2].object_index, 2);
    }

    #[test]
    fn a_mixed_map_produces_the_exact_hand_derived_timeline() {
        // map: circle at 1000 (256,192) -- slider at 2000 (100,100), length
        // 100, tick rate 2 (one tick) -- spinner 4000-6000 -- circle at 6500
        // replay: hit everything cleanly. an idle frame after the spinner's
        // end gives its finalize an update to land on before the last press
        // (real input always has one -- stable records frames continuously)
        let beatmap = test_support::mixed_map();
        let end_t = beatmap.objects[1].end_time;
        let mut frames = vec![
            frame(1000.0, 256.0, 192.0, Buttons::LEFT_1), // circle 0: great
            frame(1500.0, 256.0, 192.0, 0),
            frame(2000.0, 100.0, 100.0, Buttons::RIGHT_1), // slider head
            frame(2250.0, 170.0, 100.0, Buttons::RIGHT_1), // over the tick
            frame(end_t, 200.0, 100.0, Buttons::RIGHT_1),  // to the tail
            frame(end_t + 20.0, 200.0, 100.0, 0),
        ];
        frames.extend(test_support::spin_frames_for(&beatmap, 2, 8.0));
        frames.push(frame(6010.0, 0.0, 100.0, 0)); // idle frame past spinner end
        frames.push(frame(6500.0, 256.0, 192.0, Buttons::LEFT_1)); // circle 3: great
        let timeline = simulate(&beatmap, &wrap(frames)).unwrap();

        use crate::beatmap::difficulty::HitGrade::*;
        use JudgementKind::*;
        let kinds: Vec<_> = timeline.events.iter().map(|e| e.kind).collect();
        let spins = kinds
            .iter()
            .filter(|k| matches!(k, SpinnerSpin | SpinnerBonus))
            .count();
        let expected = [
            Circle(Great),
            SliderHead { hit: true },
            SliderTick { hit: true },
            SliderTail { hit: true },
            SliderAggregate(Great),
        ];
        // spinner spin/bonus counts vary with sampling; assert around them
        assert_eq!(&kinds[..5], &expected[..5]);
        assert!(spins >= 1);
        assert_eq!(kinds[5 + spins], SpinnerFinal(Great));
        assert_eq!(kinds[6 + spins], Circle(Great));

        // combo walk: 1 (circle), 2 (head), 3 (tick), 4 (tail), aggregate
        // holds 4, spins hold 4, spinner final 5, last circle 6
        assert_eq!(timeline.events[0].combo_after, 1);
        assert_eq!(timeline.events[3].combo_after, 4);
        assert_eq!(timeline.events[4].combo_after, 4);
        assert_eq!(timeline.events.last().unwrap().combo_after, 6);
        assert_eq!(timeline.totals.max_combo, 6);
        assert_eq!(timeline.totals.count_300, 4); // circle, aggregate, spinner, circle
        assert_eq!(timeline.totals.count_miss, 0);

        // accuracy after each basic result is the stable formula
        assert_eq!(timeline.events[0].accuracy_after, 1.0);
        assert_eq!(timeline.events.last().unwrap().accuracy_after, 1.0);
    }

    #[test]
    fn events_are_time_ordered_and_totals_fold_from_events() {
        let beatmap = test_support::mixed_map();
        let timeline = simulate(&beatmap, &wrap(vec![frame(0.0, 0.0, 0.0, 0)])).unwrap();
        for pair in timeline.events.windows(2) {
            assert!(pair[0].time <= pair[1].time, "events must be time-sorted");
        }
        // an all-miss replay still judges every object exactly once at the
        // basic level: 2 circles + 1 aggregate + 1 spinner final
        let basics = timeline
            .events
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    JudgementKind::Circle(_)
                        | JudgementKind::SliderAggregate(_)
                        | JudgementKind::SpinnerFinal(_)
                )
            })
            .count();
        assert_eq!(basics, 4);
        assert_eq!(
            timeline.totals.count_miss
                + timeline.totals.count_300
                + timeline.totals.count_100
                + timeline.totals.count_50,
            4
        );
        // every object reached a terminal state
        for i in 0..beatmap.objects.len() {
            assert!(timeline.events.iter().any(|e| e.object_index == i));
        }
    }

    #[test]
    fn a_click_on_the_window_edge_judges_before_the_timeout_can() {
        // at exactly start + 150 the timeout has not fired (strict >) and a
        // click still lands -- as a miss, since 150 is outside the meh
        // window: the click walk decides the circle, not the post walk
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![frame(1150.0, 256.0, 192.0, Buttons::LEFT_1)]),
        )
        .unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(timeline.events[0].time, 1150.0);
    }

    #[test]
    fn everything_resolves_in_the_post_replay_walk_when_frames_end_early() {
        // the replay ends before the circle's window: the timeout lands on a
        // whole-millisecond tick of the post-replay walk, strictly past
        // start + 150
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let frames = vec![frame(-1000.0, 0.0, 0.0, 0), frame(500.0, 0.0, 0.0, 0)];
        let timeline = simulate(&beatmap, &frames).unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(timeline.events[0].time, 1151.0);
    }
}
