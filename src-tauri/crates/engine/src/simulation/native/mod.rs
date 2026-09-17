//! the native profile's walk: lazer's own gameplay over (processed beatmap,
//! replay frames), the second walk behind the rules profile. the stable
//! walk in the parent module ports stable; this one ports the pinned lazer
//! checkout's default osu! gameplay -- what a lazer-written NoMod replay
//! was actually judged under -- and is pinned element for element against
//! the no-mod judgement dumps in `fixtures/judgement/`.
//!
//! # the update cadence
//!
//! lazer judges inside `FrameStabilityContainer`'s update loop, and the
//! replay handler decides which instants that loop may visit
//! (framedreplayinputhandler.cs:113-160): the clock always lands on every
//! replay frame's own time, and otherwise `SetFrameFromTime` clamps the
//! proposed time into the current frame span and hands it straight back, so
//! every instant in that span is one the loop may land on. the display rate
//! sets the cadence within it, which no replay records; this walk takes the
//! limit of an arbitrarily fast display, visiting every instant at which
//! something can change: every frame (duplicated timestamps as separate
//! updates, in order, since `SetFrameFromTime` steps one frame per call),
//! every circle timeout, nested element time, tail leniency point and end
//! time. an update that leaves a judgement pending on the next update (a
//! slider whose tail judged this update, a tail whose last tick did) is
//! followed by another at the same instant, which is where the next display
//! frame would have landed.
//!
//! the handler's **important section** -- a pressed frame forbidding every
//! time strictly inside the 20ms before its successor -- is NOT modelled,
//! and that is a port decision rather than an omission. the gate reads
//! `FrameAccuratePlayback` (framedreplayinputhandler.cs:78,110), a public
//! field the game assigns nowhere: the only assignment in the whole
//! checkout is in `FramedReplayInputHandlerTest`. so `inImportantSection` is
//! always false in a real client, `SetFrameFromTime` never returns null for
//! that reason, and a walk that honours the rule refuses instants lazer
//! visits. it was modelled here until 2026-09-17, and refusing them cost
//! slider tails: a tail's leniency point (`end - 36`) falls inside a frame
//! span far more often than not, and deferring it to the next frame samples
//! tracking up to a frame late, by which time the follow circle has moved
//! on. measured against the pinned client over the native corpus, that one
//! rule was the whole of the tail divergence (`docs/engine-parity.md`).
//!
//! within one update the order is lazer's: input first (the cursor's
//! position, then releases, then presses in list order, each press taken
//! by the earliest hoverable unjudged circle or slider head and consumed
//! whether it hit or was shaken), then the hit-object container's update
//! with LATER objects first (hitobjectcontainer.cs:179-187 sorts earlier
//! objects to the end so they take input first, and updates run in list
//! order), and inside a slider its own result, its input manager, then
//! ticks, repeats, the tail and last the head (drawableslider.cs:100-124).
//!
//! # what a judgement's time means
//!
//! a press-triggered judgement lands at the frame's time; a timeout at the
//! window's own edge (lazer's `TimeAbsolute` clamps the raw update time to
//! the judgement offset, so the recorded time is the edge whichever update
//! crossed it); a nested element's at its own time. the dumps this walk is
//! pinned against record no times at all -- they are the one thing lazer's own
//! cadence does not fix -- so the pin is order, result and combo.
//!
//! # the sub-frame limit
//!
//! three things lazer's real cadence can decide differently from this limit,
//! all sub-display-frame and all stated here rather than modelled: a
//! cursor that interpolates into a slider's follow area between two frames
//! and out again before the next re-arms the tail in lazer at whichever
//! display frame saw it, and here only at an instant the walk visits; two
//! judgements a real display frame batches into one update apply in
//! container order there and in deadline order here, which leaves the
//! result multiset identical but can order a combo reset against a combo
//! increment differently. that moves `max_combo` by one AND shifts
//! `total_score`: the combo portion is scored off the combo each judgement
//! LEAVES (`scoring.rs`'s `combo_portion`, scoreprocessor.cs:344), so the
//! pair scores differently and the running combo stays off by one for every
//! scorable judgement until the next break -- both are native oracle fields
//! (`NATIVE_FIELD_NAMES`), so triage should expect the pair, not one; and a
//! spinner's rotation accumulates once per display frame, so a bonus tick
//! either side of the last sample falls one way in lazer and the other
//! here.
//!
//! `SliderInputManager`'s accepted-key unlock is NOT among them, though it
//! reads like it should be. it is a THREE-PASS rule in lazer -- the arming
//! test reads `lastPressedActions`, which each pass fills at its own END
//! (sliderinputmanager.cs:252-261), so one pass must OBSERVE the other key
//! released, a second arms `timeToAcceptAnyKeyAfter`, and only a third
//! accepts any key (cs:286's `Time.Current <= ...` keeps the arming pass
//! itself restricted). lazer pays that over three display frames, a few ms,
//! and a walk paying it over three of the instants IT visits would charge
//! up to two whole replay frames. so this walk takes that rule's own
//! fast-display limit instead, reading the CURRENT pass's pressed set
//! (`slider.rs`'s note at `update_tracking`), which converges on the same
//! behaviour as the display rate rises. measured over 65 native corpus
//! pairs, taking the limit moved nothing at all: the rule is real, and it
//! was never what the tail divergences were made of.
//!
//! the walk emits the timeline kinds of `simulation::score` and folds
//! lazer's own score processor beside them (`scoring`), so the totals carry
//! the standardised accuracy and rank and the outcome the statistics map

pub mod export;
pub mod health;
pub(crate) mod scoring;
pub(crate) mod slider;
pub(crate) mod spinner;

use crate::beatmap::difficulty::{HitGrade, MISS_WINDOW};
use crate::beatmap::{NestedKind, ProcessedBeatmap, ProcessedKind, ProcessedObject, ProcessedSlider};
use crate::error::{resource_limit, EngineError, Result};
use crate::limits;
use crate::math::Vec2;
use crate::replay::frames::{Buttons, ReplayFrame};
use crate::replay::interpolation::{cursor_state_at, OsuAction};
use crate::score::{rank_from_accuracy, HitResult, ScoreStep};
use crate::simulation::score::JudgementKind;
use crate::simulation::{HitTotals, JudgementEvent, JudgementTimeline};
use scoring::NativeScore;
use slider::{nested_result, nested_verdict, NestedVerdict, SliderRun};
use spinner::SpinnerRun;

/// osuhitobject.cs:29,94 -- the radius scale multiplies
const OBJECT_RADIUS: f32 = 64.0;

/// drawablehitcircle.cs:214 -- a judged circle stays alive this long past
/// its judgement time, which is how long it can still be the last blocking
/// object the hit policy consults
const CIRCLE_LIFETIME_AFTER_JUDGEMENT: f64 = 800.0;

