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

/// everything the health port produces for one play: the map-load search
/// (which carries the per-object divisor vector, the map max combo, the
/// pass count and the converged flag) and the ordered life bar samples, one
/// per object-level judgement. the graph writer and a later HUD curve both
/// read this without re-deriving anything
#[derive(Debug, Clone, PartialEq)]
pub struct HealthCurve {
    pub search: DrainRateSearch,
    /// in judgement order, which is emission order
    pub samples: Vec<LifeBarSample>,
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
    /// intermediate millisecond would have been
    fn amount_to(&mut self, to: f64) -> f64 {
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
            let mut spun = 0.0;
            for &(start, end) in &self.spinners[self.spinner_cursor.min(self.spinners.len())..] {
                if start >= hi {
                    break;
                }
                let overlap = hi.min(end) - lo.max(start);
                if overlap > 0.0 {
                    spun += overlap;
                }
            }
            total += (hi - lo - spun) + spun * SPINNER_DRAIN_SCALE;
        }
        self.rate * total
    }
}

/// sorts and merges a span list so no millisecond is covered twice. a real
/// map never overlaps its spinners -- osu!standard has one disc at a time --
/// but a crafted one can, and the drain integral below subtracts the spun
/// portion from the plain one: double-counting it would understate the plain
/// drain and, past four fully-overlapping discs, drive the whole integral
/// NEGATIVE, turning the passive drain into a gain. merging once here makes
/// that unreachable rather than clamping around it at every read
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

/// every spinner's counted half turns as HP gains, in firing order. the
/// FIRST half turn of a spinner earns nothing; after it a turn is a bonus
/// (2N) when it sits past `required + 3` by an even amount, else a spin
/// (1.7N) -- the same gate `score::scorev1` folds the total through
fn spin_gains(processed: &ProcessedBeatmap, timeline: &JudgementTimeline, normal: f64) -> Vec<SpinGain> {
    let mut gains = Vec::new();
    for scoring in &timeline.spinner_scoring {
        let Some(object) = processed.objects.get(scoring.object_index) else {
            continue;
        };
        let ProcessedKind::Spinner(spinner) = &object.kind else {
            continue;
        };
        // i64 throughout: a crafted requirement can sit at i32::MAX, where
        // `required + 3` would overflow
        let gate = i64::from(spinner.stable_half_spins_required) + 3;
        for (index, increment) in scoring.increments.iter().enumerate() {
            let half = index as i64 + 1;
            if half <= 1 {
                continue;
            }
            let bonus = half > gate && (half - gate) % 2 == 0;
            gains.push(SpinGain {
                emission_index: increment.emission_index,
                time: increment.time,
                amount: if bonus { normal * 2.0 } else { normal * 1.7 },
            });
        }
    }
    // emission position first -- it is the only key that places an
    // increment against a judgement stamped with the same millisecond --
    // then TIME, because the gains were collected one disc at a time and a
    // crafted map can leave two discs turning across the same emission
    // position (no judgement is emitted between their frames, so every
    // increment of both carries it). flattening disc by disc there would
    // hand `Drain` one disc's whole run before the other's first turn, and
    // it cannot rewind. within one disc the times are already
    // non-decreasing, so this only ever merges the discs against each other,
    // and the sort stays stable for two that turned in the very same frame
    gains.sort_by(|a, b| {
        a.emission_index
            .cmp(&b.emission_index)
            .then_with(|| a.time.total_cmp(&b.time))
    });
    gains
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
    fold_with_search(processed, timeline, ctx, search)
}

/// the fold alone, over a search a caller already has. the seam exists so
/// the fold's own tests can drive a chosen search -- a dead divisor, say --
/// without contriving a map that produces one
fn fold_with_search(
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
    let mut spin_cursor = 0usize;

    for (index, event) in timeline.events.iter().enumerate() {
        // every gain the disc earned before this event was emitted lands
        // first, each drained up to its own frame time
        while let Some(spin) = spins.get(spin_cursor).filter(|s| s.emission_index <= index) {
            let drained = drain.amount_to(spin.time);
            health.increase(-drained);
            health.increase(spin.amount);
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
        let drained = drain.amount_to(event.time);
        health.increase(-drained);
        health.increase(gain);
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

    HealthCurve { search, samples }
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

        let bare = fold_with_search(
            &processed,
            &timeline(with_increments.events.clone()),
            &ctx,
            search.clone(),
        );
        let with = fold_with_search(&processed, &with_increments, &ctx, search);

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
            fold_with_search(&processed, &listed, &ctx, search.clone()).samples,
            fold_with_search(&processed, &swapped, &ctx, search).samples
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
        let curve = fold_with_search(&processed, &events, &ctx, search.clone());
        assert_eq!(curve.samples.len(), 2);
        assert_eq!(curve.samples[1].time, 16_777_216.0);

        // a non-positive divisor degrades to a skipped sample
        search.hp_after_perfect_play[1] = 0.0;
        let skipped = fold_with_search(&processed, &events, &ctx, search.clone());
        assert_eq!(skipped.samples.len(), 1);

        // as does one the vector does not cover at all
        search.hp_after_perfect_play.clear();
        assert!(fold_with_search(&processed, &events, &ctx, search)
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
        let curve = fold_with_search(&processed, &events, &ctx, search);
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
}
