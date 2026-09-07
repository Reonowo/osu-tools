//! stable's HP system: the map-load drain-rate search that a life bar
//! sample is recorded against.
//!
//! the port target is stable's own runtime, not lazer's. lazer's legacy
//! approximation (`LegacyDrainingHealthProcessor.cs` +
//! `OsuLegacyHealthProcessor.cs`, reachable only through the Classic mod's
//! `ClassicHealth` setting) is knowingly incomplete -- no combo-end
//! additions and therefore no combo-end branch in the search, flat 50/100
//! gains, no preempt-adjusted first gap -- and its own graph writer returns
//! `string.Empty` with a `// todo: implement, maybe?`. danser-go's
//! `app/rulesets/osu/healthprocessor.go` is the community-verified port of
//! the same routine and was this module's first reference; where the two
//! disagree, the authority is a direct read of the stable client's own
//! writer, recorded in `.scratch/stable-osr-writer/findings.md` (Q1 for the
//! life bar, Q2 for the HP processor) with a line-level python model and its
//! corpus oracle under `.scratch/stable-osr-writer/hp-harness/`.
//!
//! # what the search is for
//!
//! stable does not record `hp / 200`. it records, per sampling judgement,
//! `min(1, currentHp / hpAfterPerfectPlay[thatObject])` -- the divisor being
//! the HP a PERFECT play holds right after that object, which is exactly
//! what this search's final successful pass computes on its way to a drain
//! rate. that is why a clean play's graph is a run of `1`s at any absolute
//! HP, and why the search has to publish its per-object vector rather than
//! just the three numbers the runtime drain needs.
//!
//! # deliberate divergences from danser
//!
//! - the first gap opens at `firstObject.start - preempt` with the preempt
//!   FLOORED (stable's is an `int` cast; `ProcessedBeatmap::preempt` already
//!   comes from `difficulty_range_int` and so is integral, but the cast here
//!   is written out rather than assumed).
//! - the perfect pass reads STABLE's own point lists, never lazer's:
//!   `repeatPoints + 2` head/repeat/end gains and one tick gain per
//!   `StablePointKind::Tick`, both counted off `ProcessedSlider::stable_points`
//!   (which has no head entry). `ProcessedSlider::nested` and `repeat_count`
//!   are lazer's and are not read here.
//! - the loop is capped ([`limits::MAX_HEALTH_DRAIN_SEARCH_ITERATIONS`]);
//!   stable's own is unbounded. the trip result is defined rather than
//!   raised -- see that constant.
//!
//! # the runtime fold
//!
//! [`derive_health`] walks the judgement timeline in EMISSION order, which
//! is the order stable applied the same results in. between events the
//! passive drain is integrated over the drain windows and evaluated at each
//! judgement's own millisecond before that judgement's gain lands. that is
//! the "dense" model: stable drains once per GAME frame, far denser than
//! the replay frames it records, so draining only to the previous recorded
//! frame leaves the sample oscillating by about one HP -- the harness
//! measured 1059 of 1071 header samples exact for the per-replay-frame walk
//! against 1070 for this one.
//!
//! two things the timeline cannot be read naively for:
//!
//! - the drain window opens at the first object's START, not at
//!   `start - preempt` the way the search's first gap does. the two
//!   genuinely differ (`findings.md` Q2 D1) and both are carried.
//! - a spinner's HP comes from stable's own disc, one gain per counted half
//!   turn ([`crate::simulation::SpinnerIncrement`]), NOT from the timeline's
//!   `SpinnerSpin`/`SpinnerBonus` events, which are lazer's cursor-rotation
//!   presentation and are ignored here exactly as `score::scorev1` ignores
//!   them. each increment merges into the walk by its recorded EMISSION
//!   POSITION rather than its time: within one frame the walk is clicks,
//!   then the normal walk where the disc turns, then the post walk, and
//!   zero-delta frames repeat that at one millisecond, so time alone cannot
//!   place an increment against a judgement stamped with the same value.
//!
//! # the mod seam
//!
//! NoMod is all `simulate` produces today (`crate::mods`), so the two mod
//! factors this fold would carry are recorded here rather than applied:
//! HalfTime folds x0.75 into the stored rate once at initialisation, and
//! HardRock/Easy widen the beatmap HP to double before their x1.4 / /2
//! scaling (which is where danser's float32 rounding costs it ~1e-5).
//!
//! # fail
//!
//! there is no truncation rule. HP clamps at zero like any other change and
//! sampling follows the object-level judgements for as long as they exist.
//! for a FAILED SOLO play that is a recorded divergence from stable rather
//! than a match: stable stops every object at the fail and writes nothing
//! past it, while this engine's timeline does not end there -- after the
//! last replay frame `simulate` runs a synthetic once-per-millisecond walk
//! that resolves every remaining object BY ITS OWN RULE (an unstarted
//! circle times out as a miss, an in-flight slider aggregates from the
//! parts already scored, and every spinner goes through `stable_final_grade`,
//! which grades zero scored halves Great, Ok or Meh for a requirement of 0,
//! 1, or 2-3), so the walk can produce positive results that gain HP. the
//! regenerated curve of a failed play therefore extends past the fail to the
//! last object and can rise again before it drains back.
//!
//! that is deliberate (`.scratch/hp-drain-port/spec.md` decision 2): the
//! document is its frames, not stable's session. a multiplayer or
//! no-fail-style session, or an edit that extends the play, keeps sampling
//! past zero, and a fail-truncation rule would wrongly cut exactly those
//! cases. the corpus cannot oracle either side of it -- no fixture fails,
//! and a failed play whose post-fail resolutions change the header totals
//! cannot enter the count corpus at all.

use crate::beatmap::difficulty::{difficulty_range, HitGrade};
use crate::beatmap::stable_points::StablePointKind;
use crate::beatmap::{ProcessedBeatmap, ProcessedKind};
use crate::limits;
use crate::score::sections::{combo_end_additions, is_section_last, ComboEndAddition};
use crate::score::spin::spin_turns;
use crate::score::ScoreContext;
use crate::simulation::score::JudgementKind;
use crate::simulation::JudgementTimeline;

/// `findings.md` Q2 D3 -- the passive drain runs at a quarter while a
/// spinner is the current object. stable applies it unconditionally for a
/// modern replay; danser gates it on a client version below 20190510
const SPINNER_DRAIN_SCALE: f64 = 0.25;

/// stable's HP scale: 0..200 internally, and only the recorded life bar
/// value is a fraction
pub(crate) const MAX_HP: f64 = 200.0;

/// how many repeats of one perfect-play gain a single pass applies ONE AT A
/// TIME before folding the remainder into a single step.
///
/// stable awards each of a slider's points and each of a spinner's required
/// half turns as its own gain, with the 0..200 clamp biting between them, so
/// the repeats genuinely have to be applied separately to reproduce the
/// clamped accumulator -- and summing k gains is not the same float as
/// adding `k * gain` once. no real map comes near this budget: a map's whole
/// stable point list is bounded by [`limits::MAX_TOTAL_SLIDER_NESTED_OBJECTS`]
/// at 2,000,000 and the longest conceivable spinner needs tens of thousands
/// of half turns. past it the remainder folds into one step, which leaves
/// the CLAMPED accumulator exact regardless (every gain here is positive and
/// the smallest of them, `1.7 * N` at `N >= 1`, pins it at `MAX_HP` within
/// 118 repeats) and differs only in the last bits of the uncapped one. it
/// exists because a spinner's half-spin requirement comes from its declared
/// duration, which is the one axis no other cap bounds: a hundred-byte
/// `.osu` can declare a spinner asking for two billion of them
const EXACT_GAIN_REPEATS_PER_PASS: u64 = 4_000_000;

/// the clamped/uncapped accumulator pair stable carries. `current` is the HP
/// the game shows and the life bar divides; `uncapped` exists only for the
/// search's per-object recovery check, which asks how much surplus a perfect
/// play threw away against the 200 ceiling
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Health {
    pub current: f64,
    pub uncapped: f64,
}

impl Health {
    pub fn full() -> Self {
        Health {
            current: MAX_HP,
            uncapped: MAX_HP,
        }
    }

    /// every HP change goes through here: the uncapped accumulator floors at
    /// zero, the clamped one is held in `[0, MAX_HP]`. `f64::max`/`min`
    /// return the non-NaN operand, so a crafted map's non-finite time
    /// degrades to a clamp rather than propagating
    pub fn increase(&mut self, amount: f64) {
        self.uncapped = (self.uncapped + amount).max(0.0);
        self.current = (self.current + amount).max(0.0).min(MAX_HP);
    }
}

/// what stable's map-load search produces. the three numbers the runtime
/// drain needs, the per-object divisor the life bar is recorded against, the
/// map's maximum combo (which the `perfect` flag is decided from), and the
/// search's own outcome
#[derive(Debug, Clone, PartialEq)]
pub struct DrainRateSearch {
    /// passive drain, HP per millisecond on the 0..200 scale
    pub rate: f64,
    /// `N`: scales every positive gain
    pub normal_multiplier: f64,
    /// `C`: scales the combo-end mu/katu/geki addition
    pub combo_end_multiplier: f64,
    /// the clamped HP a perfect play holds right after object `i`, taken
    /// from the final SUCCESSFUL pass only. empty for an empty map
    pub hp_after_perfect_play: Vec<f64>,
    /// counted the way the search counts it: one per circle and spinner,
    /// `repeatPoints + 2 + ticks` per slider
    pub max_combo: u32,
    /// passes spent, including the failed ones
    pub iterations: u32,
    /// false only when the iteration cap tripped, in which case every other
    /// field carries the defined escape result rather than a search answer
    pub converged: bool,
}

/// stable's map-load drain-rate search (`findings.md` Q2; danser
/// `CalculateRate`, healthprocessor.go:124-260). pure over the processed
/// beatmap and the raw HP the score context carries; never fails, never
/// panics -- the iteration cap's trip is a reported outcome, see
/// [`limits::MAX_HEALTH_DRAIN_SEARCH_ITERATIONS`]
pub fn drain_rate_search(processed: &ProcessedBeatmap, ctx: &ScoreContext) -> DrainRateSearch {
    search_with_budget(processed, ctx, limits::MAX_HEALTH_DRAIN_SEARCH_ITERATIONS)
}

/// where the walk's first gap opens: the first object's start, less the
/// floored preempt. both the search's gap arithmetic and the runtime
/// windows start here, and both take it in whole milliseconds.
///
/// the subtraction SATURATES because the cast before it does. `f64 as i64`
/// is saturating in rust, so a crafted map's `-1e308` start arrives as
/// `i64::MIN` and a plain `- preempt` overflows -- a debug panic and a
/// release wraparound, either of which breaks the crate's all-profile
/// no-panic guarantee for `derive_score`. no real map comes within twenty
/// orders of magnitude of the bound, so saturating changes nothing a
/// beatmap can express and only defines the crafted end
fn saturating_gap_start(start_time: f64, preempt: i64) -> i64 {
    (start_time as i64).saturating_sub(preempt)
}

/// stable's own end time per kind: a slider ends where its ball's cut-line
/// walk did (`ProcessedSlider::stable_end_time`), never at lazer's
/// `end_time`; a circle ends where it starts and a spinner at its deadline
pub(crate) fn stable_end_time(object: &crate::beatmap::ProcessedObject) -> f64 {
    match &object.kind {
        ProcessedKind::Slider(s) => s.stable_end_time,
        _ => object.end_time,
    }
}

/// the perfect-play gains one object earns, in the order stable awards them
enum PerfectGains {
    /// a circle earns nothing before its own result
    None,
    /// `repeatPoints + 2` head/repeat/end gains and one per tick
    Slider { edges: u64, ticks: u64 },
    /// one per required half turn
    Spinner { half_spins: u64 },
}

fn perfect_gains(object: &crate::beatmap::ProcessedObject) -> PerfectGains {
    match &object.kind {
        ProcessedKind::Circle => PerfectGains::None,
        ProcessedKind::Slider(slider) => {
            // stable's list carries ticks, repeats and the tail -- no head
            let repeats = slider
                .stable_points
                .iter()
                .filter(|p| matches!(p.kind, StablePointKind::Repeat { .. }))
                .count() as u64;
            let ticks = slider
                .stable_points
                .iter()
                .filter(|p| matches!(p.kind, StablePointKind::Tick))
                .count() as u64;
            PerfectGains::Slider {
                edges: repeats + 2,
                ticks,
            }
        }
        // negative requirements (a crafted spinner whose duration overflows
        // the int cast) earn nothing rather than wrapping into a huge count
        ProcessedKind::Spinner(spinner) => PerfectGains::Spinner {
            half_spins: spinner.stable_half_spins_required.max(0) as u64,
        },
    }
}