/// drawableslider.cs:355-365 and drawablespinner.cs:71 -- the fade a judged
/// slider or spinner expires with
const SLIDER_LIFETIME_AFTER_JUDGEMENT: f64 = 240.0;
const SPINNER_LIFETIME_AFTER_JUDGEMENT: f64 = 240.0;

/// the two gameplay buttons a frame holds, in the list order lazer builds
/// (osureplayframe.cs: left added before right)
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct Actions {
    pub left: bool,
    pub right: bool,
}

impl Actions {
    fn from_buttons(buttons: Buttons) -> Actions {
        Actions {
            left: buttons.left(),
            right: buttons.right(),
        }
    }

    pub fn contains(self, action: OsuAction) -> bool {
        match action {
            OsuAction::Left => self.left,
            OsuAction::Right => self.right,
        }
    }

    pub fn any(self) -> bool {
        self.left || self.right
    }

    pub fn iter(self) -> impl Iterator<Item = OsuAction> {
        [(self.left, OsuAction::Left), (self.right, OsuAction::Right)]
            .into_iter()
            .filter(|(down, _)| *down)
            .map(|(_, action)| action)
    }
}

/// what lazer's score processor derived beyond the four counts on the
/// totals: the statistics map in the block's own vocabulary and order, the
/// perfect play's maximum statistics, the standardised total, the running
/// total at every moment it MOVED -- the score curve, in the stable fold's
/// wire shape, and see its own doc for why that is not "every scorable
/// result" -- and the full applied sequence the fold ran over
#[derive(Debug, Clone, PartialEq)]
pub struct NativeOutcome {
    pub statistics: Vec<(HitResult, u32)>,
    pub maximum_statistics: Vec<(HitResult, u32)>,
    pub total_score: i64,
    /// one step per result that MOVED the total, at that result's own time.
    /// that is deliberately not "per scorable result": a dropped slider tail
    /// is an ignore miss scoring nothing of its own, yet its MAXIMUM is a
    /// SliderTailHit that still weighs in accuracy's denominator, so the
    /// total falls on a result `is_scorable()` answers false for. the last
    /// step is the total, pinned on every scenario and every corpus play
    pub score_curve: Vec<ScoreStep>,
    /// every result the fold applied, in order, event-bearing or not (an
    /// unreached spinner tick has no timeline event but counts): what a
    /// refold up to a fail point runs over
    pub applied: Vec<AppliedResult>,
}

/// one applied result and the timeline event it produced, if any; a
/// spinner's unreached ticks arrive as one record standing for `count`
/// results, since their number is bounded by nothing but the spinner's
/// duration and each is the same ignore miss at its own maximum
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AppliedResult {
    pub time: f64,
    pub result: HitResult,
    pub max_result: HitResult,
    pub event_index: Option<usize>,
    /// how many times the result applied: 1 for every result but a
    /// spinner's unreached tick group
    pub count: u32,
}

/// the outcome lazer's score processor would have recorded had the play
/// failed at `fail_event_index`: every result up to and including the
/// failing one counts, nothing after (scoreprocessor.cs:244-245 skips a
/// result flagged as failed-at-judgement, and healthprocessor.cs:48 flags
/// every result after the one that failed). the maximum statistics are the
/// map's and never truncate. the rank such a play takes is F, which the
/// caller supplies: this value is the fold's reading and carries no rank of
/// its own. none when the timeline has no
/// native fold, and none when no applied result produced the index: the
/// full fold would pass for a truncation otherwise
pub fn outcome_up_to(beatmap: &ProcessedBeatmap, timeline: &JudgementTimeline, fail_event_index: usize) -> Option<TruncatedOutcome> {
    let native = timeline.native.as_ref()?;
    let mut fold = NativeScore::for_beatmap(beatmap);
    let mut reached = false;
    for applied in &native.applied {
        fold.apply_repeated(applied.result, applied.max_result, applied.count);
        if applied.event_index == Some(fail_event_index) {
            reached = true;
            break;
        }
    }
    if !reached {
        return None;
    }
    let accuracy = fold.accuracy();
    Some(TruncatedOutcome {
        statistics: fold.statistics(),
        maximum_statistics: fold.maximum_statistics(),
        max_combo: fold.highest_combo,
        total_score: fold.total_score(),
        accuracy,
        count_miss: fold.count(HitResult::Miss),
    })
}

/// the fold's reading at a fail point
#[derive(Debug, Clone, PartialEq)]
pub struct TruncatedOutcome {
    pub statistics: Vec<(HitResult, u32)>,
    pub maximum_statistics: Vec<(HitResult, u32)>,
    pub max_combo: u32,
    pub total_score: i64,
    pub accuracy: f64,
    pub count_miss: u32,
}

#[derive(Debug, Clone, Copy)]
struct Judged {
    result: HitResult,
    time: f64,
}

struct ObjectRun {
    own: Option<Judged>,
    /// one slot per nested element of a slider, in its nested list's order;
    /// a spinner keeps none, its ticks being counted by its run rather than
    /// materialised, since their number is bounded by nothing but its
    /// duration
    nested: Vec<Option<Judged>>,
    kind: RunKind,
}

enum RunKind {
    Circle,
    Slider(SliderRun),
    Spinner(SpinnerRun),
}

