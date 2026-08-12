//! deterministic judgement simulation over (processed beatmap, replay frames).
//!
//! semantics are the legacy/stable ruleset path -- classic slider behaviour,
//! legacy note lock -- which is what lazer applies to every pre-lazer .osr
//! via the auto-appended classic mod (legacyscoredecoder.cs:91-92).
//!
//! # event time conventions
//!
//! lazer applies time-gated results on the first render frame after their
//! condition holds; a deterministic simulator has no render frames, so each
//! such event lands exactly at its boundary: circle and slider-head auto-miss
//! at `start_time + meh`, ticks/repeats at their own time, the tail from
//! `end - 36` (TAIL_LENIENCY), the aggregate and spinner results at the first
//! instant they become decidable. windows end in .5ms while replay frames are
//! integral, so boundary equality cannot arise from encoder-written input.
//!
//! # instant sweep
//!
//! the simulator walks a merged, time-sorted list of instants: every replay
//! frame time plus every judgement deadline (circle auto-miss at
//! `start_time + meh`; a slider's head auto-miss at the same offset, each
//! tick/repeat's own time, the tail-leniency instant at `end_time +
//! TAIL_LENIENCY`, and `end_time` itself for the classic aggregate; a
//! spinner's own `end_time` for its final result). every frame entry runs
//! one full update cycle -- presses, spinner rotation segment, tracking
//! sweep over that frame's OWN cursor sample, nested-object drain --
//! because that is lazer's frame-stability shape: one replay frame per
//! step, one full update per step, duplicate timestamps included
//! (spinner rotation only advances between consecutive frame instants; a
//! trailing flush at the spinner's own end-of-window deadline covers
//! whatever partial segment no frame instant ever swept, see
//! `simulation::spinner`'s module doc for why one delta per segment
//! reproduces lazer's per-render sum). deadline entries have no update of
//! their own in lazer, so the deadline entries at one timestamp share one
//! group: a settled-sample tracking sweep (the interpolated cursor keeps
//! moving between frames), then each entry's due checks (circle and
//! slider-head auto-miss, plus a spinner's final result), then one drain
//! deciding nested ticks/repeats/tail and the classic aggregate. ties
//! inside a phase resolve in beatmap order.
//!
//! presses occur only at frame times with the cursor at that frame's
//! position (frame-accurate playback: `MousePositionAbsoluteInput` precedes
//! `ReplayState` in `CollectPendingInputs`). two buttons newly down in one
//! frame are two presses, left first (`press_edges`'s replay order)

pub(crate) mod presses;
pub mod score;
pub(crate) mod slider;
pub(crate) mod spinner;

use std::cell::Cell;

use crate::beatmap::difficulty::HitGrade;
use crate::beatmap::slider_events::TAIL_LENIENCY;
use crate::beatmap::{NestedKind, ProcessedBeatmap, ProcessedKind};
use crate::error::{resource_limit, EngineError, Result};
use crate::limits;
use crate::replay::frames::ReplayFrame;
use crate::replay::interpolation::{cursor_state_at, press_edges, CursorSample};
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