/// the map's maximum combo as the SEARCH counts it (`findings.md` Q6: each
/// circle and spinner 1, each slider `repeatPoints + 2 + ticks`) -- the
/// value stable's completion routine compares the achieved combo against.
/// `score::max_achievable_combo` answers the same question off lazer's
/// nested list; the corpus asserts the two agree
fn search_max_combo(processed: &ProcessedBeatmap) -> u32 {
    processed
        .objects
        .iter()
        .map(|object| match perfect_gains(object) {
            PerfectGains::Slider { edges, ticks } => u32::try_from(edges + ticks).unwrap_or(u32::MAX),
            PerfectGains::None | PerfectGains::Spinner { .. } => 1,
        })
        .fold(0u32, u32::saturating_add)
}

/// applies `count` repeats of one gain, one at a time while the pass's exact
/// budget lasts -- see [`EXACT_GAIN_REPEATS_PER_PASS`]
fn increase_repeated(health: &mut Health, gain: f64, count: u64, budget: &mut u64) {
    let exact = count.min(*budget);
    *budget -= exact;
    for _ in 0..exact {
        health.increase(gain);
    }
    let folded = count - exact;
    if folded > 0 {
        health.increase(gain * folded as f64);
    }
}

/// the search's escape when the iteration cap trips: lazer's own answer to
/// the same runaway. zero drain and unit multipliers mean a perfect play
/// never leaves the maximum, so the divisor vector is fully determined
fn escaped(processed: &ProcessedBeatmap, budget: u32) -> DrainRateSearch {
    DrainRateSearch {
        rate: 0.0,
        normal_multiplier: 1.0,
        combo_end_multiplier: 1.0,
        hp_after_perfect_play: vec![MAX_HP; processed.objects.len()],
        max_combo: search_max_combo(processed),
        iterations: budget,
        converged: false,
    }
}

/// the iteration budget is a parameter (production passes
/// `limits::MAX_HEALTH_DRAIN_SEARCH_ITERATIONS`) so its boundary test can
/// drive the cap with a small input, mirroring `simulation`'s sweep budget
fn search_with_budget(processed: &ProcessedBeatmap, ctx: &ScoreContext, budget: u32) -> DrainRateSearch {
    let objects = &processed.objects;
    // the search reads `firstObject`, so an object-free map short-circuits
    // before it rather than inside it. no pass runs, so the seeds stand
    if objects.is_empty() {
        return DrainRateSearch {
            rate: 0.05,
            normal_multiplier: 1.0,
            combo_end_multiplier: 1.0,
            hp_after_perfect_play: Vec::new(),
            max_combo: 0,
            iterations: 0,
            converged: true,
        };
    }
    if budget == 0 {
        return escaped(processed, 0);
    }

    let hp = f64::from(ctx.hp_drain_rate);
    let lowest_hp_ever = difficulty_range(hp, 195.0, 160.0, 60.0);
    let lowest_hp_combo_end = difficulty_range(hp, 198.0, 170.0, 80.0);
    let lowest_hp_end = difficulty_range(hp, 198.0, 180.0, 80.0);
    let hp_recovery_available = difficulty_range(hp, 8.0, 4.0, 0.0);

    // stable's `int` cast, and stable's breaks are ints in the file too --
    // the whole gap arithmetic below is integer-truncated, which is why the
    // times are carried as i64 rather than compared as floats. `as i64`
    // SATURATES, so a crafted map's 1e308 lands on a bound and the
    // arithmetic over it has to saturate too -- see `saturating_gap_start`
    let preempt = processed.preempt as i64;
    let breaks: Vec<(i64, i64)> = processed
        .breaks
        .iter()
        .map(|b| (b.start_time as i64, b.end_time as i64))
        .collect();

    let mut rate = 0.05;
    let mut normal = 1.0;
    let mut combo_end = 1.0;
    let mut perfect = vec![0.0; objects.len()];

    for iteration in 1..=budget {
        let mut health = Health::full();
        let mut last_time = saturating_gap_start(objects[0].start_time, preempt);
        let mut fail = false;
        let mut break_index = 0usize;
        let mut combo_too_low = 0u32;
        let mut exact_budget = EXACT_GAIN_REPEATS_PER_PASS;

        for (i, object) in objects.iter().enumerate() {
            let local_last = last_time;
            let end = stable_end_time(object);

            // a break counts against the gap only when it lies WHOLLY
            // inside it; below format 8 the break's own length is
            // subtracted, from 8 up the span from the last object's end
            let mut break_time = 0i64;
            if let Some(&(break_start, break_end)) = breaks.get(break_index) {
                if break_start >= local_last && (break_end as f64) <= object.start_time {
                    break_time = if processed.format_version < 8 {
                        break_end.saturating_sub(break_start)
                    } else {
                        break_end.saturating_sub(local_last)
                    };
                    break_index += 1;
                }
            }

            health.increase(-rate * (object.start_time - last_time.saturating_add(break_time) as f64));
            last_time = end as i64;

            if health.current <= lowest_hp_ever {
                fail = true;
                rate *= 0.96;
                break;
            }

            // the object's own duration drains too, and the OVERKILL is
            // measured before the drain lands: stable checks after the
            // gains whether the drain alone would have taken HP under
            let decrease = rate * (end - object.start_time);
            let hp_under = (health.current - decrease).min(0.0);
            health.increase(-decrease);

            match perfect_gains(object) {
                PerfectGains::None => {}
                PerfectGains::Slider { edges, ticks } => {
                    increase_repeated(&mut health, normal * 4.0, edges, &mut exact_budget);
                    increase_repeated(&mut health, normal * 3.0, ticks, &mut exact_budget);
                }
                PerfectGains::Spinner { half_spins } => {
                    increase_repeated(&mut health, normal * 1.7, half_spins, &mut exact_budget);
                }
            }

            if hp_under < 0.0 && health.current + hp_under <= lowest_hp_ever {
                fail = true;
                rate *= 0.96;
                break;
            }

            if is_section_last(objects, i) {
                health.increase(normal * 6.0 + combo_end * 14.0);
                if health.current < lowest_hp_combo_end {
                    combo_too_low += 1;
                    // the third shortfall in one pass, not the first
                    if combo_too_low > 2 {
                        combo_end *= 1.07;
                        normal *= 1.03;
                        fail = true;
                        break;
                    }
                }
            } else {
                health.increase(normal * 6.0);
            }

            // AFTER the gains: this is the divisor the life bar reads
            perfect[i] = health.current;
        }

        if !fail && health.current < lowest_hp_end {
            fail = true;
            rate *= 0.94;
            combo_end *= 1.01;
            normal *= 1.01;
        }

        // "did a perfect play throw away enough surplus per object": the
        // uncapped accumulator is the only place that surplus survives
        let surplus_per_object = (health.uncapped - MAX_HP) / objects.len() as f64;
        if !fail && surplus_per_object < hp_recovery_available {
            fail = true;
            rate *= 0.96;
            combo_end *= 1.02;
            normal *= 1.01;
        }

        if !fail {
            return DrainRateSearch {
                rate,
                normal_multiplier: normal,
                combo_end_multiplier: combo_end,
                // only a successful pass publishes its vector
                hp_after_perfect_play: perfect,
                max_combo: search_max_combo(processed),
                iterations: iteration,
                converged: true,
            };
        }
    }

    escaped(processed, budget)
}

// ---------------------------------------------------------------------------
// the runtime fold
// ---------------------------------------------------------------------------

/// one recorded life bar sample. both halves are `f32` AT RECORD TIME, not
/// at write time: stable holds the pair as a `Vector2`, and the graph
/// writer's 2000 ms thinning gate subtracts those very floats. the time is
/// lossless below 2^24 ms and matches stable's own truncation above it
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LifeBarSample {
    pub time: f32,
    /// `min(1, hp / hpAfterPerfectPlay[object])`
    pub value: f32,
}

/// one breakpoint on the HP curve: a time, and the HP held at it as a
/// fraction of the 0..200 scale. between two breakpoints the value is
/// linear, and a pair sharing a millisecond is a jump -- the first is the
/// value before it, the second the value after
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HealthPoint {
    pub time: f64,
    /// HP over [`MAX_HP`], so `1` is full. never the header's ratio, whose
    /// divisor is the object's own perfect-play HP
    pub fraction: f64,
}

/// everything the health port produces for one play: the map-load search
/// (which carries the per-object divisor vector, the map max combo, the
/// pass count and the converged flag), the ordered life bar samples (one
/// per object-level judgement), and the continuous HP curve underneath
/// them. the graph writer, the HUD bar and the overview strip all read this
/// without re-deriving anything, which is what keeps the bar and the
/// header's graph from ever disagreeing
#[derive(Debug, Clone, PartialEq)]
pub struct HealthCurve {
    pub search: DrainRateSearch,
    /// in judgement order, which is emission order
    pub samples: Vec<LifeBarSample>,
    /// the piecewise-linear HP over time, one breakpoint wherever the value
    /// or the slope changes: two per gain (before and after, sharing its
    /// millisecond), one per drain-window edge and merged-spinner-span
    /// edge, and one where a draining piece reaches zero so the flat that
    /// follows is a segment of its own. HP before the first point is full.
    ///
    /// the count is bounded by what produces those breakpoints, all capped
    /// already: the timeline's judgements and spinner half-turn increments
    /// (`limits::MAX_JUDGEMENT_EVENTS`, `limits::MAX_REPLAY_FRAMES`), the
    /// map's break and spinner counts (`limits::MAX_HIT_OBJECTS`), and one
    /// zero crossing per drain piece
    pub points: Vec<HealthPoint>,
}

impl HealthCurve {
    /// the HP this curve holds at `time`, on stable's 0..200 scale.
    ///
    /// full before the first breakpoint (HP starts full and the first point
    /// is where something first moved it), the last value after the last,
    /// linear between two, and at a millisecond a gain landed on, the value
    /// AFTER that gain -- which is the value that judgement's life bar
    /// sample was recorded from
    pub fn hp_at(&self, time: f64) -> f64 {
        self.fraction_at(time) * MAX_HP
    }

    /// the life bar value a judgement on `object_index` at `time` records,
    /// read back off the CONTINUOUS curve rather than off the fold's own
    /// accumulator: the curve's HP there over that object's perfect-play HP,
    /// clamped and narrowed exactly as the sampler narrows it.
    ///
    /// `None` where the sampler itself would have skipped -- a missing or
    /// non-positive divisor -- so an oracle comparing the two never restates
    /// the skip rule for itself
    pub fn life_bar_value_at(&self, time: f64, object_index: usize) -> Option<f32> {
        let &perfect = self.search.hp_after_perfect_play.get(object_index)?;
        (perfect > 0.0).then(|| (self.hp_at(time) / perfect).min(1.0) as f32)
    }

    /// the same reading as a fraction of full HP: what the wire carries and
    /// the HP bar draws. never the header's ratio, whose divisor is the
    /// object's own perfect-play HP
    pub fn fraction_at(&self, time: f64) -> f64 {
        let Some(first) = self.points.first() else {
            return 1.0;
        };
        if !(time >= first.time) {
            return 1.0;
        }
        // the LAST point at or before `time`, which is what makes a
        // same-millisecond pair read as the post-gain value
        let mut lo = 0usize;
        let mut hi = self.points.len() - 1;
        while lo < hi {
            let mid = (lo + hi + 1) / 2;
            if self.points[mid].time <= time {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        let at = self.points[lo];
        let Some(next) = self.points.get(lo + 1) else {
            return at.fraction;
        };
        // `next.time > time >= at.time` by construction, but a crafted map
        // can stamp a non-finite time, where the ordering above says
        // nothing; a degenerate span reads as the later value rather than
        // dividing by zero
        if !(next.time > at.time) {
            return next.fraction;
        }
        at.fraction + (next.fraction - at.fraction) * (time - at.time) / (next.time - at.time)
    }
}

/// one drain window, in whole milliseconds as stable computes them
#[derive(Debug, Clone, Copy, PartialEq)]
struct DrainWindow {
    start: f64,
    end: f64,
}

/// danser `calculateDrainPeriods` with `findings.md` Q2 D1 applied: the
/// FIRST window opens at the first object's own start, not at
/// `start - preempt` (which is where the search's first gap opens, and the
/// two are carried separately for exactly that reason). a break splits the
/// windows -- the current one ends at the last object end before it, or at
/// the break's own start below format 8, and the next opens at the first
/// object after it -- and the last window closes at the last object's
/// stable end
fn drain_windows(processed: &ProcessedBeatmap) -> Vec<DrainWindow> {
    let objects = &processed.objects;
    let Some(first) = objects.first() else {
        return Vec::new();
    };
    let preempt = processed.preempt as i64;
    let breaks: Vec<(i64, i64)> = processed
        .breaks
        .iter()
        .map(|b| (b.start_time as i64, b.end_time as i64))
        .collect();

    let mut windows = Vec::new();
    let mut last_start = first.start_time as i64;
    let mut last_end = saturating_gap_start(first.start_time, preempt);
    let mut break_index = 0usize;
    for object in objects {
        if let Some(&(break_start, break_end)) = breaks.get(break_index) {
            if break_start >= last_end && (break_end as f64) <= object.start_time {
                break_index += 1;
                if processed.format_version < 8 {
                    last_end = break_start;
                }
                windows.push(DrainWindow {
                    start: last_start as f64,
                    end: last_end as f64,
                });
                last_start = object.start_time as i64;
            }
        }
        last_end = stable_end_time(object) as i64;
    }
    windows.push(DrainWindow {
        start: last_start as f64,
        end: last_end as f64,
    });
    windows
}

/// the passive drain integrator. windows and spinner spans are both
/// start-ordered and the fold's times only move forward, so each carries a
/// cursor rather than being rescanned from the top per judgement
struct Drain<'a> {
    rate: f64,
    windows: &'a [DrainWindow],
    /// the spans the quarter-rate factor applies over: every spinner's
    /// `(start, end)`, sorted and MERGED, so two overlapping discs cover
    /// their union once rather than twice
    spinners: Vec<(f64, f64)>,
    window_cursor: usize,
    spinner_cursor: usize,
    last_time: f64,
}

impl<'a> Drain<'a> {
    fn new(rate: f64, windows: &'a [DrainWindow], processed: &ProcessedBeatmap) -> Self {
        let mut spans: Vec<(f64, f64)> = processed
            .objects
            .iter()
            .filter(|o| matches!(o.kind, ProcessedKind::Spinner(_)))
            .map(|o| (o.start_time, stable_end_time(o)))
            .filter(|(start, end)| end > start)
            .collect();
        Drain {
            spinners: merge_spans(&mut spans),
            rate,
            windows,
            window_cursor: 0,
            spinner_cursor: 0,
            // before the first window: the integral clips to the windows,
            // so any earlier starting value gives the same first answer
            last_time: windows.first().map_or(0.0, |w| w.start),
        }
    }