impl ObjectRun {
    fn all_judged(&self) -> bool {
        self.own.is_some() && self.nested.iter().all(Option::is_some)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ClickAction {
    Shake,
    Hit,
}

enum Instant {
    Frame(usize),
    Deadline(f64),
}

struct Walk<'a> {
    beatmap: &'a ProcessedBeatmap,
    frames: &'a [ReplayFrame],
    radius: f32,
    runs: Vec<ObjectRun>,
    /// lazer's alive list: born objects not yet expired, in start order
    alive: Vec<usize>,
    next_born: usize,
    score: NativeScore,
    events: Vec<JudgementEvent>,
    score_curve: Vec<ScoreStep>,
    applied_results: Vec<AppliedResult>,
    /// the input state's last position, for the change a mouse-move event
    /// fires on
    prev_pos: Option<Vec2>,
    prev_actions: Actions,
    /// results applied so far, hit or miss, event or not -- the fixpoint
    /// test for repeating an update at one instant
    applied: u64,
    steps: u64,
    budget: u64,
}

/// the native profile's walk over time-sorted frames; an empty frame list
/// is rejected rather than assumed away, as the stable walk rejects it
pub fn simulate_native(beatmap: &ProcessedBeatmap, frames: &[ReplayFrame]) -> Result<JudgementTimeline> {
    simulate_native_with_budget(beatmap, frames, limits::MAX_SIMULATION_SWEEP_STEPS)
}

/// the sweep-step budget as a parameter, so its boundary test can drive the
/// cap with a small input
pub(crate) fn simulate_native_with_budget(
    beatmap: &ProcessedBeatmap,
    frames: &[ReplayFrame],
    budget: u64,
) -> Result<JudgementTimeline> {
    if frames.is_empty() {
        return Err(EngineError::InvalidArgument(
            "cannot simulate a replay with no frames".into(),
        ));
    }
    let runs = beatmap
        .objects
        .iter()
        .map(|obj| match &obj.kind {
            ProcessedKind::Circle => ObjectRun {
                own: None,
                nested: Vec::new(),
                kind: RunKind::Circle,
            },
            ProcessedKind::Slider(slider) => ObjectRun {
                own: None,
                nested: vec![None; slider.nested.len()],
                kind: RunKind::Slider(SliderRun::new(slider)),
            },
            ProcessedKind::Spinner(spinner) => ObjectRun {
                own: None,
                nested: Vec::new(),
                kind: RunKind::Spinner(SpinnerRun::new(spinner)),
            },
        })
        .collect();
    let deadlines = collect_deadlines(beatmap);
    let mut walk = Walk {
        beatmap,
        frames,
        radius: OBJECT_RADIUS * beatmap.scale,
        runs,
        alive: Vec::new(),
        next_born: 0,
        score: NativeScore::for_beatmap(beatmap),
        events: Vec::new(),
        score_curve: Vec::new(),
        applied_results: Vec::new(),
        prev_pos: None,
        prev_actions: Actions::default(),
        applied: 0,
        steps: 0,
        budget,
    };
    walk.run(&deadlines)?;

    let accuracy = walk.score.accuracy();
    let count_miss = walk.score.count(HitResult::Miss);
    let totals = HitTotals {
        count_300: walk.score.count(HitResult::Great),
        count_100: walk.score.count(HitResult::Ok),
        count_50: walk.score.count(HitResult::Meh),
        count_miss,
        max_combo: walk.score.highest_combo,
        accuracy,
        rank: rank_from_accuracy(accuracy, count_miss),
    };
    Ok(JudgementTimeline {
        events: walk.events,
        totals,
        spinner_scoring: Vec::new(),
        native: Some(NativeOutcome {
            statistics: walk.score.statistics(),
            maximum_statistics: walk.score.maximum_statistics(),
            total_score: walk.score.total_score(),
            score_curve: walk.score_curve,
            applied: walk.applied_results,
        }),
    })
}

/// every instant at which a judgement can fall due without input: circle
/// and head timeouts at the meh window's edge (hitwindows.cs:109), nested
/// element times, the tail's leniency point, and end times
fn collect_deadlines(beatmap: &ProcessedBeatmap) -> Vec<f64> {
    let meh = beatmap.windows.meh();
    let mut deadlines = Vec::new();
    for obj in &beatmap.objects {
        match &obj.kind {
            ProcessedKind::Circle => deadlines.push(obj.start_time + meh),
            ProcessedKind::Slider(slider) => {
                deadlines.push(obj.start_time + meh);
                deadlines.extend(slider.nested.iter().map(|n| n.time));
                deadlines.push(obj.end_time + slider::TAIL_LENIENCY);
                deadlines.push(obj.end_time);
            }
            ProcessedKind::Spinner(_) => deadlines.push(obj.end_time),
        }
    }
    deadlines.retain(|t| t.is_finite());
    deadlines.sort_by(|a, b| a.total_cmp(b));
    deadlines.dedup();
    deadlines
}

/// hitwindows.cs:82-93 as the native vocabulary
fn grade_result(grade: HitGrade) -> HitResult {
    match grade {
        HitGrade::Great => HitResult::Great,
        HitGrade::Ok => HitResult::Ok,
        HitGrade::Meh => HitResult::Meh,
        HitGrade::Miss => HitResult::Miss,
    }
}

fn result_grade(result: HitResult) -> HitGrade {
    match result {
        HitResult::Great => HitGrade::Great,
        HitResult::Ok => HitGrade::Ok,
        HitResult::Meh => HitGrade::Meh,
        _ => HitGrade::Miss,
    }
}

/// drawablespinner.cs:261-274 -- the grade the spinner takes at its end
fn spinner_result(progress: f32) -> HitResult {
    let progress = f64::from(progress);
    if progress >= 1.0 {
        HitResult::Great
    } else if progress > 0.9 {
        HitResult::Ok
    } else if progress > 0.75 {
        HitResult::Meh
    } else {
        HitResult::Miss
    }
}

/// a strict "past the threshold" test that reads true at the threshold
/// itself when the walk stands at a deadline instant, which is the limit of
/// the first update after it
fn past(time: f64, at_deadline: bool, threshold: f64) -> bool {
    time > threshold || (at_deadline && time >= threshold)
}

fn slider_of(obj: &ProcessedObject) -> &ProcessedSlider {
    match &obj.kind {
        ProcessedKind::Slider(slider) => slider,
        _ => unreachable!("slider_of is only called for slider objects"),
    }
}

impl<'a> Walk<'a> {
    fn run(&mut self, deadlines: &[f64]) -> Result<()> {
        let mut next_deadline = 0usize;
        for frame_index in 0..self.frames.len() {
            let frame_time = self.frames[frame_index].time;
            // the deadlines strictly between the previous frame and this
            // one, each at its own time: `SetFrameFromTime` clamps the
            // proposed time into `[frameStart, frameEnd]` and hands it back
            // (framedreplayinputhandler.cs:160), so every instant in the
            // open span is one the update loop may land on
            while next_deadline < deadlines.len() && deadlines[next_deadline] < frame_time {
                let deadline = deadlines[next_deadline];
                next_deadline += 1;
                self.process(Instant::Deadline(deadline))?;
            }
            self.process(Instant::Frame(frame_index))?;

            // a deadline on this frame's own time falls due at the first
            // instant past it -- after every frame at this time, a strict
            // threshold reading false at the frame itself (hitwindows.cs
            // `CanBeHit` admits the edge); past the last frame the loop
            // below resolves it
            let next_frame_time = self.frames.get(frame_index + 1).map(|f| f.time);
            if next_frame_time.is_some_and(|next| next == frame_time) {
                continue;
            }
            while next_deadline < deadlines.len() && deadlines[next_deadline] == frame_time {
                if next_frame_time.is_none() {
                    break;
                }
                next_deadline += 1;
                self.process(Instant::Deadline(frame_time))?;
            }
        }

        // past the last frame the handler's end frame IS the last frame, so
        // `frameEnd` is positive infinity and the clamp is a no-op: time
        // runs on freely and every remaining deadline is usable at its own
        // time, including one on the last frame's own
        while next_deadline < deadlines.len() {
            let deadline = deadlines[next_deadline];
            next_deadline += 1;
            self.process(Instant::Deadline(deadline))?;
        }
        Ok(())
    }