#[derive(Debug, Clone, PartialEq)]
pub struct JudgementTimeline {
    pub events: Vec<JudgementEvent>,
    pub totals: HitTotals,
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
    /// every slider's object index, computed once so the per-instant
    /// tracking and drain sweeps never walk circles and spinners -- with
    /// half a million objects and millions of instants both inside the
    /// documented caps, a full born-suffix walk per instant multiplies into
    /// crafted-input denial of service. what remains per instant is work
    /// proportional to the born, unfinished sliders, the same set lazer
    /// itself updates every render frame
    pub slider_indices: Vec<usize>,
    /// monotonic cursor into `slider_indices` below which every slider is
    /// permanently finished -- advanced by slider::advance_first_active,
    /// never rewound (`finished()` never reverts to false). keeps
    /// update_tracking_all/drain_pending from re-scanning a settled prefix
    /// at every single instant
    pub first_active_slider: usize,
    /// monotonic lower bound below which every object is permanently
    /// fully judged -- advanced by presses::advance_first_unjudged, never
    /// rewound. safe for the same reason as first_active_slider: fully_judged
    /// never reverts to false once true, so this cursor only ever moves
    /// forward, amortising the total scan cost of the receptor and note-lock
    /// walks in simulation::presses across the whole sweep instead of
    /// re-walking a settled prefix on every single press
    pub first_unjudged: usize,
    /// every spinner's object index, computed once so the frame-instant
    /// rotation sweep never scans the full object list. nothing bounds how
    /// many spinners a map declares (MAX_HIT_OBJECTS admits hundreds of
    /// thousands), so the sweep additionally keeps a finished-prefix cursor
    /// and breaks at the first spinner not yet born -- without those, the
    /// frame-times-spinners product from a crafted file reaches the
    /// trillions
    pub spinner_indices: Vec<usize>,
    /// monotonic cursor into `spinner_indices` below which every spinner is
    /// permanently finished -- advanced by spinner::advance_first_active,
    /// never rewound (`finished` is one-way), mirroring first_active_slider
    pub first_active_spinner: usize,
    /// per-instant walk steps spent so far -- press receptor and note-lock
    /// walks, the slider tracking sweep, the drain's per-slider scan, and
    /// the spinner rotation sweep -- charged against
    /// limits::MAX_SIMULATION_SWEEP_STEPS by the instant loop. a Cell
    /// because check_hittable walks under a shared borrow
    pub sweep_steps: Cell<u64>,
}

impl<'a> Ctx<'a> {
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

    pub fn fully_judged(&self, index: usize) -> bool {
        match &self.states[index] {
            ObjectState::Circle(c) => c.judged,
            ObjectState::Slider(s) => s.finished(),
            ObjectState::Spinner(s) => s.finished,
        }
    }

    /// one per-instant walk step (receptor, note-lock, tracking, drain, or
    /// spinner sweep), charged against limits::MAX_SIMULATION_SWEEP_STEPS
    /// by the instant loop
    pub fn charge_sweep_step(&self) {
        self.sweep_steps.set(self.sweep_steps.get() + 1);
    }

    /// born and not fully judged; with a uniform map preempt an earlier
    /// object is always born whenever a later one is, so candidates at or
    /// before a target reduce to the unjudged test. this deliberately
    /// conflates "alive" with "unjudged", unlike lazer's own AliveObjects
    /// (DrawableRuleset.cs), which keeps a judged object alive through its
    /// fade-out animation. a judged object can never gate or consume a press
    /// itself, but its *presence* in lazer's alive list can still matter:
    /// legacyhitpolicy.cs:44-49 consults only `aliveObjects[index - 1]`, so
    /// a judged-but-still-fading circle occupying that slot shields the
    /// target from an older unjudged stacked object that this definition
    /// finds instead (see TODO.md, "note-lock predecessor lifetime"). every
    /// other use of alive() is unaffected; closing the gap needs a
    /// per-kind/per-result drawable-lifetime model, not a tweak here
    pub fn alive(&self, index: usize, time: f64) -> bool {
        !self.fully_judged(index) && time >= self.beatmap.objects[index].start_time - self.beatmap.preempt
    }