    /// the drain over `(last_time, to]`, clipped to the windows, with the
    /// part of each clipped span that lies inside a spinner charged at a
    /// quarter. HP is monotone-decreasing across it, so integrating the
    /// whole span and clamping once is the same answer as clamping at every
    /// intermediate millisecond would have been.
    ///
    /// the sum of [`Drain::walk_to`]'s pieces by construction -- the two are
    /// one routine, and the one-number form is the piece walk with its
    /// pieces dropped. the fold itself reads the pieces (it lays a
    /// breakpoint at each), so this survives as what the boundary tests
    /// below assert the pieces against
    #[cfg(test)]
    fn amount_to(&mut self, to: f64) -> f64 {
        self.walk_to(to, |_| {})
    }

    /// the same drain, piece by piece: one `segment` call per maximal
    /// stretch of `(last_time, to]` whose slope does not change, in time
    /// order, returning their sum.
    ///
    /// the slope changes at exactly two kinds of edge -- a drain window's
    /// (drain stops at a window's end and resumes at the next window's
    /// start) and a merged spinner span's (the quarter-rate factor
    /// switching on or off) -- so a piece is bounded by the span's own ends
    /// and those. only pieces INSIDE a window are reported: the flat
    /// stretches between them are the gaps between consecutive pieces,
    /// which is why a segment carries its start as well as its end
    fn walk_to(&mut self, to: f64, mut segment: impl FnMut(DrainSegment)) -> f64 {
        let from = self.last_time;
        if to > from {
            self.last_time = to;
        }
        while self
            .windows
            .get(self.window_cursor)
            .is_some_and(|w| w.end <= from)
        {
            self.window_cursor += 1;
        }
        while self
            .spinners
            .get(self.spinner_cursor)
            .is_some_and(|s| s.1 <= from)
        {
            self.spinner_cursor += 1;
        }

        let mut total = 0.0;
        for window in &self.windows[self.window_cursor.min(self.windows.len())..] {
            if window.start >= to {
                break;
            }
            let lo = from.max(window.start);
            let hi = to.min(window.end);
            if hi <= lo {
                continue;
            }
            // the clipped window, split at every spinner edge inside it. the
            // spans are merged and start-ordered, so walking them left to
            // right emits the plain and quartered pieces already in time
            // order and each millisecond is charged exactly once
            let mut cut = lo;
            for &(start, end) in &self.spinners[self.spinner_cursor.min(self.spinners.len())..] {
                if start >= hi {
                    break;
                }
                let spun_lo = start.max(cut);
                let spun_hi = end.min(hi);
                if spun_hi <= spun_lo {
                    continue;
                }
                if spun_lo > cut {
                    total += self.emit(&mut segment, cut, spun_lo, 1.0);
                }
                total += self.emit(&mut segment, spun_lo, spun_hi, SPINNER_DRAIN_SCALE);
                cut = spun_hi;
            }
            if hi > cut {
                total += self.emit(&mut segment, cut, hi, 1.0);
            }
        }
        total
    }

    /// one piece, handed to the walk's sink and answered as its own drain.
    /// a method rather than a closure so the borrow of `self.rate` does not
    /// fight the caller's `&mut self`
    fn emit(&self, segment: &mut impl FnMut(DrainSegment), start: f64, end: f64, scale: f64) -> f64 {
        let amount = self.rate * (end - start) * scale;
        segment(DrainSegment { start, end, amount });
        amount
    }
}

/// one piece of the passive drain between two events: the stretch it covers
/// and the HP it drained across it, the slope being constant throughout.
/// only stretches inside a drain window are ever reported, so consecutive
/// segments need not touch -- the hole between them is a stretch where
/// nothing drains at all
#[derive(Debug, Clone, Copy, PartialEq)]
struct DrainSegment {
    start: f64,
    end: f64,
    amount: f64,
}

/// sorts and merges a span list so no millisecond is covered twice. a real
/// map never overlaps its spinners -- osu!standard has one disc at a time --
/// but a crafted one can, and the walk below cuts each clipped window at the
/// spans' edges left to right: overlapping spans would hand it a cut moving
/// backwards, charging the overlap twice and reporting pieces that are not
/// in time order. merging once here makes that unreachable rather than
/// guarding against it at every read
fn merge_spans(spans: &mut Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    // a crafted map can carry non-finite times, which have no total order;
    // total_cmp gives one and keeps the sort from misbehaving
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut merged: Vec<(f64, f64)> = Vec::with_capacity(spans.len());
    for &(start, end) in spans.iter() {
        match merged.last_mut() {
            Some(last) if start <= last.1 => last.1 = last.1.max(end),
            _ => merged.push((start, end)),
        }
    }
    merged
}

/// the combo-end addition's own weight, paid on top of the base gain and
/// scaled by `C` rather than `N` (`findings.md` Q2: 6C / 10C / 14C)
fn addition_weight(addition: ComboEndAddition) -> f64 {
    match addition {
        ComboEndAddition::Mu => 6.0,
        ComboEndAddition::Katu => 10.0,
        ComboEndAddition::Geki => 14.0,
    }
}

/// the object-level result table (`findings.md` Q2; investigation section
/// 3c). a miss is the one row the normal multiplier does not scale, and the
/// one that can never carry an addition
fn object_result_gain(
    grade: HitGrade,
    addition: Option<ComboEndAddition>,
    hp: f64,
    normal: f64,
    combo_end: f64,
) -> f64 {
    let base = match grade {
        HitGrade::Miss => return difficulty_range(hp, -6.0, -25.0, -40.0),
        HitGrade::Great => normal * 6.0,
        // the 100 and 50 gains are HP-DEPENDENT (8x at HP 0); lazer's own
        // legacy port flattens both
        HitGrade::Ok => normal * difficulty_range(hp, 17.6, 2.2, 2.2),
        HitGrade::Meh => normal * difficulty_range(hp, 3.2, 0.4, 0.4),
    };
    base + addition.map_or(0.0, |a| combo_end * addition_weight(a))
}

/// a missed slider tick, repeat, head or end -- the same loss for all four
fn slider_part_miss(hp: f64) -> f64 {
    difficulty_range(hp, -4.0, -15.0, -28.0)
}

/// the gain one timeline event applies, and whether it SAMPLES. only
/// object-level results sample (`findings.md` Q1: the client's sample mask
/// is reached from the hit object manager's object-judged routine, which
/// slider part results never pass through); slider parts gain without
/// sampling, and the spin/bonus presentation events do neither
fn event_gain(
    kind: &JudgementKind,
    addition: Option<ComboEndAddition>,
    hp: f64,
    normal: f64,
    combo_end: f64,
) -> Option<(f64, bool)> {
    match *kind {
        JudgementKind::Circle(grade)
        | JudgementKind::SliderAggregate(grade)
        | JudgementKind::SpinnerFinal(grade) => {
            Some((object_result_gain(grade, addition, hp, normal, combo_end), true))
        }
        JudgementKind::SliderHead { hit }
        | JudgementKind::SliderRepeat { hit, .. }
        | JudgementKind::SliderTail { hit } => {
            Some((if hit { normal * 4.0 } else { slider_part_miss(hp) }, false))
        }
        JudgementKind::SliderTick { hit } => {
            Some((if hit { normal * 3.0 } else { slider_part_miss(hp) }, false))
        }
        // lazer's cursor-rotation presentation: stable's own disc pays
        // instead, one gain per counted half turn
        JudgementKind::SpinnerSpin | JudgementKind::SpinnerBonus => None,
    }
}

/// one spinner half-turn gain, merged into the walk by emission position
struct SpinGain {
    emission_index: usize,
    time: f64,
    amount: f64,
}

/// every spinner's counted half turns as HP gains, in firing order --
/// `spin::spin_turns`' merge priced in HP. the FIRST half turn of a spinner
/// earns nothing; after it a turn is a bonus (2N) when it sits past
/// `required + 3` by an even amount, else a spin (1.7N). deliberately NOT
/// clamped at the disc's possible half spins, where `score::scorev1` is:
/// stable's runtime drain pays what the disc turned, and only the score
/// simulator treats the analytic bound as hard
fn spin_gains(processed: &ProcessedBeatmap, timeline: &JudgementTimeline, normal: f64) -> Vec<SpinGain> {
    spin_turns(processed, timeline)
        .into_iter()
        .filter(|turn| turn.half > 1)
        .map(|turn| SpinGain {
            emission_index: turn.emission_index,
            time: turn.time,
            amount: if turn.is_bonus() {
                normal * 2.0
            } else {
                normal * 1.7
            },
        })
        .collect()
}

/// appends one breakpoint, dropping a repeat of the one before it. a point
/// identical to its predecessor says nothing -- the value did not change and
/// no slope broke -- and the two places that lay points down (a drain piece's
/// ends and a gain's own millisecond) meet exactly there whenever a gain
/// lands on a piece's edge
fn push_point(points: &mut Vec<HealthPoint>, time: f64, hp: f64) {
    let point = HealthPoint {
        time,
        fraction: hp / MAX_HP,
    };
    if points.last() != Some(&point) {
        points.push(point);
    }
}

/// lays one passive drain's breakpoints down: a point at each piece's ends,
/// with the stretch between two pieces left flat (nothing drains there), and
/// a point where a piece reaches zero.
///
/// the pieces only say where the slope broke and how the drop is shared out
/// -- the LAST piece's end takes the fold's own clamped value, so the curve
/// at a judgement is that judgement's sample HP to the bit and no
/// re-accumulation can drift the two apart
fn lay_drain(points: &mut Vec<HealthPoint>, segments: &[DrainSegment], before: f64, after: f64) {
    let mut value = before;
    for (index, segment) in segments.iter().enumerate() {
        // where a window reopens this is the resumption breakpoint; where a
        // piece simply continues the one before it, it repeats that piece's
        // end and is dropped
        push_point(points, segment.start, value);
        let next = if index + 1 == segments.len() {
            after
        } else {
            (value - segment.amount).max(0.0)
        };
        if next <= 0.0 && value > 0.0 && segment.amount > 0.0 {
            let crossed = segment.start + (segment.end - segment.start) * (value / segment.amount);
            if crossed > segment.start && crossed < segment.end {
                push_point(points, crossed, 0.0);
            }
        }
        push_point(points, segment.end, next);
        value = next;
    }
}

/// lays one gain's breakpoints down: the value the millisecond held before
/// it and the value it holds after, both stamped at that same millisecond.
/// the pair is what makes the jump a jump rather than a ramp from wherever
/// the drain last broke, and is why a reader at a judgement's own
/// millisecond sees the POST-judgement value
fn apply_gain(points: &mut Vec<HealthPoint>, health: &mut Health, time: f64, amount: f64) {
    let before = health.current;
    health.increase(amount);
    push_point(points, time, before);
    push_point(points, time, health.current);
}

/// the whole health port for one play: stable's map-load search, then its
/// runtime fold over the judgement timeline, producing the life bar samples
/// the `.osr` header's graph is written from. pure, total, and never
/// panicking -- see the module doc for the fail rule and the spinner
/// ordering, and [`limits::MAX_HEALTH_DRAIN_SEARCH_ITERATIONS`] for the one
/// outcome that is reported rather than raised
pub fn derive_health(
    processed: &ProcessedBeatmap,
    timeline: &JudgementTimeline,
    ctx: &ScoreContext,
) -> HealthCurve {
    let search = drain_rate_search(processed, ctx);
    derive_health_with_search(processed, timeline, ctx, search)
}

/// the fold alone, over a search a caller already has.
///
/// the search depends on the MAP and the score context only -- never on the
/// frames -- so a session that re-folds after every edit computes it once
/// and hands it back here. the seam also lets the fold's own tests drive a
/// chosen search (a dead divisor, say) without contriving a map that
/// produces one
pub fn derive_health_with_search(
    processed: &ProcessedBeatmap,
    timeline: &JudgementTimeline,
    ctx: &ScoreContext,
    search: DrainRateSearch,
) -> HealthCurve {
    // an object-free map has no first object for the windows to open at and
    // no judgement to sample, so the fold is skipped outright rather than
    // guarded inside
    if processed.objects.is_empty() {
        return HealthCurve {
            search,
            samples: Vec::new(),
            points: Vec::new(),
        };
    }

    let hp = f64::from(ctx.hp_drain_rate);
    let normal = search.normal_multiplier;
    let combo_end = search.combo_end_multiplier;
    let additions = combo_end_additions(processed, timeline);
    let windows = drain_windows(processed);
    let mut drain = Drain::new(search.rate, &windows, processed);
    let spins = spin_gains(processed, timeline, normal);

    let mut health = Health::full();
    let mut samples = Vec::new();
    let mut points = Vec::new();
    // one scratch buffer for the whole fold: the piece walk is called once
    // per gain and per judgement, and a fresh allocation each time would
    // charge a long map thousands of them
    let mut segments: Vec<DrainSegment> = Vec::new();
    let mut spin_cursor = 0usize;

    // the passive drain up to `to`, applied as the one clamped change it
    // always was, with the pieces it broke into laid down as breakpoints
    let mut drain_to = |drain: &mut Drain, health: &mut Health, points: &mut Vec<HealthPoint>, to: f64| {
        segments.clear();
        let drained = drain.walk_to(to, |segment| segments.push(segment));
        let before = health.current;
        health.increase(-drained);
        lay_drain(points, &segments, before, health.current);
    };

    for (index, event) in timeline.events.iter().enumerate() {
        // every gain the disc earned before this event was emitted lands
        // first, each drained up to its own frame time
        while let Some(spin) = spins.get(spin_cursor).filter(|s| s.emission_index <= index) {
            drain_to(&mut drain, &mut health, &mut points, spin.time);
            apply_gain(&mut points, &mut health, spin.time, spin.amount);
            spin_cursor += 1;
        }

        let Some((gain, samples_here)) = event_gain(
            &event.kind,
            additions.get(index).copied().flatten(),
            hp,
            normal,
            combo_end,
        ) else {
            continue;
        };
        drain_to(&mut drain, &mut health, &mut points, event.time);
        apply_gain(&mut points, &mut health, event.time, gain);
        if !samples_here {
            continue;
        }
        // the divisor is this object's own perfect-play HP. a missing or
        // non-positive one degrades to a skipped sample -- never a panic,
        // never an infinity written into the header
        let Some(&perfect) = search.hp_after_perfect_play.get(event.object_index) else {
            continue;
        };
        if !(perfect > 0.0) {
            continue;
        }
        samples.push(LifeBarSample {
            time: event.time as f32,
            value: (health.current / perfect).min(1.0) as f32,
        });
    }

    HealthCurve {
        search,
        samples,
        points,
    }
}

/// one component of a `time|value` pair as stable writes it: .net
/// `Math.Round(x, 2)` (banker's on `x * 100`) then the shortest
/// representation that round-trips, with a bare integer printed bare --
/// `1`, `0.9`, `0.86`, `24672`. rust's float `Display` is already that
/// shortest form, so no trailing zeros need trimming. both halves of the
/// pair go through it: a sample time is integral for any map under 2^24 ms
/// and so prints as an integer, which is every real map
pub fn format_graph_number(value: f32) -> String {
    let rounded = (f64::from(value) * 100.0).round_ties_even() / 100.0;
    format!("{rounded}")
}

/// stable's write-time thinning gate: a sample is emitted when it is the
/// first, the last, or strictly more than this far past the last EMITTED
/// one. it is not a sampling cadence -- the samples themselves are
/// judgement-driven -- which is why breaks, spinner windows and the
/// pre-first-object stretch need no rule of their own
const THINNING_GATE_MS: f32 = 2000.0;

/// the `.osr` header's life bar graph string, written from the fold's
/// samples (`findings.md` Q1 stage 2).
///
/// the gate subtracts the STORED `f32` times, because stable holds each
/// sample as a `Vector2` and compares those coordinates; quantising at
/// write time instead would change which samples survive on a map long
/// enough for the difference to exist. zero samples produce the empty
/// string, which is also what a client writes when it has no perfect-play
/// HP to divide by
pub fn life_bar_graph(samples: &[LifeBarSample]) -> String {
    let mut out = String::new();
    let mut last_emitted: Option<f32> = None;
    for (index, sample) in samples.iter().enumerate() {
        let forced = index == 0 || index + 1 == samples.len();
        let past_gate = last_emitted.is_some_and(|last| sample.time - last > THINNING_GATE_MS);
        if !forced && !past_gate {
            continue;
        }
        out.push_str(&format_graph_number(sample.time));
        out.push('|');
        out.push_str(&format_graph_number(sample.value));
        out.push(',');
        last_emitted = Some(sample.time);
    }
    out
}

// ---------------------------------------------------------------------------

/// the simulated sample a header pair was scored against: its own recorded
/// time, and its value formatted the way [`life_bar_graph`] would have
/// written it -- because that string, not the float, is what the header
/// carries and what equality is decided on
#[derive(Debug, Clone, PartialEq)]
pub struct NearestSample {
    pub time: f32,
    pub value: String,
}

/// one `time|value` pair the header carried, scored against the fold
#[derive(Debug, Clone, PartialEq)]
pub struct LifeBarPair<'a> {
    /// the header's own recorded time, which is this pair's identity
    pub header_time: i64,
    /// the header's value verbatim, never reformatted
    pub header_value: &'a str,
    /// `None` only when the fold produced no samples at all, in which case
    /// nothing can match
    pub nearest: Option<NearestSample>,
}