    /// one update of the stability container at one instant
    fn process(&mut self, instant: Instant) -> Result<()> {
        let (time, pos, actions, at_deadline) = match instant {
            Instant::Frame(index) => {
                let frame = &self.frames[index];
                (frame.time, frame.pos, Actions::from_buttons(frame.buttons), false)
            }
            Instant::Deadline(time) => {
                let sample = cursor_state_at(self.frames, time).expect("emptiness rejected above");
                (time, sample.pos, Actions::from_buttons(sample.buttons), true)
            }
        };

        // the container's lifetime pass as the display frames before this
        // instant would have run it: objects whose lifetime began strictly
        // before now are alive for this instant's input, objects whose fade
        // ended strictly before now are gone; a lifetime edge landing
        // exactly on this instant is applied by this instant's own update,
        // after its input
        self.born(time, true);
        self.expire(time, true);

        // input: the cursor's position reaches the spinner trackers as a
        // mouse-move event, which fires on a change only; releases carry no
        // gameplay effect; presses are dispatched in list order
        if self.prev_pos != Some(pos) {
            for &index in &self.alive {
                if let RunKind::Spinner(run) = &mut self.runs[index].kind {
                    run.on_mouse_move(pos);
                }
            }
        }
        let previous = self.prev_actions;
        self.prev_pos = Some(pos);
        self.prev_actions = actions;
        for action in actions.iter() {
            if !previous.contains(action) {
                self.dispatch_press(time, pos, actions, action);
            }
        }

        self.born(time, false);
        self.expire(time, false);

        // the update pass, repeated at the same instant while it keeps
        // producing results: each repeat is the next display frame in the
        // limit this walk takes
        loop {
            let applied_before = self.applied;
            self.update_alive(time, at_deadline, pos, actions);
            if self.applied == applied_before {
                break;
            }
        }

        if self.steps > self.budget {
            return Err(resource_limit("MAX_SIMULATION_SWEEP_STEPS", self.budget, self.steps));
        }
        Ok(())
    }

    fn charge(&mut self, steps: u64) {
        self.steps = self.steps.saturating_add(steps);
    }

    /// hitobjectlifetimeentry: alive from `start - preempt`
    /// (drawableosuhitobject.cs:124); `strictly` admits only lifetimes that
    /// began before `time`
    fn born(&mut self, time: f64, strictly: bool) {
        while self.next_born < self.beatmap.objects.len() {
            let lifetime_start = self.beatmap.objects[self.next_born].start_time - self.beatmap.preempt;
            let due = if strictly {
                lifetime_start < time
            } else {
                lifetime_start <= time
            };
            if !due {
                break;
            }
            self.alive.push(self.next_born);
            self.next_born += 1;
        }
    }

    /// a fully judged object leaves the alive list when its fade ends:
    /// `HitStateUpdateTime` plus the kind's fade, where that time is the
    /// judgement's own for a circle and the end time for a slider or
    /// spinner (their judgement offset is clamped to zero).
    ///
    /// `HitStateUpdateTime` is `Result.TimeAbsolute`, which
    /// judgementresult.cs:45,50-53 clamps to the object's end time plus
    /// `MaximumJudgementOffset` -- the miss window for a circle
    /// (hitobject.cs:203, osuhitwindows.cs:19). the clamp is the same one the
    /// other two kinds already carry above; a circle judged at a deferred
    /// instant past that window would otherwise outlive lazer's copy and go
    /// on blocking a later press as the hit policy's earlier object
    fn expire(&mut self, time: f64, strictly: bool) {
        let beatmap = self.beatmap;
        let runs = &self.runs;
        let before = self.alive.len();
        self.alive.retain(|&index| {
            let run = &runs[index];
            if !run.all_judged() {
                return true;
            }
            let obj = &beatmap.objects[index];
            let lifetime_end = match run.kind {
                RunKind::Circle => {
                    run.own
                        .map_or(f64::INFINITY, |j| j.time.min(obj.start_time + MISS_WINDOW))
                        + CIRCLE_LIFETIME_AFTER_JUDGEMENT
                }
                RunKind::Slider(_) => obj.end_time + SLIDER_LIFETIME_AFTER_JUDGEMENT,
                RunKind::Spinner(_) => obj.end_time + SPINNER_LIFETIME_AFTER_JUDGEMENT,
            };
            if strictly {
                time <= lifetime_end
            } else {
                time < lifetime_end
            }
        });
        self.charge(before as u64);
    }

    /// keybindingcontainer propagation: the earliest alive receptor under
    /// the cursor that can still be hit takes the press (hitobjectcontainer
    /// .cs:184 orders earlier objects to handle input first); a judged
    /// receptor lets the press pass (drawablehitcircle.cs:75,279)
    fn dispatch_press(&mut self, time: f64, pos: Vec2, actions: Actions, action: OsuAction) {
        let radius_sq = self.radius * self.radius;
        for i in 0..self.alive.len() {
            let index = self.alive[i];
            self.charge(1);
            let obj = &self.beatmap.objects[index];
            let receptor_free = match &self.runs[index].kind {
                RunKind::Circle => self.runs[index].own.is_none(),
                RunKind::Slider(_) => self.runs[index].nested[0].is_none(),
                RunKind::Spinner(_) => false,
            };
            if !receptor_free {
                continue;
            }
            if (pos - obj.stacked_position).length_squared() > radius_sq {
                continue;
            }
            let head = matches!(self.runs[index].kind, RunKind::Slider(_)).then_some(0usize);
            self.press_circle(index, head, time, pos, actions, action);
            return;
        }
    }

    /// drawablehitcircle.cs:137-173 with the receptor's own bookkeeping
    /// (277-306): the result for the offset, the policy's answer, and the
    /// head's hit action assigned after the judgement ran
    fn press_circle(
        &mut self,
        index: usize,
        head: Option<usize>,
        time: f64,
        pos: Vec2,
        actions: Actions,
        action: OsuAction,
    ) {
        let start_time = self.beatmap.objects[index].start_time;
        let grade = self.beatmap.windows.result_for(time - start_time);
        let click = self.check_hittable(start_time, time, grade.is_some());
        if let (ClickAction::Hit, Some(grade)) = (click, grade) {
            self.judge(index, head, grade_result(grade), HitResult::Great, time);
            if head.is_some() {
                self.post_process_head_judgement(index, time, pos, actions);
            }
        }
        if let RunKind::Slider(run) = &mut self.runs[index].kind {
            if run.head_hit_action.is_none() {
                run.head_hit_action = Some(action);
            }
        }
    }