    /// the settled cursor sample at an arbitrary instant, for the
    /// cursor-dependent phase (slider tracking, spinner rotation) in the
    /// sweep. panics only if frames is empty, which simulate() already
    /// rejects before a Ctx is ever built
    pub fn cursor_at(&self, time: f64) -> CursorSample {
        cursor_state_at(self.frames, time).expect("simulate() rejects empty frame lists")
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum Phase {
    Frame(usize),
    Deadline(usize),
}

/// frames must be time-sorted ascending -- `replay::frames::convert_frames`
/// guarantees this for every replay this crate decodes; an empty frame list
/// is rejected below rather than assumed away
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
            ProcessedKind::Slider(s) => ObjectState::Slider(slider::SliderState::new(s.nested.len())),
            ProcessedKind::Spinner(_) => ObjectState::Spinner(spinner::SpinnerState::default()),
        })
        .collect();

    let slider_indices: Vec<usize> = beatmap
        .objects
        .iter()
        .enumerate()
        .filter(|(_, obj)| matches!(obj.kind, ProcessedKind::Slider(_)))
        .map(|(i, _)| i)
        .collect();

    let spinner_indices: Vec<usize> = beatmap
        .objects
        .iter()
        .enumerate()
        .filter(|(_, obj)| matches!(obj.kind, ProcessedKind::Spinner(_)))
        .map(|(i, _)| i)
        .collect();

    let mut ctx = Ctx {
        beatmap,
        frames,
        states,
        score: ScoreState::default(),
        events: Vec::new(),
        slider_indices,
        first_active_slider: 0,
        first_unjudged: 0,
        spinner_indices,
        first_active_spinner: 0,
        sweep_steps: Cell::new(0),
    };

    // merged instants: frames (phase 0 at a timestamp) then deadlines (phase 1)
    let mut instants: Vec<(f64, u8, Phase)> = Vec::new();
    for (i, frame) in frames.iter().enumerate() {
        instants.push((frame.time, 0, Phase::Frame(i)));
    }
    for (i, obj) in beatmap.objects.iter().enumerate() {
        match &obj.kind {
            ProcessedKind::Circle => {
                instants.push((obj.start_time + beatmap.windows.meh(), 1, Phase::Deadline(i)));
            }
            ProcessedKind::Slider(s) => {
                // head auto-miss, same boundary as a plain circle's
                instants.push((obj.start_time + beatmap.windows.meh(), 1, Phase::Deadline(i)));
                // each tick/repeat's own due time (head and tail are handled
                // by the two entries around them instead)
                for nested in &s.nested {
                    if matches!(nested.kind, NestedKind::Tick | NestedKind::Repeat) {
                        instants.push((nested.time, 1, Phase::Deadline(i)));
                    }
                }
                // tail leniency window open, then its close/aggregate instant
                instants.push((obj.end_time + TAIL_LENIENCY, 1, Phase::Deadline(i)));
                instants.push((obj.end_time, 1, Phase::Deadline(i)));
            }
            ProcessedKind::Spinner(_) => {
                // the spinner-end deadline: drawablespinner.cs:247-273
                instants.push((obj.end_time, 1, Phase::Deadline(i)));
            }
        }
    }
    instants.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));

    let presses = press_edges(frames);
    let mut press_cursor = 0usize;

    // instants sharing a timestamp are handled as one group. every frame
    // entry gets its own full update cycle -- presses, spinner segment,
    // tracking sweep, drain -- because that is lazer's frame-stability
    // shape: framedreplayinputhandler.cs:138-146 advances one replay frame
    // per step and framestabilitycontainer.cs:107-122 runs a full update
    // per step, so duplicate-timestamp frames each observe their OWN
    // cursor sample, not the settled last-at-timestamp sample. deadline
    // entries have no lazer-side update of their own (lazer decides them
    // inside the checkforresult of whatever update is current), so their
    // group shares one settled-sample sweep and one drain -- running those
    // per duplicate deadline entry would multiply the sweeps' cost by the
    // number of same-time entries (every slider sharing a start time
    // contributes an identical deadline instant, which a crafted map turns
    // quadratic). the sweep-step budget bounds what either shape can spend
    let mut group_start = 0usize;
    while group_start < instants.len() {
        let time = instants[group_start].0;
        let mut group_end = group_start + 1;
        let mut has_deadline = matches!(instants[group_start].2, Phase::Deadline(_));
        let mut has_frame = matches!(instants[group_start].2, Phase::Frame(_));
        while group_end < instants.len() && instants[group_end].0 == time {
            has_deadline |= matches!(instants[group_end].2, Phase::Deadline(_));
            has_frame |= matches!(instants[group_end].2, Phase::Frame(_));
            group_end += 1;
        }

        // phase 1: one full update cycle per frame entry, in frame order
        for &(_, _, phase) in &instants[group_start..group_end] {
            if let Phase::Frame(frame_index) = phase {
                // this frame's own sample, not cursor_at(time): with
                // duplicate timestamps the latter would resolve every
                // entry to the last frame's state
                let sample = CursorSample {
                    pos: frames[frame_index].pos,
                    buttons: frames[frame_index].buttons,
                };
                while press_cursor < presses.len() && presses[press_cursor].frame_index <= frame_index {
                    let press = presses[press_cursor];
                    if press.frame_index == frame_index {
                        presses::handle_press(&mut ctx, press.time, press.action, sample);
                    }
                    press_cursor += 1;
                }
                spinner::process_frame_segment(&mut ctx, frame_index);
                slider::update_tracking_all_with_cursor(&mut ctx, time, sample);
                slider::drain_pending(&mut ctx, time);
                // checked per frame entry rather than per group: a group
                // can hold arbitrarily many zero-delta frames, so a
                // per-group check would let one group overshoot unboundedly
                if ctx.sweep_steps.get() > sweep_budget {
                    return Err(resource_limit(
                        "MAX_SIMULATION_SWEEP_STEPS",
                        sweep_budget,
                        ctx.sweep_steps.get(),
                    ));
                }
            }
        }

        if !has_deadline {
            group_start = group_end;
            continue;
        }

        // phase 2: the settled-sample slider sweep, deadline-only
        // timestamps only -- the interpolated cursor keeps moving between
        // frames, so such a timestamp must resample. after a frame entry at
        // this same timestamp, tracking already reflects the settled state
        // (the last frame's own sample IS the settled sample), and running
        // a second update here would diverge from lazer's one-update-per-
        // frame shape: update_tracking_with_validity reads last_pressed_*
        // as the previous update's buttons, so a same-time re-run would see
        // this frame's freshly written buttons as if a frame had elapsed
        // and could start the any-key acceptance window one frame early
        if !has_frame {
            slider::update_tracking_all(&mut ctx, time);
        }

        // phase 3: due deadlines
        for &(_, _, phase) in &instants[group_start..group_end] {
            let Phase::Deadline(object_index) = phase else {
                continue;
            };
            let circle_due = matches!(&ctx.states[object_index], ObjectState::Circle(c) if !c.judged);
            if circle_due {
                // presses at this same instant already ran (phase order
                // above); past it the window is unreachable, so the miss
                // is fact -- recorded at the scheduled boundary per this
                // module's event-time conventions
                match &mut ctx.states[object_index] {
                    ObjectState::Circle(c) => c.judged = true,
                    _ => unreachable!("circle_due only matches ObjectState::Circle"),
                }
                ctx.emit(time, object_index, JudgementKind::Circle(HitGrade::Miss));
            }

            let start = ctx.beatmap.objects[object_index].start_time;
            let head_due = time >= start + ctx.beatmap.windows.meh()
                && matches!(&ctx.states[object_index], ObjectState::Slider(s) if !s.head_judged());
            if head_due {
                slider::judge_nested(&mut ctx, object_index, 0, time, false);
            }

            let spinner_due = time >= ctx.beatmap.objects[object_index].end_time
                && matches!(&ctx.states[object_index], ObjectState::Spinner(s) if !s.finished);
            if spinner_due {
                spinner::finalize(&mut ctx, object_index, time);
            }
        }

        // phase 4: slider nested-object drain and classic aggregate, once
        // per deadline group
        slider::drain_pending(&mut ctx, time);
        if ctx.sweep_steps.get() > sweep_budget {
            return Err(resource_limit(
                "MAX_SIMULATION_SWEEP_STEPS",
                sweep_budget,
                ctx.sweep_steps.get(),
            ));
        }

        group_start = group_end;
    }

    let totals = HitTotals {
        count_300: ctx.score.count_300,
        count_100: ctx.score.count_100,
        count_50: ctx.score.count_50,
        count_miss: ctx.score.count_miss,
        max_combo: ctx.score.max_combo,
    };
    Ok(JudgementTimeline {
        events: ctx.events,
        totals,
    })
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
            overall_difficulty: 5.0, // windows 49.5 / 99.5 / 149.5
            approach_rate: 9.0,      // preempt 600
            slider_multiplier: 1.4,
            slider_tick_rate: 1.0,
            combo_colors: Vec::new(),
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
                kind: HitObjectKind::Circle,
            },
            linear_slider(2000.0, Vec2::new(100.0, 100.0), 100.0, 0),
            HitObject {
                start_time: 4000.0,
                pos: Vec2::ZERO,
                new_combo: false,
                combo_offset: 0,
                kind: HitObjectKind::Spinner { duration: 2000.0 },
            },
            HitObject {
                start_time: 6500.0,
                pos: Vec2::new(256.0, 192.0),
                new_combo: false,
                combo_offset: 0,
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
    /// button edges are unambiguous
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
        // 40 same-start circles far from the cursor: every press walks all
        // 40 born, unjudged receptors and consumes nothing, so each press
        // charges exactly 40 steps and nothing else charges at all (no
        // sliders or spinners, so the tracking, drain, and spinner sweeps
        // iterate nothing; an unconsumed press never reaches the note-lock
        // walks). 25 presses land exactly on a budget of 1000
        let circles: Vec<(f64, f32, f32)> = (0..40).map(|i| (5000.0, i as f32 * 8.0, 0.0)).collect();
        let beatmap = circle_map(&circles);

        // born from 4400 (preempt 600); alternating frames every 2ms from
        // 4402 produce one left-press edge per held frame, all before any
        // judgement deadline
        let mut raw_frames = Vec::new();
        for press in 0..25 {
            let t = 4402.0 + press as f64 * 4.0;
            raw_frames.push(frame(t, 5000.0, 5000.0, Buttons::LEFT_1));
            raw_frames.push(frame(t + 2.0, 5000.0, 5000.0, 0));
        }
        let frames = wrap(raw_frames);

        let timeline = simulate_with_sweep_budget(&beatmap, &frames, 1000).unwrap();
        assert_eq!(timeline.totals.count_miss, 40); // nothing was ever hit

        match simulate_with_sweep_budget(&beatmap, &frames, 999) {
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
        for (offset, expected) in [
            (49.0, JudgementKind::Circle(HitGrade::Great)),
            (50.0, JudgementKind::Circle(HitGrade::Ok)),
            (100.0, JudgementKind::Circle(HitGrade::Meh)),
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
    fn an_unclicked_circle_misses_when_the_meh_window_closes() {
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(&beatmap, &wrap(vec![])).unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        // convention: the miss lands exactly when can_be_hit turns false
        assert_eq!(timeline.events[0].time, 1000.0 + 149.5);
        assert_eq!(timeline.totals.count_miss, 1);
    }

    #[test]
    fn a_press_far_outside_the_miss_window_shakes_and_consumes_nothing_judgeable() {
        // result_for is none past 400ms -> policy shake, no judgement; the
        // circle still misses on its own later
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(&beatmap, &wrap(vec![frame(400.0, 256.0, 192.0, Buttons::LEFT_1)])).unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
        assert_eq!(timeline.events[0].time, 1149.5);
    }

    #[test]
    fn note_lock_shakes_a_later_circle_while_an_earlier_one_is_hittable() {
        // legacyhitpolicy.cs:54-67: b is blocked while a (endtime + 3 < b's
        // start) is alive and unjudged; the press is consumed by b's receptor
        // and judges nothing. spacing keeps a's meh window (closing 1349.5)
        // open across the first press and closed before the second
        let beatmap = circle_map(&[(1200.0, 100.0, 100.0), (1300.0, 300.0, 100.0)]);
        let timeline = simulate(
            &beatmap,
            &wrap(vec![
                frame(1250.0, 300.0, 100.0, Buttons::LEFT_1), // blocked: a unjudged
                frame(1260.0, 300.0, 100.0, 0),
                frame(1360.0, 300.0, 100.0, Buttons::LEFT_1), // a missed at 1349.5 -> b hittable
            ]),
        )
        .unwrap();
        let b_events: Vec<_> = timeline.events.iter().filter(|e| e.object_index == 1).collect();
        assert_eq!(b_events.len(), 1);
        assert_eq!(b_events[0].kind, JudgementKind::Circle(HitGrade::Ok)); // 60ms late
        assert_eq!(b_events[0].time, 1360.0);
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
    fn two_buttons_in_one_frame_are_two_presses_left_first() {
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
        // left press hits circle 0 (great), right press falls through to
        // circle 1 (49ms early -> still great at od5)
        assert_eq!(timeline.events.len(), 2);
        assert_eq!(timeline.events[0].object_index, 0);
        assert_eq!(timeline.events[1].object_index, 1);
        assert_eq!(timeline.events[1].kind, JudgementKind::Circle(HitGrade::Great));
    }

    #[test]
    fn a_press_off_every_circle_hits_nothing() {
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let timeline = simulate(&beatmap, &wrap(vec![frame(1000.0, 500.0, 50.0, Buttons::LEFT_1)])).unwrap();
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Miss));
    }

    #[test]
    fn previous_object_already_judged_does_not_block_the_press() {
        // legacyhitpolicy.cs:44-49: the note-lock gate only fires while the
        // stacked previous object is still alive; once it is judged, the
        // backward search for a blocking predecessor comes up empty and the
        // press proceeds normally
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
                frame(1290.0, 256.0, 192.0, Buttons::LEFT_1), // circle 0 is judged, so circle 1 proceeds
            ]),
        )
        .unwrap();
        let judged: Vec<_> = timeline.events.iter().map(|e| e.object_index).collect();
        assert_eq!(judged[0], 0);
        assert_eq!(judged[1], 1);
    }

    #[test]
    fn stacked_unjudged_previous_object_ignores_the_press() {
        // legacyhitpolicy.cs:44-49: the object immediately before the target
        // (alive, unjudged, stack height > 0) swallows the press entirely --
        // no shake, no judgement -- even though it sits nowhere near the
        // cursor: the gate is index/state-based, not geometric
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
        // the press is swallowed entirely: every object still auto-misses on
        // its own deadline, none of them from the press itself
        assert_eq!(timeline.events.len(), 3);
        for e in &timeline.events {
            assert_eq!(e.kind, JudgementKind::Circle(HitGrade::Miss));
        }
        assert_eq!(timeline.events[0].object_index, 0);
        assert_eq!(timeline.events[0].time, 1200.0 + 149.5);
        assert_eq!(timeline.events[1].object_index, 1);
        assert_eq!(timeline.events[1].time, 1250.0 + 149.5);
        assert_eq!(timeline.events[2].object_index, 2);
        assert_eq!(timeline.events[2].time, 1290.0 + 149.5);
    }

    #[test]
    fn a_mixed_map_produces_the_exact_hand_derived_timeline() {
        // map: circle at 1000 (256,192) -- slider at 2000 (100,100), length
        // 100, tick rate 2 (one tick) -- spinner 4000-6000 -- circle at 6500
        // replay: hit everything cleanly
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
    fn presses_at_a_deadline_instant_resolve_before_the_deadline() {
        // a press exactly at start + meh is inside the (inclusive) meh window
        // and must land before the auto-miss deadline at the same timestamp.
        // window edges are half-integral, so force the press onto the
        // boundary with a fractional frame time -- unreachable from real
        // .osr input but exactly what pins the phase order
        let beatmap = circle_map(&[(1000.0, 256.0, 192.0)]);
        let meh = beatmap.windows.meh();
        let timeline = simulate(
            &beatmap,
            &wrap(vec![frame(1000.0 + meh, 256.0, 192.0, Buttons::LEFT_1)]),
        )
        .unwrap();
        assert_eq!(timeline.events.len(), 1);
        assert_eq!(timeline.events[0].kind, JudgementKind::Circle(HitGrade::Meh));
    }
}