impl LifeBarPair<'_> {
    pub fn matches(&self) -> bool {
        self.nearest.as_ref().is_some_and(|n| n.value == self.header_value)
    }

    /// how far the scoring sample sits from the header's own time. reported
    /// and never asserted on: the header's sample times are wall-clock
    /// artifacts of a real-time timer and are not derivable from the
    /// beatmap or the replay
    pub fn offset(&self) -> Option<f64> {
        self.nearest
            .as_ref()
            .map(|n| (f64::from(n.time) - self.header_time as f64).abs())
    }
}

/// a header's whole life bar graph scored against one fold's samples
#[derive(Debug, Clone, PartialEq)]
pub struct LifeBarComparison<'a> {
    /// every pair that was compared, in the header's own order -- already
    /// truncated at a failed header's first `0`
    pub pairs: Vec<LifeBarPair<'a>>,
    pub matched: usize,
    /// the header's last value is `0`: stable's own record of a fail
    pub header_failed: bool,
    /// pairs the header carried that no reader could score. reported rather
    /// than counted against the total -- a graph with a torn pair is a
    /// decode question, not a health one
    pub malformed: usize,
}

impl LifeBarComparison<'_> {
    /// the header's sample total, which is what `matched` is out of
    pub fn total(&self) -> usize {
        self.pairs.len()
    }
}

/// scores an `.osr` header's life bar graph against the samples this
/// engine's fold produced for the same play (`findings.md` Q1; the corpus
/// oracle's third block and the integrity report both read this).
///
/// never bytes and never times. the header's sample times are wall-clock
/// artifacts of a ~2 second real-time timer and cannot be derived from the
/// beatmap or the replay, so the only thing with meaning is the VALUE, and
/// the curve has no value at an arbitrary time (each sample's divisor is
/// its own object's perfect-play HP). each header pair is therefore scored
/// against the NEAREST simulated sample by absolute time distance -- the
/// first winning a tie -- and compared as the string [`life_bar_graph`]
/// would have written, never as a float. `nearest_sample` carries that rule
/// to the letter, including the two rounding shapes where "nearest" and
/// "first" stop being the whole story.
///
/// a failed header is truncated: stable stops judging at the fail and
/// writes nothing past it, while this engine's fold deliberately keeps
/// going (see the module doc's fail section), so everything after the
/// header's FIRST `0` describes a stretch of play the header never saw.
///
/// pure and total over untrusted input: an empty graph scores nothing, and
/// a pair no reader can parse is reported through `malformed` rather than
/// counted, so a torn string can never make a play read as a mismatch
pub fn compare_life_bar_graph<'a>(graph: &'a str, samples: &[LifeBarSample]) -> LifeBarComparison<'a> {
    let mut malformed = 0usize;
    let mut pairs: Vec<(i64, &str)> = Vec::new();
    for pair in graph.split(',').filter(|pair| !pair.trim().is_empty()) {
        match pair
            .split_once('|')
            .and_then(|(time, value)| Some((time.trim().parse::<i64>().ok()?, value.trim())))
        {
            Some(parsed) => pairs.push(parsed),
            None => malformed += 1,
        }
    }
    let header_failed = pairs.last().is_some_and(|&(_, value)| value == "0");
    if header_failed {
        if let Some(first_zero) = pairs.iter().position(|&(_, value)| value == "0") {
            pairs.truncate(first_zero + 1);
        }
    }

    // built once, not per pair: the header's pair count is bounded only by
    // the `.osr` size cap while the sample count is bounded by the judgement
    // count, so a scan per pair is a product a crafted header controls
    let ordered = index_samples(samples);
    let scored: Vec<LifeBarPair<'a>> = pairs
        .into_iter()
        .map(|(header_time, header_value)| LifeBarPair {
            header_time,
            header_value,
            nearest: nearest_sample(samples, &ordered, header_time),
        })
        .collect();
    LifeBarComparison {
        matched: scored.iter().filter(|pair| pair.matches()).count(),
        pairs: scored,
        header_failed,
        malformed,
    }
}

/// the samples ordered for nearest-neighbour lookup: one entry per DISTINCT
/// sample time, as `(time, the smallest original index holding it)`, with
/// times no ordering can place left out.
///
/// built once per comparison rather than rescanned per header pair. the
/// header's pair count is bounded only by [`limits::MAX_OSR_FILE_BYTES`]
/// while the sample count is bounded by the judgement count, and the load
/// path now scores a header against a real play -- so a scan per pair is a
/// product a crafted header controls one whole side of
fn index_samples(samples: &[LifeBarSample]) -> Vec<(f32, usize)> {
    let mut ordered: Vec<(f32, usize)> = samples
        .iter()
        .enumerate()
        .filter(|(_, sample)| !sample.time.is_nan())
        .map(|(index, sample)| (sample.time, index))
        .collect();
    // by time NUMERICALLY, then by the original index, so the first entry of
    // an equal-time run is the one the first-wins tie rule wants and the
    // dedup below drops the rest of that run.
    //
    // numerically and never `total_cmp`, because the lookup below partitions
    // this list with a plain `<` and the two must agree: `total_cmp` ranks
    // `-0.0` below `0.0` where every arithmetic comparison calls them one
    // instant, which splits a run the dedup should have merged and hands the
    // tie to the later sample. NaN is filtered out above, so the partial
    // order is total here and the fallback is unreachable
    ordered.sort_by(|a, b| {
        a.0.partial_cmp(&b.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.1.cmp(&b.1))
    });
    ordered.dedup_by(|a, b| a.0 == b.0);
    ordered
}