    /// starttimeorderedhitpolicy.cs:30-54 -- the last alive circle or head
    /// starting before the target blocks a press before its own start time
    /// while unjudged; a press outside every window is shaken too
    fn check_hittable(&mut self, target_start: f64, time: f64, in_a_window: bool) -> ClickAction {
        let mut blocking: Option<(bool, f64)> = None;
        for i in 0..self.alive.len() {
            let index = self.alive[i];
            self.charge(1);
            let obj = &self.beatmap.objects[index];
            if obj.start_time >= target_start {
                break;
            }
            match &self.runs[index].kind {
                RunKind::Circle => blocking = Some((self.runs[index].own.is_some(), obj.start_time)),
                RunKind::Slider(_) => blocking = Some((self.runs[index].nested[0].is_some(), obj.start_time)),
                RunKind::Spinner(_) => {}
            }
        }
        if let Some((judged, start)) = blocking {
            if !judged && time < start {
                return ClickAction::Shake;
            }
        }
        if !in_a_window {
            return ClickAction::Shake;
        }
        ClickAction::Hit
    }

    /// starttimeorderedhitpolicy.cs:57-81 -- every alive unjudged circle or
    /// head starting before a just-judged one is missed, earliest first
    fn handle_hit(&mut self, target_start: f64, time: f64) {
        let mut i = 0;
        while i < self.alive.len() {
            let index = self.alive[i];
            i += 1;
            self.charge(1);
            let obj_start = self.beatmap.objects[index].start_time;
            if obj_start >= target_start {
                break;
            }
            match &self.runs[index].kind {
                RunKind::Circle if self.runs[index].own.is_none() => {
                    self.judge(index, None, HitResult::Miss, HitResult::Great, time);
                }
                RunKind::Slider(_) if self.runs[index].nested[0].is_none() => {
                    self.judge(index, Some(0), HitResult::Miss, HitResult::Great, time);
                }
                _ => {}
            }
        }
    }

    /// `ApplyResult` and everything `OnNewResult` fans out to, in lazer's
    /// order: the hit policy's forced misses first (they reach the score
    /// processor before the result that caused them), then the result's own
    /// scoring and its timeline event. the time recorded is the update's
    /// own, which is when lazer applies the result and when everything
    /// reading this timeline -- the health fold, the sample plan, the
    /// popups -- acts on it; `JudgementResult.TimeAbsolute` clamps a late
    /// result to the element's maximum judgement offset for the hit-event
    /// statistics and for rewinding, neither of which reads this timeline
    fn judge(&mut self, index: usize, nested: Option<usize>, result: HitResult, max_result: HitResult, time: f64) {
        let judged = Judged { result, time };
        match nested {
            // a spinner keeps no slots: its ticks are counted by its run
            Some(n) => {
                if let Some(slot) = self.runs[index].nested.get_mut(n) {
                    *slot = Some(judged);
                }
            }
            None => self.runs[index].own = Some(judged),
        }
        self.applied += 1;

        let blocks = match (&self.runs[index].kind, nested) {
            (RunKind::Circle, None) => true,
            (RunKind::Slider(_), Some(0)) => true,
            _ => false,
        };
        if blocks {
            self.handle_hit(self.beatmap.objects[index].start_time, time);
        }

        let before = self.score.total_score();
        self.score.apply(result, max_result);
        let mut event_index = None;
        if let Some(kind) = self.event_kind(index, nested, result) {
            event_index = Some(self.events.len());
            self.events.push(JudgementEvent {
                time,
                object_index: index,
                kind,
                combo_after: self.score.combo,
                accuracy_after: self.score.accuracy(),
            });
        }
        self.applied_results.push(AppliedResult {
            time,
            result,
            max_result,
            event_index,
            count: 1,
        });
        // the curve records whenever the FOLD moves, which is not the same as
        // the result being scorable. a dropped slider tail is an ignore miss
        // that scores nothing of its own, yet its MAXIMUM is a SliderTailHit
        // that still weighs in accuracy's denominator (scoring.rs's
        // `max_result.affects_accuracy()`), so the total falls on a result
        // `is_scorable()` answers false for -- and lazer calls `updateScore`
        // on every applied result, not only the scorable ones
        // (scoreprocessor.cs:283). asking the total itself is the one gate
        // that cannot drift from the fold's own rules
        self.push_score_step(before, time);
    }

    /// one curve step, pushed only when the total actually moved. a step that
    /// repeats the previous value is a step nothing reads differently, and
    /// the absence of one is what makes `scoreAt` a step lookup rather than a
    /// search for the last change
    fn push_score_step(&mut self, before: i64, time: f64) {
        let after = self.score.total_score();
        if after != before {
            self.score_curve.push(ScoreStep {
                time,
                score: u64::try_from(after).unwrap_or(0),
            });
        }
    }

    /// `count` applications of one event-less result at once: a spinner's
    /// unreached ticks, each an ignore miss at its own maximum, which lazer
    /// applies one nested object at a time (drawablespinner.cs:256-258)
    /// and the fold takes in one step because nothing in it depends on the
    /// count -- no combo, no accuracy and no timeline event. the curve is
    /// asked the same question `judge` asks it, so a maximum that ever does
    /// weigh in accuracy records a step here too rather than silently not
    fn judge_repeated(&mut self, index: usize, result: HitResult, max_result: HitResult, count: u32, time: f64) {
        if count == 0 {
            return;
        }
        debug_assert!(matches!(self.runs[index].kind, RunKind::Spinner(_)) && !result.is_scorable());
        self.applied += 1;
        let before = self.score.total_score();
        self.score.apply_repeated(result, max_result, count);
        self.applied_results.push(AppliedResult {
            time,
            result,
            max_result,
            event_index: None,
            count,
        });
        self.push_score_step(before, time);
    }

    /// the timeline kind a result becomes; unreached spinner ticks have no
    /// event, since they score nothing and the counts already carry them
    fn event_kind(&self, index: usize, nested: Option<usize>, result: HitResult) -> Option<JudgementKind> {
        Some(match (&self.beatmap.objects[index].kind, nested) {
            (ProcessedKind::Circle, _) => JudgementKind::Circle(result_grade(result)),
            (ProcessedKind::Slider(slider), Some(n)) => {
                let nested_index = u32::try_from(n).ok();
                match slider.nested[n].kind {
                    NestedKind::Head => JudgementKind::SliderHead {
                        grade: result_grade(result),
                    },
                    NestedKind::Tick => JudgementKind::SliderTick {
                        hit: result.is_hit(),
                        nested_index,
                    },
                    NestedKind::Repeat => JudgementKind::SliderRepeat {
                        hit: result.is_hit(),
                        repeat_index: u32::try_from(slider.nested[n].span_index).unwrap_or(0),
                        nested_index,
                    },
                    NestedKind::Tail => JudgementKind::SliderTail {
                        hit: result.is_hit(),
                        nested_index,
                    },
                }
            }
            (ProcessedKind::Slider(_), None) => JudgementKind::SliderEnd {
                complete: result.is_hit(),
            },
            (ProcessedKind::Spinner(_), Some(_)) => match result {
                HitResult::SmallBonus => JudgementKind::SpinnerSpin,
                HitResult::LargeBonus => JudgementKind::SpinnerBonus,
                _ => return None,
            },
            (ProcessedKind::Spinner(_), None) => JudgementKind::SpinnerFinal(result_grade(result)),
        })
    }

    /// the container's update pass over the alive list, later objects first
    fn update_alive(&mut self, time: f64, at_deadline: bool, pos: Vec2, actions: Actions) {
        for i in (0..self.alive.len()).rev() {
            let index = self.alive[i];
            self.charge(1);
            match self.runs[index].kind {
                RunKind::Circle => self.update_circle(index, time, at_deadline),
                RunKind::Slider(_) => self.update_slider(index, time, at_deadline, pos, actions),
                RunKind::Spinner(_) => self.update_spinner(index, time, actions),
            }
        }
    }

    /// drawablehitcircle.cs:141-155 -- the timeout past the meh window
    fn update_circle(&mut self, index: usize, time: f64, at_deadline: bool) {
        if self.runs[index].own.is_some() {
            return;
        }
        let deadline = self.beatmap.objects[index].start_time + self.beatmap.windows.meh();
        if past(time, at_deadline, deadline) {
            self.judge(index, None, HitResult::Miss, HitResult::Great, time);
        }
    }

    fn slider_max_result(kind: NestedKind) -> HitResult {
        nested_result(kind, true)
    }

    fn update_slider(&mut self, index: usize, time: f64, at_deadline: bool, pos: Vec2, actions: Actions) {
        let obj = &self.beatmap.objects[index];
        let slider = slider_of(obj);
        let (start_time, end_time) = (obj.start_time, obj.end_time);

        // sliderinputmanager.cs:80 -- the tracking update, against the
        // expanded area only while already tracking; the input manager is
        // the slider's first child, so it runs before every element
        let all_judged = self.runs[index].all_judged();
        let (tracking, last_tick_index, tail_index) = match &mut self.runs[index].kind {
            RunKind::Slider(run) => {
                let valid_position =
                    SliderRun::is_mouse_in_follow_area(obj, slider, self.radius, time, pos, run.tracking);
                run.update_tracking(time, end_time, all_judged, actions, valid_position);
                (run.tracking, run.last_tick_index, run.tail_index)
            }
            _ => unreachable!("update_slider is only called for sliders"),
        };
        let head_judged = self.runs[index].nested[0].is_some();

        // nested elements in container order: ticks, repeats, the tail. the
        // tail reads the last tick's state as of its own turn, so a tick
        // judged earlier in this same update counts -- lazer's tail
        // container updates after its tick and repeat containers
        for pass in [NestedKind::Tick, NestedKind::Repeat, NestedKind::Tail] {
            for n in 0..slider.nested.len() {
                let nested = &slider.nested[n];
                if nested.kind != pass || self.runs[index].nested[n].is_some() {
                    continue;
                }
                self.charge(1);
                let last_tick_judged = last_tick_index.map_or(true, |i| self.runs[index].nested[i].is_some());
                let verdict = nested_verdict(nested.kind, time - nested.time, tracking, head_judged, last_tick_judged);
                let hit = match verdict {
                    NestedVerdict::Wait => continue,
                    NestedVerdict::Hit => true,
                    NestedVerdict::Miss => false,
                };
                self.judge(
                    index,
                    Some(n),
                    nested_result(nested.kind, hit),
                    Self::slider_max_result(nested.kind),
                    time,
                );
            }
        }

        // the head container after the shake container's three: its
        // timeout is the circle's
        if self.runs[index].nested[0].is_none() && past(time, at_deadline, start_time + self.beatmap.windows.meh()) {
            self.judge(index, Some(0), HitResult::Miss, HitResult::Great, time);
        }

        // drawableslider.cs:293-326 -- the slider's own result once the
        // tail has judged and the end has passed, evaluated last of all:
        // `CheckForResult` runs from `UpdateAfterChildren`
        // (drawablehitobject.cs:667-671), after every nested element's own
        // update in the same frame
        if self.runs[index].own.is_none() && self.runs[index].nested[tail_index].is_some() && time >= end_time {
            let any_hit = self.runs[index]
                .nested
                .iter()
                .any(|j| j.is_some_and(|j| j.result.is_hit()));
            let result = if any_hit {
                HitResult::IgnoreHit
            } else {
                HitResult::IgnoreMiss
            };
            self.judge(index, None, result, HitResult::IgnoreHit, time);
        }
    }

    /// sliderinputmanager.cs:84-140 after a head HIT: the passed elements
    /// forced by whether the cursor sits inside the expanded area of each,
    /// then tracking re-evaluated at once
    fn post_process_head_judgement(&mut self, index: usize, time: f64, pos: Vec2, actions: Actions) {
        let obj = &self.beatmap.objects[index];
        let slider = slider_of(obj);
        let head_hit = self.runs[index].nested[0].is_some_and(|j| j.result.is_hit());
        if !head_hit {
            return;
        }
        if !SliderRun::is_mouse_in_follow_area(obj, slider, self.radius, time, pos, true) {
            return;
        }
        let mouse_in_slider = pos - obj.stacked_position;
        let expanded = self.radius * 2.4;
        let mut all_in_range = true;
        for (n, nested) in slider.nested.iter().enumerate() {
            if self.runs[index].nested[n].is_some() {
                continue;
            }
            if nested.time > time {
                break;
            }
            let progress = ((nested.time - obj.start_time) / slider.duration).clamp(0.0, 1.0);
            let position = slider.curve_position_at(progress);
            if (position - mouse_in_slider).length_squared() > expanded * expanded {
                all_in_range = false;
                break;
            }
        }
        for n in 0..slider.nested.len() {
            if self.runs[index].nested[n].is_some() {
                continue;
            }
            let nested = &slider.nested[n];
            if nested.time > time {
                break;
            }
            self.charge(1);
            self.judge(
                index,
                Some(n),
                nested_result(nested.kind, all_in_range),
                Self::slider_max_result(nested.kind),
                time,
            );
        }
        let all_judged = self.runs[index].all_judged();
        let in_plain_area = SliderRun::is_mouse_in_follow_area(obj, slider, self.radius, time, pos, false);
        if let RunKind::Slider(run) = &mut self.runs[index].kind {
            run.update_tracking(time, obj.end_time, all_judged, actions, all_in_range || in_plain_area);
        }
    }