/// the simulated sample nearest one header time, the earliest-emitted
/// winning a tie -- read off the index above rather than by scanning.
///
/// distance is unimodal in time, so the nearest sample is one of the two
/// entries either side of the header's own time and no third candidate can
/// beat them. samples sharing a time were merged upstream onto their
/// earliest index, which is what serves the tie rule.
///
/// the tie rule is between those TWO candidates, which is where this parts
/// from the scan it replaced -- on two shapes no real `.osr` reaches, both
/// pinned by `the_index_and_the_scan_part_where_rounding_flattens_them`:
///
/// - a header time far enough from the samples that f64 subtraction cannot
///   separate two distinct ones -- their gap falling under half the ulp of
///   the DISTANCE, which needs that distance to run some `2^53` times the
///   gap. rounding then flattens a whole RUN of times to one
///   distance: the scan took the earliest-emitted of the entire run, this
///   takes the earliest-emitted of the up-to-two entries the window holds.
///   neither is GUARANTEED to be the exactly-nearest sample once the
///   rounding has stopped carrying which one that is -- the three-sample
///   case pinned in that test has both of them miss it.
/// - where EVERY sample time is NaN nothing can be nearest, and the first
///   sample scores the pair. the scan ordered those by NaN payload bits,
///   which carry no meaning about a play
fn nearest_sample(
    samples: &[LifeBarSample],
    ordered: &[(f32, usize)],
    header_time: i64,
) -> Option<NearestSample> {
    let read = |index: usize| NearestSample {
        time: samples[index].time,
        value: format_graph_number(samples[index].value),
    };
    if ordered.is_empty() {
        return (!samples.is_empty()).then(|| read(0));
    }
    let target = header_time as f64;
    let at = ordered.partition_point(|&(time, _)| f64::from(time) < target);
    let mut best: Option<(f64, usize)> = None;
    for &(time, index) in &ordered[at.saturating_sub(1)..(at + 1).min(ordered.len())] {
        let distance = (f64::from(time) - target).abs();
        let better = match best {
            None => true,
            // a strictly nearer sample wins, an equally near one only if it
            // was emitted first
            Some((best_distance, best_index)) => {
                distance < best_distance || (distance == best_distance && index < best_index)
            }
        };
        if better {
            best = Some((distance, index));
        }
    }
    best.map(|(_, index)| read(index))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::beatmap::process_beatmap;
    use crate::formats::beatmap::{
        Beatmap, BreakPeriod, HitObject, HitObjectKind, PathControlPoint, PathType, SliderData, TimingPoint,
    };
    use crate::formats::GameMode;
    use crate::math::Vec2;

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
            overall_difficulty: 5.0,
            approach_rate: 9.0,
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

    fn circle(start_time: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(256.0, 192.0),
            new_combo: false,
            combo_offset: 0,
            samples: Vec::new(),
            kind: HitObjectKind::Circle,
        }
    }

    fn slider(start_time: f64, repeat_count: i32) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::new(100.0, 100.0),
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
                        pos: Vec2::new(200.0, 0.0),
                        path_type: None,
                    },
                ],
                expected_distance: Some(200.0),
                repeat_count,
                node_samples: Vec::new(),
            }),
        }
    }

    fn spinner(start_time: f64, duration: f64) -> HitObject {
        HitObject {
            start_time,
            pos: Vec2::ZERO,
            new_combo: false,
            combo_offset: 0,
            samples: Vec::new(),
            kind: HitObjectKind::Spinner { duration },
        }
    }

    fn searched(map: &Beatmap) -> (ProcessedBeatmap, DrainRateSearch) {
        let processed = process_beatmap(map).unwrap();
        let ctx = ScoreContext::from_beatmap(map);
        let search = drain_rate_search(&processed, &ctx);
        (processed, search)
    }

    /// the drain-heavy map both cap tests drive: three circles ten seconds
    /// apart at max HP, so the seeded 0.05 rate empties the bar between them
    /// and the search has to shrink it many times over
    fn sparse_high_drain_map() -> Beatmap {
        let mut map = base_map(vec![circle(0.0), circle(10_000.0), circle(20_000.0)]);
        map.hp_drain_rate = 10.0;
        map
    }

    #[test]
    fn an_empty_map_answers_trivially_without_reading_a_first_object() {
        let (processed, search) = searched(&base_map(Vec::new()));
        assert!(processed.objects.is_empty());
        assert!(search.converged);
        assert_eq!(search.iterations, 0);
        assert_eq!(search.max_combo, 0);
        assert!(search.hp_after_perfect_play.is_empty());
        // no pass ran, so the seeds stand
        assert_eq!(search.rate, 0.05);
        assert_eq!(search.normal_multiplier, 1.0);
        assert_eq!(search.combo_end_multiplier, 1.0);
    }

    #[test]
    fn a_map_the_seeded_rate_already_survives_converges_on_the_first_pass() {
        // HP 10 puts the recovery threshold at zero, so the only thing the
        // search asks of a perfect play is that it end no worse than it
        // started. circles 50ms apart gain 6 against 2.5 of drain, which
        // clears every branch at the seeded rate
        let mut map = base_map((0..10).map(|i| circle(5000.0 + i as f64 * 50.0)).collect());
        map.hp_drain_rate = 10.0;
        let (_, search) = searched(&map);
        assert!(search.converged);
        assert_eq!(search.iterations, 1);
        assert_eq!(search.rate, 0.05);
        assert_eq!(search.normal_multiplier, 1.0);
        assert_eq!(search.combo_end_multiplier, 1.0);
        assert_eq!(search.max_combo, 10);
        // the first object is still paying for the approach drain, and the
        // ceiling is reached well before the end
        assert!(search.hp_after_perfect_play[0] < MAX_HP);
        assert_eq!(*search.hp_after_perfect_play.last().unwrap(), MAX_HP);
    }

    #[test]
    fn max_combo_counts_stables_own_lists() {
        let map = base_map(vec![circle(0.0), slider(1000.0, 1), spinner(4000.0, 2000.0)]);
        let (processed, search) = searched(&map);
        let ProcessedKind::Slider(s) = &processed.objects[1].kind else {
            panic!("expected a slider");
        };
        let repeats = s
            .stable_points
            .iter()
            .filter(|p| matches!(p.kind, StablePointKind::Repeat { .. }))
            .count() as u32;
        let ticks = s
            .stable_points
            .iter()
            .filter(|p| matches!(p.kind, StablePointKind::Tick))
            .count() as u32;
        // circle 1 + (repeats + 2 + ticks) + spinner 1
        assert_eq!(search.max_combo, 1 + (repeats + 2 + ticks) + 1);
        // and this map is one where the two counts agree, which is what the
        // corpus asserts across every real map
        assert_eq!(search.max_combo, crate::score::max_achievable_combo(&processed));
    }

    #[test]
    fn a_break_wholly_inside_a_gap_is_subtracted_and_a_straddling_one_is_not() {
        // one 8-second gap between two circles. with the break inside it the
        // perfect play keeps its HP; without, the passive drain empties the
        // bar and the search has to shrink the rate to survive
        let mut with_break = base_map(vec![circle(0.0), circle(8000.0)]);
        with_break.hp_drain_rate = 10.0;
        with_break.breaks = vec![BreakPeriod {
            start_time: 500.0,
            end_time: 7500.0,
        }];
        let (_, inside) = searched(&with_break);
        assert!(inside.converged);

        // the same break moved past the second object no longer lies wholly
        // in the gap, so nothing is subtracted and the search has to shrink
        // the rate further to survive the same eight seconds
        let mut straddling = with_break.clone();
        straddling.breaks = vec![BreakPeriod {
            start_time: 500.0,
            end_time: 9000.0,
        }];
        let (_, outside) = searched(&straddling);
        assert!(outside.converged);
        assert!(outside.rate < inside.rate);
        assert!(outside.iterations > inside.iterations);
    }

    #[test]
    fn below_format_eight_a_break_pays_only_its_own_length() {
        // the gap runs from the first object's end to the second's start;
        // the break covers only part of it. from version 8 up the
        // subtraction is `break.end - lastEnd`, which swallows the pre-break
        // stretch too, so the older rule drains strictly more
        let mut modern = base_map(vec![circle(0.0), circle(8000.0)]);
        modern.hp_drain_rate = 10.0;
        modern.breaks = vec![BreakPeriod {
            start_time: 4000.0,
            end_time: 7500.0,
        }];
        let mut legacy = modern.clone();
        legacy.format_version = 7;

        let (_, modern_search) = searched(&modern);
        let (_, legacy_search) = searched(&legacy);
        assert!(legacy_search.rate < modern_search.rate);
    }

    #[test]
    fn search_iteration_cap_boundary() {
        let map = sparse_high_drain_map();
        let processed = process_beatmap(&map).unwrap();
        let ctx = ScoreContext::from_beatmap(&map);

        let settled = search_with_budget(&processed, &ctx, limits::MAX_HEALTH_DRAIN_SEARCH_ITERATIONS);
        assert!(settled.converged);
        // pinned so a change to the search's arithmetic fails here rather
        // than silently moving the boundary this test is built on
        assert_eq!(settled.iterations, EXPECTED_PASSES);

        // accepts at exactly the passes it needs
        let at_limit = search_with_budget(&processed, &ctx, EXPECTED_PASSES);
        assert_eq!(at_limit, settled);

        // and one short trips into lazer's escape, reported rather than
        // raised: zero drain, unit multipliers, a perfect play that never
        // leaves the ceiling, and the pass count equal to the budget
        let tripped = search_with_budget(&processed, &ctx, EXPECTED_PASSES - 1);
        assert!(!tripped.converged);
        assert_eq!(tripped.iterations, EXPECTED_PASSES - 1);
        assert_eq!(tripped.rate, 0.0);
        assert_eq!(tripped.normal_multiplier, 1.0);
        assert_eq!(tripped.combo_end_multiplier, 1.0);
        assert_eq!(tripped.hp_after_perfect_play, vec![MAX_HP; 3]);
        assert_eq!(tripped.max_combo, 3);

        // a zero budget is the degenerate trip, not a panic or an empty
        // vector
        let none = search_with_budget(&processed, &ctx, 0);
        assert!(!none.converged);
        assert_eq!(none.iterations, 0);
        assert_eq!(none.hp_after_perfect_play.len(), 3);
    }

    #[test]
    fn crafted_maps_return_without_panicking() {
        // non-finite and extreme times, a zero-duration slider, a
        // spinner-only map, and a break wider than the object span. each
        // must answer; none may panic in debug or release
        let mut nonfinite = base_map(vec![circle(f64::NAN), circle(f64::INFINITY), circle(-1e308)]);
        nonfinite.hp_drain_rate = 7.5;
        let (_, search) = searched(&nonfinite);
        assert_eq!(search.hp_after_perfect_play.len(), 3);

        let mut zero_slider = base_map(vec![slider(1000.0, 0)]);
        zero_slider.timing_points = vec![TimingPoint {
            time: 0.0,
            beat_len: f64::MIN_POSITIVE,
        }];
        let (_, search) = searched(&zero_slider);
        assert_eq!(search.hp_after_perfect_play.len(), 1);

        let (_, search) = searched(&base_map(vec![
            spinner(0.0, 30_000.0),
            spinner(40_000.0, 1.0),
            // a duration whose half-spin requirement dwarfs the exact-gain
            // budget: the fold-the-remainder branch, and the reason it
            // exists
            spinner(50_000.0, 1e12),
        ]));
        assert_eq!(search.max_combo, 3);
        assert!(search.hp_after_perfect_play.iter().all(|v| v.is_finite()));

        let mut wide_break = base_map(vec![circle(1000.0), circle(2000.0)]);
        wide_break.breaks = vec![BreakPeriod {
            start_time: -1e9,
            end_time: 1e9,
        }];
        let (_, search) = searched(&wide_break);
        assert_eq!(search.hp_after_perfect_play.len(), 2);

        // the FIRST object at a time that saturates the `as i64` cast: the
        // gap arithmetic starts at `start - preempt` and every subsequent
        // step subtracts from it, so a saturated first object is where an
        // i64 overflow would land. the non-finite map above misses this --
        // its first time is NaN, which casts to zero
        let mut saturating = base_map(vec![circle(-1e308), circle(1e308), circle(2000.0)]);
        saturating.breaks = vec![BreakPeriod {
            start_time: -1e308,
            end_time: 1e308,
        }];
        let (processed, search) = searched(&saturating);
        assert_eq!(search.hp_after_perfect_play.len(), 3);
        // the runtime windows open at the same saturated gap start and are
        // not reached through `searched`
        assert!(!drain_windows(&processed).is_empty());
    }

    /// passes `sparse_high_drain_map` needs, measured once and pinned
    const EXPECTED_PASSES: u32 = 77;

    // -----------------------------------------------------------------
    // the runtime fold
    // -----------------------------------------------------------------

    use crate::simulation::{JudgementEvent, SpinnerIncrement, SpinnerScoring};

    fn event(time: f64, object_index: usize, kind: JudgementKind) -> JudgementEvent {
        JudgementEvent {
            time,
            object_index,
            kind,
            combo_after: 0,
            accuracy_after: 1.0,
        }
    }

    fn timeline(events: Vec<JudgementEvent>) -> JudgementTimeline {
        JudgementTimeline {
            events,
            totals: crate::simulation::HitTotals::default(),
            spinner_scoring: Vec::new(),
        }
    }

    #[test]
    fn gains_follow_stables_per_result_table() {
        // N and C are deliberately distinct so a term scaled by the wrong
        // one shows up
        let (n, c) = (2.0, 3.0);
        for hp in [0.0, 5.0, 10.0] {
            assert_eq!(object_result_gain(HitGrade::Great, None, hp, n, c), n * 6.0);
            assert_eq!(
                object_result_gain(HitGrade::Ok, None, hp, n, c),
                n * difficulty_range(hp, 17.6, 2.2, 2.2)
            );
            assert_eq!(
                object_result_gain(HitGrade::Meh, None, hp, n, c),
                n * difficulty_range(hp, 3.2, 0.4, 0.4)
            );
            // a miss is the one row the normal multiplier does not scale
            assert_eq!(
                object_result_gain(HitGrade::Miss, None, hp, n, c),
                difficulty_range(hp, -6.0, -25.0, -40.0)
            );
            assert_eq!(slider_part_miss(hp), difficulty_range(hp, -4.0, -15.0, -28.0));

            // the addition rides on top of the base gain, scaled by C
            for (addition, weight) in [
                (ComboEndAddition::Mu, 6.0),
                (ComboEndAddition::Katu, 10.0),
                (ComboEndAddition::Geki, 14.0),
            ] {
                assert_eq!(
                    object_result_gain(HitGrade::Great, Some(addition), hp, n, c),
                    n * 6.0 + c * weight
                );
            }
        }

        // the HP-dependent rows really do move with HP (lazer's own legacy
        // port flattens both, which is what this pins against)
        assert!(
            object_result_gain(HitGrade::Ok, None, 0.0, 1.0, 1.0)
                > object_result_gain(HitGrade::Ok, None, 10.0, 1.0, 1.0) * 7.0
        );

        // slider parts
        let gain = |kind| event_gain(&kind, None, 5.0, n, c).unwrap();
        assert_eq!(gain(JudgementKind::SliderTick { hit: true }).0, n * 3.0);
        assert_eq!(gain(JudgementKind::SliderHead { hit: true }).0, n * 4.0);
        assert_eq!(gain(JudgementKind::SliderTail { hit: true }).0, n * 4.0);
        assert_eq!(
            gain(JudgementKind::SliderRepeat {
                hit: true,
                repeat_index: 0
            })
            .0,
            n * 4.0
        );
        for missed in [
            JudgementKind::SliderTick { hit: false },
            JudgementKind::SliderHead { hit: false },
            JudgementKind::SliderTail { hit: false },
            JudgementKind::SliderRepeat {
                hit: false,
                repeat_index: 1,
            },
        ] {
            assert_eq!(gain(missed).0, slider_part_miss(5.0));
        }
    }

    #[test]
    fn only_object_level_results_sample() {
        let samples = |kind| event_gain(&kind, None, 5.0, 1.0, 1.0).map(|(_, s)| s);
        for object_level in [
            JudgementKind::Circle(HitGrade::Great),
            JudgementKind::SliderAggregate(HitGrade::Meh),
            JudgementKind::SpinnerFinal(HitGrade::Miss),
        ] {
            assert_eq!(samples(object_level), Some(true));
        }
        for part in [
            JudgementKind::SliderHead { hit: true },
            JudgementKind::SliderTick { hit: false },
            JudgementKind::SliderTail { hit: true },
            JudgementKind::SliderRepeat {
                hit: true,
                repeat_index: 0,
            },
        ] {
            assert_eq!(samples(part), Some(false), "slider parts gain without sampling");
        }
        // the two presentation events neither gain nor sample
        assert_eq!(samples(JudgementKind::SpinnerSpin), None);
        assert_eq!(samples(JudgementKind::SpinnerBonus), None);
    }

    #[test]
    fn the_runtime_window_opens_at_the_first_objects_start_not_its_approach() {
        let processed = process_beatmap(&base_map(vec![circle(5000.0), circle(6000.0)])).unwrap();
        let windows = drain_windows(&processed);
        assert_eq!(
            windows,
            vec![DrainWindow {
                start: 5000.0,
                end: 6000.0
            }]
        );
        // the search's own first gap DOES back up by the preempt, and the
        // two are carried separately for exactly that reason
        assert_eq!(processed.preempt, 600.0);
    }

    #[test]
    fn a_break_splits_the_windows_and_below_format_eight_ends_at_its_start() {
        let mut map = base_map(vec![circle(1000.0), circle(9000.0)]);
        map.breaks = vec![BreakPeriod {
            start_time: 2000.0,
            end_time: 8000.0,
        }];
        let modern = process_beatmap(&map).unwrap();
        assert_eq!(
            drain_windows(&modern),
            vec![
                // the window closes at the last object end BEFORE the break
                DrainWindow {
                    start: 1000.0,
                    end: 1000.0
                },
                DrainWindow {
                    start: 9000.0,
                    end: 9000.0
                },
            ]
        );

        // below format 8 the window runs into the break, closing at its start
        map.format_version = 7;
        let legacy = process_beatmap(&map).unwrap();
        assert_eq!(drain_windows(&legacy)[0].end, 2000.0);
    }

    #[test]
    fn drain_is_clipped_to_the_windows_and_quartered_inside_a_spinner() {
        let map = base_map(vec![circle(1000.0), spinner(2000.0, 1000.0), circle(4000.0)]);
        let processed = process_beatmap(&map).unwrap();
        let windows = drain_windows(&processed);
        assert_eq!(
            windows,
            vec![DrainWindow {
                start: 1000.0,
                end: 4000.0
            }]
        );

        // before the window opens: nothing drains, however far back we start
        let mut drain = Drain::new(1.0, &windows, &processed);
        assert_eq!(drain.amount_to(1000.0), 0.0);
        // 1000..2000 is plain, 2000..3000 is spinner-active, 3000..4000 plain
        assert_eq!(drain.amount_to(2000.0), 1000.0);
        assert_eq!(drain.amount_to(3000.0), 1000.0 * SPINNER_DRAIN_SCALE);
        assert_eq!(drain.amount_to(4000.0), 1000.0);
        // and past the window's end nothing more drains
        assert_eq!(drain.amount_to(9999.0), 0.0);

        // one span straddling every edge answers the same as the pieces
        let mut whole = Drain::new(1.0, &windows, &processed);
        assert_eq!(whole.amount_to(9999.0), 2000.0 + 1000.0 * SPINNER_DRAIN_SCALE);

        // an event landing exactly on a boundary drains up to it and no
        // further -- the window is closed at both ends
        let mut edges = Drain::new(1.0, &windows, &processed);
        assert_eq!(edges.amount_to(1000.0), 0.0);
        assert_eq!(edges.amount_to(4000.0), 2000.0 + 1000.0 * SPINNER_DRAIN_SCALE);
    }

    /// the piece walk behind the one-number drain: every slope change inside
    /// a span is its own segment, and nothing else moves
    #[test]
    fn the_walk_yields_one_segment_per_slope_change_summing_to_the_one_number_call() {
        // one window 1000..6000 with a break splitting it, and a disc inside
        // the second half: a single span from 1500 to 5500 crosses a window
        // end, a window start and both spinner edges
        let mut map = base_map(vec![
            circle(1000.0),
            circle(2000.0),
            circle(4000.0),
            spinner(4500.0, 500.0),
            circle(6000.0),
        ]);
        map.breaks = vec![BreakPeriod {
            start_time: 2100.0,
            end_time: 3900.0,
        }];
        let processed = process_beatmap(&map).unwrap();
        let windows = drain_windows(&processed);
        assert_eq!(
            windows,
            vec![
                DrainWindow {
                    start: 1000.0,
                    end: 2000.0
                },
                DrainWindow {
                    start: 4000.0,
                    end: 6000.0
                }
            ]
        );

        let mut walked = Drain::new(1.0, &windows, &processed);
        // the fold has already drained to 1500 when the span under test opens
        walked.amount_to(1500.0);
        let mut segments = Vec::new();
        let total = walked.walk_to(5500.0, |s| segments.push(s));
        assert_eq!(
            segments,
            vec![
                // the first window, up to where it closes
                DrainSegment {
                    start: 1500.0,
                    end: 2000.0,
                    amount: 500.0
                },
                // the break is the hole between the two segments -- nothing
                // is reported across it
                DrainSegment {
                    start: 4000.0,
                    end: 4500.0,
                    amount: 500.0
                },
                DrainSegment {
                    start: 4500.0,
                    end: 5000.0,
                    amount: 500.0 * SPINNER_DRAIN_SCALE
                },
                DrainSegment {
                    start: 5000.0,
                    end: 5500.0,
                    amount: 500.0
                },
            ]
        );
        assert!(
            segments.windows(2).all(|pair| pair[0].end <= pair[1].start),
            "the pieces are reported in time order and never overlap"
        );
        assert_eq!(segments.iter().map(|s| s.amount).sum::<f64>(), total);

        // and the one-number call over the same span answers that sum
        let mut summed = Drain::new(1.0, &windows, &processed);
        summed.amount_to(1500.0);
        assert_eq!(summed.amount_to(5500.0), total);
    }

    #[test]
    fn a_span_outside_every_window_yields_nothing_and_a_boundary_yields_nothing_past_it() {
        let map = base_map(vec![circle(1000.0), spinner(2000.0, 1000.0), circle(4000.0)]);
        let processed = process_beatmap(&map).unwrap();
        let windows = drain_windows(&processed);

        // the stretch before the window opens is outside it entirely
        let mut before = Drain::new(1.0, &windows, &processed);
        let mut segments = Vec::new();
        assert_eq!(before.walk_to(1000.0, |s| segments.push(s)), 0.0);
        assert!(segments.is_empty(), "nothing drains before the window opens");

        // an event landing exactly on the window's end yields the window and
        // nothing past it, and the stretch after it yields nothing at all
        let mut edges = Drain::new(1.0, &windows, &processed);
        let mut walked = Vec::new();
        edges.walk_to(4000.0, |s| walked.push(s));
        assert_eq!(walked.last().map(|s| s.end), Some(4000.0));
        let mut past = Vec::new();
        assert_eq!(edges.walk_to(9999.0, |s| past.push(s)), 0.0);
        assert!(past.is_empty(), "the last window is closed at its end");
    }

    #[test]
    fn overlapping_spinners_cover_their_union_once() {
        // a crafted map's overlapping discs must not charge the same
        // millisecond twice: four of them would otherwise drive the
        // integral negative and turn the passive drain into a gain
        let map = base_map(vec![
            circle(1000.0),
            spinner(2000.0, 1000.0),
            spinner(2200.0, 1000.0),
            spinner(2400.0, 1000.0),
            spinner(2600.0, 1000.0),
            circle(6000.0),
        ]);
        let processed = process_beatmap(&map).unwrap();
        let windows = drain_windows(&processed);
        let mut drain = Drain::new(1.0, &windows, &processed);
        // the four discs span 2000..3600 as one region
        assert_eq!(drain.spinners, vec![(2000.0, 3600.0)]);

        let whole = drain.amount_to(6000.0);
        let plain = 5000.0 - 1600.0;
        assert_eq!(whole, plain + 1600.0 * SPINNER_DRAIN_SCALE);
        assert!(whole > 0.0, "the passive drain can never run backwards");

        // and the PIECES cover it once too, which is the invariant the merge
        // exists for: unmerged spans would hand the walk a cut moving
        // backwards, charging the overlap twice and reporting pieces out of
        // order. the four discs are one quartered piece between two plain ones
        let mut walked = Drain::new(1.0, &windows, &processed);
        let mut segments = Vec::new();
        assert_eq!(walked.walk_to(6000.0, |s| segments.push(s)), whole);
        assert_eq!(
            segments,
            vec![
                DrainSegment {
                    start: 1000.0,
                    end: 2000.0,
                    amount: 1000.0
                },
                DrainSegment {
                    start: 2000.0,
                    end: 3600.0,
                    amount: 1600.0 * SPINNER_DRAIN_SCALE
                },
                DrainSegment {
                    start: 3600.0,
                    end: 6000.0,
                    amount: 2400.0
                },
            ]
        );
        assert!(segments.windows(2).all(|pair| pair[0].end <= pair[1].start));
    }

    /// a two-object map (a spinner then a circle) whose HP arithmetic is
    /// easy to follow: HP 10 makes the recovery threshold zero, and the
    /// search settles on the seeded rate
    fn spinner_then_circle() -> (ProcessedBeatmap, ScoreContext, DrainRateSearch) {
        let mut map = base_map(vec![spinner(1000.0, 2000.0), circle(3100.0)]);
        map.hp_drain_rate = 10.0;
        let processed = process_beatmap(&map).unwrap();
        let ctx = ScoreContext::from_beatmap(&map);
        let search = drain_rate_search(&processed, &ctx);
        (processed, ctx, search)
    }

    #[test]
    fn a_spinner_increment_lands_before_the_event_holding_its_emission_position() {
        let (processed, ctx, search) = spinner_then_circle();
        // one increment recorded at the spinner's midpoint, emitted before
        // the circle's judgement (index 1) but after the spinner's own
        // final (index 0)
        // the spinner is missed, so HP sits well under the perfect curve
        // and the circle's sample is free to move rather than clamping at 1
        let mut with_increments = timeline(vec![
            event(3000.0, 0, JudgementKind::SpinnerFinal(HitGrade::Miss)),
            event(3100.0, 1, JudgementKind::Circle(HitGrade::Great)),
        ]);
        with_increments.spinner_scoring = vec![SpinnerScoring {
            object_index: 0,
            scoring_half_spins: 2,
            increments: vec![
                // the first half turn earns nothing at all
                SpinnerIncrement {
                    time: 1500.0,
                    emission_index: 1,
                },
                SpinnerIncrement {
                    time: 2000.0,
                    emission_index: 1,
                },
            ],
        }];

        let bare = derive_health_with_search(
            &processed,
            &timeline(with_increments.events.clone()),
            &ctx,
            search.clone(),
        );
        let with = derive_health_with_search(&processed, &with_increments, &ctx, search);

        // the spinner's own sample (index 0) is emitted BEFORE the
        // increments' emission position, so it cannot see their gain
        assert_eq!(bare.samples[0], with.samples[0]);
        // the circle's does: the second half turn is worth 1.7N
        assert!(with.samples[1].value > bare.samples[1].value);
    }

    #[test]
    fn overlapping_increments_merge_by_time_not_by_disc() {
        // two crafted discs turning in the same frames with no judgement
        // emitted between them: every increment carries the SAME emission
        // position, so the merge has to fall back to time there. flattening
        // disc by disc instead hands `Drain` one disc's whole run before the
        // other's first turn, and it cannot rewind -- the second disc's
        // gains then land against a drain already charged, which the 0..200
        // clamp turns into a different sample
        let map = base_map(vec![
            spinner(1000.0, 4000.0),
            spinner(1200.0, 4000.0),
            circle(6000.0),
        ]);
        let processed = process_beatmap(&map).unwrap();
        let ctx = ScoreContext::from_beatmap(&map);
        // a hand-built search: the clamp only bites at a drain steep enough
        // to floor a perfect start, which no real map's rate reaches
        let search = DrainRateSearch {
            rate: 0.5,
            normal_multiplier: 20.0,
            combo_end_multiplier: 1.0,
            hp_after_perfect_play: vec![MAX_HP; 3],
            max_combo: 3,
            iterations: 1,
            converged: true,
        };
        let disc = |object_index, first, second| SpinnerScoring {
            object_index,
            scoring_half_spins: 2,
            increments: vec![
                // the first half turn of a disc earns nothing, so each of
                // these contributes exactly its second increment's gain
                SpinnerIncrement {
                    time: first,
                    emission_index: 0,
                },
                SpinnerIncrement {
                    time: second,
                    emission_index: 0,
                },
            ],
        };
        let events = vec![
            event(5000.0, 0, JudgementKind::SpinnerFinal(HitGrade::Meh)),
            event(5200.0, 1, JudgementKind::SpinnerFinal(HitGrade::Meh)),
            event(6000.0, 2, JudgementKind::Circle(HitGrade::Great)),
        ];
        // listed in object order, the later-firing disc first
        let mut listed = timeline(events.clone());
        listed.spinner_scoring = vec![disc(0, 1500.0, 4500.0), disc(1, 2000.0, 4000.0)];

        let gains = spin_gains(&processed, &listed, search.normal_multiplier);
        assert!(
            gains.windows(2).all(|w| w[0].time <= w[1].time),
            "increments sharing an emission position merge in firing order"
        );

        // and the fold cannot depend on which record happens to be listed
        // first -- only on when the turns fired
        let mut swapped = timeline(events);
        swapped.spinner_scoring = vec![disc(1, 2000.0, 4000.0), disc(0, 1500.0, 4500.0)];
        assert_eq!(
            derive_health_with_search(&processed, &listed, &ctx, search.clone()).samples,
            derive_health_with_search(&processed, &swapped, &ctx, search).samples
        );
    }

    #[test]
    fn samples_are_f32_at_record_time_and_a_dead_divisor_is_skipped() {
        let (processed, ctx, mut search) = spinner_then_circle();
        let events = timeline(vec![
            event(3000.0, 0, JudgementKind::SpinnerFinal(HitGrade::Great)),
            // 2^24 + 1 is the first millisecond an f32 cannot hold exactly,
            // which is stable's own truncation and not a rounding choice
            event(16_777_217.0, 1, JudgementKind::Circle(HitGrade::Great)),
        ]);
        let curve = derive_health_with_search(&processed, &events, &ctx, search.clone());
        assert_eq!(curve.samples.len(), 2);
        assert_eq!(curve.samples[1].time, 16_777_216.0);

        // a non-positive divisor degrades to a skipped sample
        search.hp_after_perfect_play[1] = 0.0;
        let skipped = derive_health_with_search(&processed, &events, &ctx, search.clone());
        assert_eq!(skipped.samples.len(), 1);

        // as does one the vector does not cover at all
        search.hp_after_perfect_play.clear();
        assert!(derive_health_with_search(&processed, &events, &ctx, search)
            .samples
            .is_empty());
    }

    #[test]
    fn a_failed_play_keeps_sampling_past_zero() {
        // decision 2: no truncation rule. HP clamps at zero on the run of
        // misses and the curve carries on -- and here it climbs back, which
        // is exactly what stable's header could never show
        let mut map = base_map((0..8).map(|i| circle(1000.0 + i as f64 * 400.0)).collect());
        map.hp_drain_rate = 10.0;
        let processed = process_beatmap(&map).unwrap();
        let ctx = ScoreContext::from_beatmap(&map);
        let search = drain_rate_search(&processed, &ctx);
        let events = timeline(
            (0..8)
                .map(|i| {
                    let grade = if i < 5 { HitGrade::Miss } else { HitGrade::Great };
                    event(1000.0 + i as f64 * 400.0, i, JudgementKind::Circle(grade))
                })
                .collect(),
        );
        let curve = derive_health_with_search(&processed, &events, &ctx, search);
        assert_eq!(curve.samples.len(), 8, "every object still samples");
        assert_eq!(curve.samples[4].value, 0.0, "the misses bottom the bar out");
        assert!(
            curve.samples[7].value > curve.samples[4].value,
            "and it recovers past the fail instead of being truncated"
        );
    }

    #[test]
    fn a_sample_value_formats_as_stable_writes_it() {
        assert_eq!(format_graph_number(1.0), "1");
        assert_eq!(format_graph_number(0.0), "0");
        assert_eq!(format_graph_number(0.9), "0.9");
        // trailing zeros trimmed: 0.90 prints as 0.9, not 0.90
        assert_eq!(format_graph_number(0.8999), "0.9");
        assert_eq!(format_graph_number(0.86), "0.86");
        assert_eq!(format_graph_number(0.8642), "0.86");
        // .net Math.Round is banker's: a midpoint goes to the even hundredth
        assert_eq!(format_graph_number(0.125), "0.12");
        assert_eq!(format_graph_number(0.135), "0.14");
        // a time prints integral for any map under 2^24 ms
        assert_eq!(format_graph_number(24_672.0), "24672");
        assert_eq!(format_graph_number(0.0), "0");
    }

    fn sample(time: f32, value: f32) -> LifeBarSample {
        LifeBarSample { time, value }
    }

    #[test]
    fn the_thinning_gate_is_strict_at_two_seconds() {
        // exactly 2000 ms past the last emitted sample is NOT emitted, 2001
        // is. the middle sample is the one under test either way
        let at_gate = life_bar_graph(&[sample(0.0, 1.0), sample(2000.0, 0.9), sample(9000.0, 0.8)]);
        assert_eq!(at_gate, "0|1,9000|0.8,");

        let past_gate = life_bar_graph(&[sample(0.0, 1.0), sample(2001.0, 0.9), sample(9000.0, 0.8)]);
        assert_eq!(past_gate, "0|1,2001|0.9,9000|0.8,");
    }

    #[test]
    fn the_gate_measures_from_the_last_emitted_sample_not_the_last_seen() {
        // three samples 1500 ms apart: the second is swallowed, and the
        // third is emitted because it is 3000 ms past the FIRST -- the one
        // that was actually written
        let graph = life_bar_graph(&[
            sample(0.0, 1.0),
            sample(1500.0, 0.9),
            sample(3000.0, 0.8),
            sample(4000.0, 0.7),
        ]);
        assert_eq!(graph, "0|1,3000|0.8,4000|0.7,");
    }

    #[test]
    fn the_first_and_last_samples_are_always_emitted() {
        assert_eq!(life_bar_graph(&[]), "");
        assert_eq!(life_bar_graph(&[sample(1234.0, 1.0)]), "1234|1,");
        // two samples well inside the gate: both still written
        assert_eq!(
            life_bar_graph(&[sample(0.0, 1.0), sample(10.0, 0.5)]),
            "0|1,10|0.5,"
        );
    }

    #[test]
    fn the_gate_subtracts_the_stored_f32_times() {
        // past 2^24 ms an f32 cannot hold consecutive milliseconds, so the
        // gate is decided on the quantised values -- these two are 2048 ms
        // apart as f32 and the second is emitted
        let far = 16_777_216.0f32;
        let graph = life_bar_graph(&[
            sample(far, 1.0),
            sample(far + 2048.0, 0.5),
            sample(far + 4096.0, 0.25),
        ]);
        assert_eq!(graph, "16777216|1,16779264|0.5,16781312|0.25,");
    }

    // ----- the HP curve -----

    #[test]
    fn the_curve_reads_full_before_its_first_point_and_holds_after_its_last() {
        let empty = HealthCurve {
            search: crate::score::drain_rate_search(
                &process_beatmap(&base_map(Vec::new())).unwrap(),
                &ScoreContext::from_beatmap(&base_map(Vec::new())),
            ),
            samples: Vec::new(),
            points: Vec::new(),
        };
        assert_eq!(empty.fraction_at(0.0), 1.0, "an empty curve is full everywhere");
        assert_eq!(empty.fraction_at(-1e9), 1.0);

        let curve = HealthCurve {
            points: vec![
                HealthPoint {
                    time: 1000.0,
                    fraction: 1.0,
                },
                HealthPoint {
                    time: 2000.0,
                    fraction: 0.5,
                },
                // a jump: two points at one millisecond
                HealthPoint {
                    time: 2000.0,
                    fraction: 0.9,
                },
                HealthPoint {
                    time: 3000.0,
                    fraction: 0.7,
                },
            ],
            ..empty
        };
        assert_eq!(curve.fraction_at(0.0), 1.0, "full before the first point");
        assert_eq!(curve.fraction_at(1500.0), 0.75, "linear between two points");
        assert_eq!(curve.fraction_at(2000.0), 0.9, "the post-gain value at the jump");
        assert_eq!(curve.fraction_at(2500.0), 0.8);
        assert_eq!(curve.fraction_at(9999.0), 0.7, "the last value after the last point");
        assert_eq!(curve.hp_at(3000.0), 0.7 * MAX_HP);
    }

    #[test]
    fn the_curve_breaks_where_the_slope_does_and_lands_on_the_samples_own_hp() {
        // a spinner then a circle, so one fold crosses a spinner edge, a
        // window edge and two gains
        let (processed, ctx, search) = spinner_then_circle();
        let events = timeline(vec![
            event(3000.0, 0, JudgementKind::SpinnerFinal(HitGrade::Great)),
            event(3100.0, 1, JudgementKind::Circle(HitGrade::Miss)),
        ]);
        let curve = derive_health_with_search(&processed, &events, &ctx, search);

        assert_eq!(
            curve.points.first().map(|p| p.fraction),
            Some(1.0),
            "HP starts full"
        );
        // every breakpoint the fold laid is at or after the window's start,
        // and the list is in time order
        assert!(curve.points.windows(2).all(|pair| pair[0].time <= pair[1].time));
        // the value read at each sample's own millisecond is the HP that
        // sample was recorded from, divisor and all
        for (index, sample) in curve.samples.iter().enumerate() {
            let object = if index == 0 { 0 } else { 1 };
            let read = curve
                .life_bar_value_at(f64::from(sample.time), object)
                .expect("both objects have a live divisor");
            assert_eq!(format_graph_number(read), format_graph_number(sample.value));
        }
        // a jump sits at a judgement's own millisecond, never between two
        for pair in curve.points.windows(2) {
            if pair[0].time == pair[1].time {
                assert!(
                    events.events.iter().any(|e| e.time == pair[0].time),
                    "a jump at {} belongs to no judgement",
                    pair[0].time
                );
            }
        }
    }

    #[test]
    fn a_draining_curve_breaks_at_the_zero_it_reaches() {
        // a map whose drain is savage enough to empty the bar between two
        // objects, so the flat that follows is a segment of its own
        let map = sparse_high_drain_map();
        let processed = process_beatmap(&map).unwrap();
        let ctx = ScoreContext::from_beatmap(&map);
        let mut search = drain_rate_search(&processed, &ctx);
        search.rate = 1.0;
        let events = timeline(vec![
            event(1000.0, 0, JudgementKind::Circle(HitGrade::Great)),
            event(60_000.0, 1, JudgementKind::Circle(HitGrade::Great)),
        ]);
        let curve = derive_health_with_search(&processed, &events, &ctx, search);

        let zero = curve
            .points
            .iter()
            .position(|p| p.fraction == 0.0)
            .expect("a rate of one HP per millisecond empties the bar inside a minute");
        assert!(
            curve.points[zero].time < 60_000.0,
            "the crossing is where the drain reached zero, not where the next judgement landed"
        );
        // and the stretch after it is flat at zero rather than sloping on
        let after = curve.points[zero].time;
        assert_eq!(curve.fraction_at(after + 1.0), 0.0);
        assert_eq!(curve.fraction_at(59_000.0), 0.0);
    }

    #[test]
    fn an_object_free_map_has_no_curve() {
        let map = base_map(Vec::new());
        let processed = process_beatmap(&map).unwrap();
        let curve = derive_health(&processed, &timeline(Vec::new()), &ScoreContext::from_beatmap(&map));
        assert!(curve.points.is_empty());
        assert!(curve.samples.is_empty());
    }

    // ----- the header-versus-fold comparison -----

    #[test]
    fn an_unreadable_graph_scores_nothing_rather_than_failing() {
        let samples = [sample(0.0, 1.0)];
        let empty = compare_life_bar_graph("", &samples);
        assert_eq!((empty.total(), empty.matched, empty.malformed), (0, 0, 0));
        assert!(!empty.header_failed);

        // a torn pair is reported, never counted against the total
        let torn = compare_life_bar_graph("0|1,nonsense,2000|0.5,", &samples);
        assert_eq!((torn.total(), torn.malformed), (2, 1));
        // and a pair whose time is not an integer is the same kind of tear
        let fractional = compare_life_bar_graph("0.5|1,", &samples);
        assert_eq!((fractional.total(), fractional.malformed), (0, 1));

        // a header with no simulated samples to score against matches
        // nothing, and says so rather than claiming a nearest
        let unsimulated = compare_life_bar_graph("0|1,", &[]);
        assert_eq!((unsimulated.total(), unsimulated.matched), (1, 0));
        assert_eq!(unsimulated.pairs[0].nearest, None);
        assert_eq!(unsimulated.pairs[0].offset(), None);
    }

    #[test]
    fn the_nearest_sample_scores_the_pair_and_the_first_wins_a_tie() {
        // the header's time sits exactly between two samples: the FIRST is
        // the one that scores it
        let samples = [sample(0.0, 1.0), sample(1000.0, 0.9), sample(2000.0, 0.8)];
        let tied = compare_life_bar_graph("1500|0.9,", &samples);
        assert_eq!(tied.pairs[0].nearest.as_ref().map(|n| n.time), Some(1000.0));
        assert_eq!(tied.matched, 1);

        // one millisecond past the midpoint and the later sample wins
        let later = compare_life_bar_graph("1501|0.8,", &samples);
        assert_eq!(later.pairs[0].nearest.as_ref().map(|n| n.time), Some(2000.0));
        assert_eq!(later.matched, 1);
        assert_eq!(later.pairs[0].offset(), Some(499.0));
    }

    /// the scan the index replaced, kept here as the oracle it is answerable
    /// to: the nearest sample by absolute time distance under `total_cmp`,
    /// the first winning a tie
    fn scanned(samples: &[LifeBarSample], header_time: i64) -> Option<NearestSample> {
        samples
            .iter()
            .min_by(|a, b| {
                let da = (f64::from(a.time) - header_time as f64).abs();
                let db = (f64::from(b.time) - header_time as f64).abs();
                da.total_cmp(&db)
            })
            .map(|sample| NearestSample {
                time: sample.time,
                value: format_graph_number(sample.value),
            })
    }

    /// over the awkward sample sets against a spread of header times: the
    /// tidy case is not where a binary search goes wrong. the two shapes
    /// where the two DO part are pinned by the test below
    #[test]
    fn the_sample_index_answers_exactly_what_a_scan_would() {
        // the awkward sets, not the tidy one: repeated times (where the tie
        // rule picks the earliest EMITTED, not the last stored), times out of
        // order (a 2B map judges a long slider after a circle inside it), and
        // the non-finite times only a crafted map produces
        let sets: Vec<Vec<LifeBarSample>> = vec![
            Vec::new(),
            vec![sample(0.0, 1.0)],
            vec![sample(0.0, 1.0), sample(1000.0, 0.9), sample(2000.0, 0.8)],
            vec![sample(1000.0, 0.5), sample(1000.0, 0.4), sample(1000.0, 0.3)],
            vec![sample(5000.0, 0.2), sample(1000.0, 0.9), sample(3000.0, 0.5)],
            vec![sample(f32::NAN, 0.7), sample(1000.0, 0.9)],
            vec![sample(f32::NAN, 0.7), sample(f32::NAN, 0.6)],
            vec![sample(f32::NEG_INFINITY, 0.7), sample(f32::INFINITY, 0.6)],
            // the same instant written two ways: `total_cmp` separates the
            // zeroes where every numeric comparison calls them equal
            vec![sample(-0.0, 0.7), sample(0.0, 0.6)],
            vec![sample(0.0, 0.6), sample(-0.0, 0.7)],
            vec![sample(f32::INFINITY, 0.6), sample(f32::NEG_INFINITY, 0.7)],
        ];
        // compared through the time's BITS: a sample stamped NaN is a real
        // answer here, and `PartialEq` would call it unequal to itself
        let identity = |nearest: Option<NearestSample>| nearest.map(|n| (n.time.to_bits(), n.value));
        for samples in &sets {
            let ordered = index_samples(samples);
            for header_time in [-5000i64, -1, 0, 1, 999, 1000, 1001, 1500, 2000, 4000, 100_000] {
                assert_eq!(
                    identity(nearest_sample(samples, &ordered, header_time)),
                    identity(scanned(samples, header_time)),
                    "samples {samples:?} at t={header_time}"
                );
            }
        }
    }

    /// the shapes where the indexed lookup and the scan pick different
    /// samples, from their two separate causes: rounding flattening distinct
    /// times onto one distance, and the all-NaN fallback, which owes nothing
    /// to rounding. neither shape is one a real header and replay pair
    /// produce -- the point of pinning them is that the answer stays
    /// DECIDED, not that either pick is the better one
    #[test]
    fn the_index_and_the_scan_part_where_rounding_flattens_them() {
        // samples 1 ms apart with the header time 2^63 away: both distances
        // round to 2^63. the scan took the earliest of the flattened run,
        // while the window looks only either side of the header's own time,
        // which past the last sample leaves it holding just that one
        let samples = [sample(0.0, 0.9), sample(1.0, 0.8)];
        let ordered = index_samples(&samples);
        assert_eq!(
            nearest_sample(&samples, &ordered, i64::MAX).map(|n| n.value),
            Some("0.8".to_string())
        );
        // rounding is the whole cause: land the header on a sample exactly
        // and there is no flattened run to disagree over
        assert_eq!(
            nearest_sample(&samples, &ordered, 0).map(|n| n.value),
            scanned(&samples, 0).map(|n| n.value)
        );

        // the flattened run reached by the RATIO rather than by a huge
        // header time: samples 5e-8 ms apart and a header time of 1e9, where
        // the gap falls under half the ulp of the distance
        let close = [sample(0.0, 0.9), sample(5.0e-8, 0.8)];
        let ordered = index_samples(&close);
        assert_eq!(
            nearest_sample(&close, &ordered, 1_000_000_000).map(|n| n.value),
            Some("0.8".to_string())
        );
        // just past that half-ulp and the distances separate again, which is
        // what makes this the boundary and not a standing disagreement
        let apart = [sample(0.0, 0.9), sample(1.0e-7, 0.8)];
        let ordered = index_samples(&apart);
        assert_eq!(
            nearest_sample(&apart, &ordered, 1_000_000_000).map(|n| n.value),
            scanned(&apart, 1_000_000_000).map(|n| n.value)
        );

        // and neither pick need be the exactly-nearest one once the run is
        // flattened: 2^-64, 2 and 2^-63 all sit at a rounded distance of 1
        // from the header, the scan takes the first emitted, the window
        // takes the nearer-indexed of its two neighbours, and the truly
        // nearest sample (2^-63, the last emitted) is what neither names
        let flattened = [
            sample(f32::from_bits(0x1f80_0000), 0.1),
            sample(2.0, 0.2),
            sample(f32::from_bits(0x2000_0000), 0.3),
        ];
        let ordered = index_samples(&flattened);
        assert_eq!(
            nearest_sample(&flattened, &ordered, 1).map(|n| n.value),
            Some("0.2".to_string())
        );
        assert_eq!(scanned(&flattened, 1).map(|n| n.value), Some("0.1".to_string()));

        // every sample time NaN: nothing is nearest, so the first sample
        // scores the pair rather than whichever NaN payload sorts lowest
        let nans = [
            sample(f32::from_bits(0x7fc0_0002), 0.9),
            sample(f32::from_bits(0x7fc0_0001), 0.8),
        ];
        let ordered = index_samples(&nans);
        assert!(ordered.is_empty(), "a NaN time cannot be placed in the index");
        assert_eq!(
            nearest_sample(&nans, &ordered, 0).map(|n| n.value),
            Some("0.9".to_string())
        );
    }

    #[test]
    fn a_crafted_header_cannot_charge_a_scan_per_pair() {
        // the hazard the index closes: the header's pair count is bounded
        // only by the `.osr` size cap while the sample count is bounded by
        // the judgement count, and `IntegrityDto::compare` runs this on the
        // LOAD path. a scan per pair makes the two multiply, so this sits at
        // a size that is seconds of work that way and milliseconds this way
        let samples: Vec<LifeBarSample> = (0..20_000).map(|i| sample(i as f32 * 100.0, 0.9)).collect();
        let mut graph = String::new();
        for i in 0..200_000 {
            graph.push_str(&format!("{}|0.9,", i * 7));
        }

        let started = std::time::Instant::now();
        let comparison = compare_life_bar_graph(&graph, &samples);
        let elapsed = started.elapsed();

        assert_eq!(comparison.total(), 200_000);
        assert_eq!(comparison.matched, 200_000, "every pair reads a sample of 0.9");
        // four billion comparisons would be the scan; the bound is loose
        // enough that a slow debug build under load still passes it and
        // tight enough that a reintroduced scan cannot
        assert!(
            elapsed < std::time::Duration::from_secs(20),
            "scoring the header took {elapsed:?}, which is scan-per-pair behaviour"
        );
    }

    #[test]
    fn equality_is_the_writers_own_string_not_the_float() {
        // 0.855 rounds to 0.86 the way the writer rounds it, so the header's
        // "0.86" matches and its "0.855" does not -- the comparison never
        // reformats the header's own value
        let samples = [sample(0.0, 0.855)];
        assert_eq!(compare_life_bar_graph("0|0.86,", &samples).matched, 1);
        assert_eq!(compare_life_bar_graph("0|0.855,", &samples).matched, 0);
        // a bare integer prints bare on both sides
        assert_eq!(compare_life_bar_graph("0|1,", &[sample(0.0, 1.0)]).matched, 1);
        assert_eq!(compare_life_bar_graph("0|1.00,", &[sample(0.0, 1.0)]).matched, 0);
    }

    #[test]
    fn a_failed_header_is_truncated_at_its_first_zero() {
        // stable stops judging at the fail and writes nothing past it, while
        // the fold keeps going -- so only the pairs up to and including the
        // header's first `0` describe play the header saw. this header
        // recovers on paper, which no stable header does; the rule is the
        // first zero, not the last
        let samples = [sample(0.0, 1.0), sample(1000.0, 0.0), sample(2000.0, 0.5)];
        let failed = compare_life_bar_graph("0|1,1000|0,2000|0.5,3000|0,", &samples);
        assert!(failed.header_failed);
        assert_eq!(failed.total(), 2, "everything past the first zero is dropped");
        assert_eq!(failed.matched, 2);

        // a header that never reaches zero keeps every pair and records no fail
        let clean = compare_life_bar_graph("0|1,1000|0.9,", &[sample(0.0, 1.0), sample(1000.0, 0.9)]);
        assert!(!clean.header_failed);
        assert_eq!((clean.total(), clean.matched), (2, 2));

        // a zero that is not the LAST value is not a fail: the play carried
        // on and so does the comparison
        let recovered = compare_life_bar_graph("0|0,1000|0.9,", &[sample(0.0, 0.0), sample(1000.0, 0.9)]);
        assert!(!recovered.header_failed);
        assert_eq!((recovered.total(), recovered.matched), (2, 2));
    }
}