    fn update_spinner(&mut self, index: usize, time: f64, actions: Actions) {
        let obj = &self.beatmap.objects[index];
        let spinner = match &obj.kind {
            ProcessedKind::Spinner(spinner) => spinner,
            _ => unreachable!("update_spinner is only called for spinners"),
        };
        let (start_time, end_time) = (obj.start_time, obj.end_time);

        // drawablespinner.cs:277-283 -- tracking recomputed by the
        // spinner's own update, then the rotation by the tracker child
        let spinnable = start_time <= time && end_time > time;
        let judged = self.runs[index].own.is_some();
        match &mut self.runs[index].kind {
            RunKind::Spinner(run) => {
                run.update_tracking(spinnable, judged, actions.any());
                run.update_rotation(obj.position, spinnable);
            }
            _ => unreachable!("matched above"),
        }

        // drawablespinner.cs:247-275 from updateafterchildren -- at the
        // end: the unreached ticks missed, as the two groups their maxima
        // make, then the grade from progress
        if !judged && time >= start_time && time >= end_time {
            let (missed, progress) = match &mut self.runs[index].kind {
                RunKind::Spinner(run) => (run.miss_remaining_ticks(spinner), run.progress(spinner)),
                _ => unreachable!("matched above"),
            };
            for (max, count) in missed {
                self.charge(1);
                self.judge_repeated(index, HitResult::IgnoreMiss, max, count, time);
            }
            self.judge(index, None, spinner_result(progress), HitResult::Great, time);
        }

        // drawablespinner.cs:335-365, after the result -- the ticks the
        // rotation earned; none remain once the end has missed them
        let awarded = match &mut self.runs[index].kind {
            RunKind::Spinner(run) => run.award_spins(spinner),
            _ => unreachable!("matched above"),
        };
        for (tick, max) in awarded {
            self.charge(1);
            self.judge(index, Some(tick as usize), max, max, time);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::process_beatmap;
    use crate::formats::beatmap::decode_beatmap_bytes;

    fn map(objects: &str) -> ProcessedBeatmap {
        let text = format!(
            "osu file format v14\n\n[Difficulty]\nHPDrainRate:5\nCircleSize:4\nOverallDifficulty:5\nApproachRate:9\nSliderMultiplier:1\nSliderTickRate:2\n\n[TimingPoints]\n0,500,4,2,1,60,1,0\n\n[HitObjects]\n{objects}\n"
        );
        process_beatmap(&decode_beatmap_bytes(text.as_bytes()).expect("decodes")).expect("processes")
    }

    fn frame(time: f64, x: f32, y: f32, raw: u32) -> ReplayFrame {
        ReplayFrame {
            time,
            pos: Vec2::new(x, y),
            buttons: Buttons::new(raw),
        }
    }

    #[test]
    fn an_empty_replay_is_refused() {
        let beatmap = map("100,100,1000,5,0,0:0:0:0:");
        assert!(matches!(
            simulate_native(&beatmap, &[]),
            Err(EngineError::InvalidArgument(_))
        ));
    }

    #[test]
    fn a_circle_pressed_on_time_is_great_and_an_unpressed_one_times_out_at_the_meh_edge() {
        let beatmap = map("100,100,1000,5,0,0:0:0:0:\n300,100,2000,1,0,0:0:0:0:");
        let frames = [
            frame(0.0, 100.0, 100.0, 0),
            frame(1000.0, 100.0, 100.0, 1),
            frame(1020.0, 100.0, 100.0, 0),
            frame(3000.0, 100.0, 100.0, 0),
        ];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        let kinds: Vec<(usize, JudgementKind, f64)> =
            timeline.events.iter().map(|e| (e.object_index, e.kind, e.time)).collect();
        assert_eq!(
            kinds,
            vec![
                (0, JudgementKind::Circle(HitGrade::Great), 1000.0),
                (1, JudgementKind::Circle(HitGrade::Miss), 2000.0 + 149.5),
            ]
        );
        assert_eq!(timeline.totals.max_combo, 1);
        assert_eq!(timeline.totals.accuracy, 0.5);
        let native = timeline.native.expect("the native fold rides along");
        assert_eq!(native.statistics, vec![(HitResult::Miss, 1), (HitResult::Great, 1)], "enum order, as lazer writes a block");
        assert_eq!(native.maximum_statistics, vec![(HitResult::Great, 2)]);
    }

    #[test]
    fn a_press_before_the_blocking_circles_start_is_shaken_and_consumed() {
        // two circles 100ms apart; the press on the second lands 50ms before
        // the first's start, so the policy shakes it and nothing judges
        let beatmap = map("100,100,1000,5,0,0:0:0:0:\n300,100,1100,1,0,0:0:0:0:");
        let frames = [
            frame(0.0, 300.0, 100.0, 0),
            frame(950.0, 300.0, 100.0, 1),
            frame(970.0, 300.0, 100.0, 0),
            frame(2000.0, 300.0, 100.0, 0),
        ];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        let results: Vec<(usize, JudgementKind)> = timeline.events.iter().map(|e| (e.object_index, e.kind)).collect();
        assert_eq!(
            results,
            vec![
                (0, JudgementKind::Circle(HitGrade::Miss)),
                (1, JudgementKind::Circle(HitGrade::Miss)),
            ],
            "both time out; the shaken press judged nothing"
        );
    }

    #[test]
    fn a_hit_on_a_later_circle_misses_the_earlier_unjudged_one_first() {
        let beatmap = map("100,100,1000,5,0,0:0:0:0:\n300,100,1100,1,0,0:0:0:0:");
        let frames = [
            frame(0.0, 300.0, 100.0, 0),
            frame(1080.0, 300.0, 100.0, 1),
            frame(1100.0, 300.0, 100.0, 0),
            frame(2000.0, 300.0, 100.0, 0),
        ];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        let results: Vec<(usize, JudgementKind, u32)> =
            timeline.events.iter().map(|e| (e.object_index, e.kind, e.combo_after)).collect();
        assert_eq!(
            results,
            vec![
                (0, JudgementKind::Circle(HitGrade::Miss), 0),
                (1, JudgementKind::Circle(HitGrade::Great), 1),
            ]
        );
    }

    #[test]
    fn duplicate_frame_timestamps_are_separate_updates() {
        let beatmap = map("100,100,2000,5,0,0:0:0:0:\n300,100,2000,1,0,0:0:0:0:");
        let frames = [
            frame(0.0, 200.0, 100.0, 0),
            frame(2000.0, 100.0, 100.0, 1),
            frame(2000.0, 300.0, 100.0, 2),
            frame(2040.0, 300.0, 100.0, 0),
            frame(3000.0, 300.0, 100.0, 0),
        ];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        let results: Vec<(usize, JudgementKind)> = timeline.events.iter().map(|e| (e.object_index, e.kind)).collect();
        assert_eq!(
            results,
            vec![
                (0, JudgementKind::Circle(HitGrade::Great)),
                (1, JudgementKind::Circle(HitGrade::Great)),
            ]
        );
    }

    #[test]
    fn a_deadline_on_a_frames_own_time_falls_due_right_after_that_frame() {
        let beatmap = map("100,100,1000,5,0,0:0:0:0:");
        let deadline = 1000.0 + beatmap.windows.meh();

        // the frame at the edge admits the hit still (canbehit), so the
        // miss lands at the first instant past it -- which the old walk
        // never reached when that frame was the last
        let frames = [frame(0.0, 400.0, 300.0, 0), frame(deadline, 400.0, 300.0, 0)];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        assert_eq!(
            timeline.events.iter().map(|e| (e.kind, e.time)).collect::<Vec<_>>(),
            vec![(JudgementKind::Circle(HitGrade::Miss), deadline)]
        );

        // a PRESSED frame changes none of this. the handler's important
        // section, which would have refused the 20ms after such a frame, is
        // gated on `FrameAccuratePlayback` -- a field the game never assigns
        // (see the module doc) -- so the instant is reached at its own time
        // whether or not a button is down, and whether or not a successor
        // frame sits inside the span
        let frames = [frame(0.0, 400.0, 300.0, 0), frame(deadline, 400.0, 300.0, 1)];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        assert_eq!(
            timeline.events.iter().map(|e| (e.kind, e.time)).collect::<Vec<_>>(),
            vec![(JudgementKind::Circle(HitGrade::Miss), deadline)]
        );

        for successor in [10.0, 30.0] {
            let frames = [
                frame(0.0, 400.0, 300.0, 0),
                frame(deadline, 400.0, 300.0, 1),
                frame(deadline + successor, 400.0, 300.0, 0),
            ];
            let timeline = simulate_native(&beatmap, &frames).expect("simulates");
            assert_eq!(timeline.events[0].time, deadline, "successor {successor}ms away");
        }
    }

    #[test]
    fn a_sliders_own_result_follows_its_elements_at_one_instant() {
        // a slider whose duration is the meh window exactly, so the head's
        // timeout, the tail (which waits for the head) and the slider's own
        // result all fall due at one instant: the nested containers update
        // before the slider's `UpdateAfterChildren`, so the slider's own
        // result is the last of the three
        let meh = map("100,100,1000,5,0,0:0:0:0:").windows.meh();
        let length = meh * 0.2;
        let beatmap = map(&format!("100,200,1000,6,0,L|{}:200,1,{length}", 100.0 + length));
        let end = beatmap.objects[0].end_time;
        assert_eq!(end, 1000.0 + meh, "the slider ends at the head's edge");
        let frames = [frame(0.0, 400.0, 300.0, 0), frame(3000.0, 400.0, 300.0, 0)];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        let kinds: Vec<(JudgementKind, f64)> = timeline.events.iter().map(|e| (e.kind, e.time)).collect();
        assert_eq!(
            kinds,
            vec![
                (JudgementKind::SliderHead { grade: HitGrade::Miss }, end),
                (JudgementKind::SliderTail { hit: false, nested_index: Some(1) }, end),
                (JudgementKind::SliderEnd { complete: false }, end),
            ]
        );
    }

    #[test]
    fn a_spinners_unreached_ticks_are_counted_and_never_materialised() {
        // ten minutes of spinner under a still cursor: every tick is
        // unreached, and the walk holds a count of them, not a slot each
        let beatmap = map("256,192,1000,12,0,601000,0:0:0:0:");
        let spinner = match &beatmap.objects[0].kind {
            ProcessedKind::Spinner(spinner) => spinner,
            _ => unreachable!(),
        };
        let tick_count = scoring::spinner_tick_count(spinner);
        assert!(tick_count > 1000, "{tick_count} ticks");
        let frames = [frame(0.0, 256.0, 192.0, 0), frame(700_000.0, 256.0, 192.0, 0)];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        assert_eq!(
            timeline.events.iter().map(|e| e.kind).collect::<Vec<_>>(),
            vec![JudgementKind::SpinnerFinal(HitGrade::Miss)]
        );
        let native = timeline.native.expect("native");
        assert_eq!(native.statistics, vec![(HitResult::Miss, 1), (HitResult::IgnoreMiss, tick_count)]);
        let bonus_maximum: u32 = native
            .maximum_statistics
            .iter()
            .filter(|(r, _)| r.is_bonus())
            .map(|(_, c)| c)
            .sum();
        assert_eq!(bonus_maximum, tick_count);
        assert!(native.applied.len() <= 3, "{} applied records", native.applied.len());
        assert_eq!(native.applied.iter().map(|a| a.count).sum::<u32>(), tick_count + 1);
        assert_eq!(native.total_score, 0);
    }

    #[test]
    fn a_truncation_at_an_index_no_result_produced_is_refused() {
        let beatmap = map("100,100,1000,5,0,0:0:0:0:\n300,100,2000,1,0,0:0:0:0:");
        let frames = [frame(0.0, 400.0, 300.0, 0), frame(3000.0, 400.0, 300.0, 0)];
        let timeline = simulate_native(&beatmap, &frames).expect("simulates");
        assert_eq!(timeline.events.len(), 2);
        let at_first = outcome_up_to(&beatmap, &timeline, 0).expect("the first event is a fail point");
        assert_eq!(at_first.count_miss, 1);
        assert!(outcome_up_to(&beatmap, &timeline, 2).is_none(), "no result produced event 2");
    }

    #[test]
    fn sweep_step_budget_boundary() {
        let beatmap = map("100,100,1000,5,0,0:0:0:0:");
        let frames = [frame(0.0, 100.0, 100.0, 0), frame(1000.0, 100.0, 100.0, 1), frame(1020.0, 100.0, 100.0, 0)];
        let generous = simulate_native_with_budget(&beatmap, &frames, u64::MAX).expect("simulates");
        assert_eq!(generous.events.len(), 1);
        let err = simulate_native_with_budget(&beatmap, &frames, 0).expect_err("a zero budget refuses");
        assert!(matches!(err, EngineError::ResourceLimit { cap: "MAX_SIMULATION_SWEEP_STEPS", .. }));
    }
}
