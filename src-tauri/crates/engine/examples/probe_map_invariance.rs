//! probe_map_invariance: the per-map invariance discriminator for the
//! frame-sampling slider-tracking divergence class.
//!
//! the question it answers, for every beatmap with >= 2 failing plays in the
//! sweep manifest: do ALL of that map's failing plays diverge on the SAME
//! nested slider element, in the SAME direction? a divergence that is
//! invariant across a map's plays is a MAP property -- a deterministic
//! boundary mechanism waiting to be named (two earlier classes in this pass
//! fell to exactly this test: a 5.9999998 tick-ratio boundary, and a
//! due-count valuation rule). a divergence that varies play to play is
//! cursor noise, and no arithmetic fix exists for it.
//!
//! the two directions need different evidence:
//!
//! - **engine drops** (simulated count_300 BELOW the header, or simulated
//!   count_miss above it): the dropped element is visible -- the judgement
//!   timeline carries `hit: false`, or the point never got an event at all.
//!   identity comes straight out of the timeline.
//! - **engine keeps** (simulated count_300 ABOVE the header): the element
//!   stable dropped is invisible here, because the engine scored it. so the
//!   probe mines MARGINALITY instead, through the additive trace seam in
//!   `simulation::trace`: the x87 follow-radius ratio at the judging update,
//!   the `slide_start <= point.time` gate slack, and the update's lag behind
//!   the point's own time. a candidate is an element whose failing-play
//!   conditions sit at a boundary the same element's passing-play conditions
//!   do not.
//!
//! an intersection is only an identification when it is about as small as the
//! element count the headers imply, so the verdict carries a sharpness
//! qualifier: a shared set of 55 elements on a map whose headers moved 8
//! grades has found a habit, not a mechanism, and reports as `broad`.
//!
//! `sweep_passing.json` is the falsification arena and the rule is absolute:
//! any element that a PASSING play of the same map dropped (drops direction)
//! or kept (keeps direction) is not the divergence, and the candidate dies.
//! same discipline as `probe_headmiss`.
//!
//! usage (from `src-tauri/`):
//!
//!   cargo run -p engine --release --example probe_map_invariance
//!   cargo run -p engine --release --example probe_map_invariance -- --verbose
//!   cargo run -p engine --release --example probe_map_invariance -- --ratio 0.99
//!   cargo run -p engine --release --example probe_map_invariance -- --focus Routing
//!
//! like the sweep, this is an example, never a test: ci never sees it, and it
//! always exits 0 with the numbers as its output.

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use engine::beatmap::stable_points::StablePointKind;
use engine::beatmap::{process_beatmap, ProcessedBeatmap, ProcessedKind};
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::decode_osr;
use engine::replay::frames::convert_frames;
use engine::simulation::score::JudgementKind;
use engine::simulation::{simulate, trace};

/// substrings naming the map subsets the triage brief called out as
/// map-concentrated; these get the full per-play dump before the table
const DEFAULT_FOCUS: [&str; 5] = ["USAO", "Shukusai", "Putin", "Speedrun", "FREEDOM"];

#[derive(serde::Deserialize)]
struct Entry {
    stem: String,
    replay_path: String,
    beatmap_path: String,
    /// diverging fields as the sweep recorded them; empty for passing plays
    fields: BTreeMap<String, FieldDelta>,
}

#[derive(serde::Deserialize, Clone, Copy)]
struct FieldDelta {
    header: i64,
    simulated: i64,
}

#[derive(serde::Deserialize)]
struct Manifest {
    failures: Vec<Entry>,
}

/// which way a play's counts moved against its own header. the sign
/// convention is derived from the manifest and nothing else:
/// `fields.count_300.simulated - fields.count_300.header` positive means the
/// engine awarded a Great where stable awarded an Ok, i.e. the engine
/// TRACKED an element stable dropped
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Direction {
    Keeps,
    Drops,
    Mixed,
    /// no count field moved -- only total_score (or nothing) diverged
    ScoreOnly,
}

impl Direction {
    fn label(self) -> &'static str {
        match self {
            Direction::Keeps => "keeps",
            Direction::Drops => "drops",
            Direction::Mixed => "mixed",
            Direction::ScoreOnly => "score",
        }
    }
}

/// one nested slider element's play-invariant identity. the point INDEX is
/// the identity carried across plays: kind and time are properties of the
/// map, looked up from it for printing
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
struct PointId {
    object_index: u32,
    point_index: u32,
}

/// one point's judgement conditions in one play, as the trace saw them
#[derive(Clone, Copy)]
struct Signals {
    hit: bool,
    /// cursor-to-ball distance over the allowed radius; `>= 1` is the STRICT
    /// compare's failing side, `1.0` exactly is the boundary
    ratio: f64,
    /// `point.time - slide_start`: `>= 0` passed the rescue gate
    gate: f64,
    /// how late the judging update was relative to the point's own time
    lag: f64,
    sliding_before: bool,
    acceptable: bool,
    /// the slide never started at all (slide_start still at its initial 0),
    /// which makes `gate` meaningless rather than generous
    ever_slid: bool,
    /// the update BEFORE the judging one would have scored this point. this
    /// is the "judged one replay frame too late" signature: the point was
    /// due in the gap between two frames, the earlier frame still had the
    /// player on the ball with the key down, and the later one did not
    rescued_one_update_earlier: bool,
}

/// the map-side description of a point, replicating `SliderState::new`'s own
/// list construction (including the tail reposition), so an identity printed
/// here is the identity the machine judged
#[derive(Clone, Copy)]
struct PointDesc {
    kind: StablePointKind,
    time: f64,
}

impl PointDesc {
    fn kind_label(&self) -> String {
        match self.kind {
            StablePointKind::Tick => "tick".to_string(),
            StablePointKind::Repeat { repeat_index } => format!("rep{repeat_index}"),
            StablePointKind::Tail => "tail".to_string(),
        }
    }
}

struct PlayFacts {
    stem: String,
    failing: bool,
    direction: Direction,
    d300: i64,
    d100: i64,
    d50: i64,
    dmiss: i64,
    dcombo: i64,
    /// how many object-level grades the header says moved. every flipped
    /// slider moves two counters (a Great leaves 300 and lands in 100, say),
    /// so half the summed absolute count movement is the element count the
    /// divergence is worth -- and an intersection far larger than this has
    /// not identified anything, however invariant it is
    implied_flips: i64,
    /// every judged point's conditions, for the per-element cross-play view
    signals: BTreeMap<PointId, Signals>,
    /// points the engine judged NOT hit
    dropped: BTreeSet<PointId>,
    /// points that never reached a judgement at all (the slider's end
    /// aggregate fired with them still due) -- also an engine drop
    unjudged: BTreeSet<PointId>,
    /// the subset of `dropped ∪ unjudged` on sliders where restoring one
    /// point moves the whole-slider grade
    dropped_load_bearing: BTreeSet<PointId>,
    /// points the engine judged hit
    kept: BTreeSet<PointId>,
    /// kept AND sitting at a boundary AND on a slider where losing one point
    /// moves the whole-slider grade -- the engine-keeps candidate set
    kept_marginal: BTreeSet<PointId>,
    /// grade-load-bearing dropped points that the update BEFORE the judging
    /// one would have scored -- the "judged a replay frame late" population
    rescuable: BTreeSet<PointId>,
    /// trace records whose tracking sample failed to join (must stay 0)
    orphan_samples: usize,
}

struct MapReport {
    path: String,
    plays: Vec<PlayFacts>,
    errors: Vec<String>,
    points: BTreeMap<u32, Vec<PointDesc>>,
    /// object indices whose tail point took the midpoint branch of
    /// `max(start + duration/2, end - 36)` -- sub-72ms sliders whose sole
    /// scoring window opens 25-35ms after the head instead of near the end
    midpoint_tails: BTreeSet<u32>,
}

struct Thresholds {
    /// a kept point counts as marginal at or above this follow-radius ratio
    ratio: f64,
    /// ...or with gate slack at or below this many milliseconds
    gate: f64,
}

fn main() {
    let mut verbose = false;
    let mut ratio = 0.95f64;
    let mut gate = 1.0f64;
    let mut focus: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--verbose" => verbose = true,
            "--ratio" => ratio = args.next().and_then(|v| v.parse().ok()).unwrap_or(ratio),
            "--gate" => gate = args.next().and_then(|v| v.parse().ok()).unwrap_or(gate),
            "--focus" => focus.extend(args.next()),
            other => eprintln!("probe: ignoring unknown argument {other:?}"),
        }
    }
    if focus.is_empty() {
        focus = DEFAULT_FOCUS.iter().map(|s| s.to_string()).collect();
    }
    let thresholds = Thresholds { ratio, gate };

    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/replays/local");
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(local.join("sweep_manifest.json")).expect("read manifest"))
            .expect("parse manifest");
    let passing: Vec<Entry> =
        serde_json::from_slice(&std::fs::read(local.join("sweep_passing.json")).expect("read passing"))
            .expect("parse passing");

    // group by map, keep only maps carrying at least two failing plays, then
    // pull in EVERY play of those maps -- the passing ones are the arena
    let mut failing_by_map: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
    for entry in manifest.failures {
        failing_by_map.entry(entry.beatmap_path.clone()).or_default().push(entry);
    }
    failing_by_map.retain(|_, plays| plays.len() >= 2);
    let mut passing_by_map: BTreeMap<String, Vec<Entry>> = BTreeMap::new();
    for entry in passing {
        if failing_by_map.contains_key(&entry.beatmap_path) {
            passing_by_map.entry(entry.beatmap_path.clone()).or_default().push(entry);
        }
    }
    let total: usize = failing_by_map
        .iter()
        .map(|(map, plays)| plays.len() + passing_by_map.get(map).map_or(0, |p| p.len()))
        .sum();
    eprintln!(
        "probe: {} maps with >= 2 failing plays, {total} plays to simulate",
        failing_by_map.len()
    );

    let mut reports: Vec<MapReport> = Vec::new();
    let mut done = 0usize;
    for (map_path, failing) in &failing_by_map {
        let empty: Vec<Entry> = Vec::new();
        let passing = passing_by_map.get(map_path).unwrap_or(&empty);
        let mut report = MapReport {
            path: map_path.clone(),
            plays: Vec::new(),
            errors: Vec::new(),
            points: BTreeMap::new(),
            midpoint_tails: BTreeSet::new(),
        };
        match load_map(map_path) {
            Ok(processed) => {
                (report.points, report.midpoint_tails) = map_points(&processed);
                for (entry, failing_play) in failing
                    .iter()
                    .map(|e| (e, true))
                    .chain(passing.iter().map(|e| (e, false)))
                {
                    done += 1;
                    if done % 100 == 0 {
                        eprintln!("probe: {done}/{total}");
                    }
                    match analyse(entry, &processed, &report.points, failing_play, &thresholds) {
                        Ok(facts) => report.plays.push(facts),
                        Err(problem) => report.errors.push(format!("{}: {problem}", entry.stem)),
                    }
                }
            }
            Err(problem) => {
                done += failing.len() + passing.len();
                report.errors.push(format!("map: {problem}"));
            }
        }
        reports.push(report);
    }

    let verdicts: Vec<(&MapReport, Verdict)> = reports
        .iter()
        .map(|report| (report, judge(report)))
        .collect();

    println!("== sign convention (derived from the manifest, not from prior notes) ==");
    println!("  d300 = fields.count_300.simulated - fields.count_300.header");
    println!("  d300 > 0 (or dmiss < 0)  => KEEPS: the engine tracked an element stable dropped");
    println!("  d300 < 0 (or dmiss > 0)  => DROPS: the engine dropped an element stable tracked");
    println!("  thresholds: marginal when radius ratio >= {ratio} or gate slack <= {gate}ms");

    println!("\n\n################ concentrated subsets ################");
    let mut shown = 0usize;
    for (report, verdict) in &verdicts {
        if !focus.iter().any(|f| report.path.to_lowercase().contains(&f.to_lowercase())) {
            continue;
        }
        shown += 1;
        print_detail(report, verdict, &thresholds);
    }
    if shown == 0 {
        println!("  (no qualifying map matched {focus:?})");
    }

    println!("\n\n################ all qualifying maps ({}) ################", verdicts.len());
    println!(
        "  {:<10} {:<6} {:>5}  {:<44}  map",
        "verdict", "dir", "f/p", "invariant element(s)"
    );
    for (report, verdict) in &verdicts {
        let fail = report.plays.iter().filter(|p| p.failing).count();
        let pass = report.plays.len() - fail;
        let elements = verdict.describe_elements(report);
        println!(
            "  {:<10} {:<6} {:>5}  {:<44}  {}",
            verdict.tag_with_arena(report),
            verdict.direction.label(),
            format!("{fail}/{pass}"),
            elements,
            short_name(&report.path)
        );
        if !report.errors.is_empty() {
            for problem in &report.errors {
                println!("    ERROR {problem}");
            }
        }
    }

    if verbose {
        println!("\n\n################ detail for every non-focus map ################");
        for (report, verdict) in &verdicts {
            if focus.iter().any(|f| report.path.to_lowercase().contains(&f.to_lowercase())) {
                continue;
            }
            print_detail(report, verdict, &thresholds);
        }
    }

    // the population test for the "judged one replay frame late" mechanism,
    // run against the same arena discipline: if passing plays carry the same
    // rescuable population as failing ones, the lateness is not what the
    // header disagrees about
    println!("\n\n################ one-update-late population test ################");
    println!("  a dropped point is RESCUABLE when the update before the judging one would have");
    println!("  scored it -- the point fell due in a frame gap and the player left during it");
    for (label, failing) in [("FAILING", true), ("PASSING", false)] {
        let plays: Vec<&PlayFacts> = reports
            .iter()
            .flat_map(|r| r.plays.iter())
            .filter(|p| p.failing == failing)
            .collect();
        let dropped: usize = plays.iter().map(|p| p.dropped_load_bearing.len()).sum();
        let rescuable: usize = plays.iter().map(|p| p.rescuable.len()).sum();
        let with_any = plays.iter().filter(|p| !p.rescuable.is_empty()).count();
        let mean = if plays.is_empty() {
            0.0
        } else {
            rescuable as f64 / plays.len() as f64
        };
        println!(
            "  {label:<7} {:>4} plays | load-bearing drops {dropped:>6} | rescuable {rescuable:>5} \
             ({:>5.1}%) | {with_any} plays carry one | mean {mean:.2}/play",
            plays.len(),
            100.0 * rescuable as f64 / dropped.max(1) as f64
        );
    }

    // the predicate the population test implies, arbitrated the way
    // probe_headmiss arbitrates its own: a rule that fires on an EXACT play
    // is dead, no matter how well it fits the failing ones
    println!("\n  predicate: #rescuable == the count of Great->Ok flips the header implies (-d300)");
    for (label, failing) in [("FAILING", true), ("PASSING", false)] {
        let plays: Vec<&PlayFacts> = reports
            .iter()
            .flat_map(|r| r.plays.iter())
            .filter(|p| p.failing == failing)
            .collect();
        let matched = plays
            .iter()
            .filter(|p| p.rescuable.len() as i64 == (-p.d300).max(0))
            .count();
        println!("    {label:<7} matched {matched}/{} plays", plays.len());
    }

    // which nested element the engine drops, over the whole population --
    // the answer that decides whether "slider tracking" is really one class
    println!("\n  grade-load-bearing dropped elements by kind:");
    for (label, failing) in [("FAILING", true), ("PASSING", false)] {
        let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
        for report in &reports {
            for play in report.plays.iter().filter(|p| p.failing == failing) {
                for id in &play.dropped_load_bearing {
                    let kind = report
                        .points
                        .get(&id.object_index)
                        .and_then(|p| p.get(id.point_index as usize))
                        .map(|d| match d.kind {
                            StablePointKind::Repeat { .. } => "repeat".to_string(),
                            other => PointDesc { kind: other, time: 0.0 }.kind_label(),
                        })
                        .unwrap_or_else(|| "?".to_string());
                    *kinds.entry(kind).or_default() += 1;
                }
            }
        }
        println!("    {label:<7} {kinds:?}");
    }

    // where the dropped elements sat relative to the follow radius. a class
    // driven by a deterministic boundary piles up just outside 1.0; a class
    // driven by the player genuinely leaving the slider spreads out
    println!("\n  grade-load-bearing drops by follow-radius ratio band (button-held drops only):");
    let bands = [0.0, 0.95, 1.0, 1.1, 1.25, 1.5, 2.0, 2.4, f64::INFINITY];
    for (label, failing) in [("FAILING", true), ("PASSING", false)] {
        let mut counts = vec![0usize; bands.len()];
        let mut no_button = 0usize;
        for report in &reports {
            for play in report.plays.iter().filter(|p| p.failing == failing) {
                for id in &play.dropped_load_bearing {
                    let Some(signal) = play.signals.get(id) else { continue };
                    if !signal.acceptable {
                        no_button += 1;
                        continue;
                    }
                    let band = bands.iter().rposition(|&b| signal.ratio >= b).unwrap_or(0);
                    counts[band] += 1;
                }
            }
        }
        let rows: Vec<String> = bands
            .iter()
            .enumerate()
            .filter(|(i, _)| counts[*i] > 0)
            .map(|(i, b)| format!("{b:.2}+:{}", counts[i]))
            .collect();
        println!("    {label:<7} no-button {no_button:>5} | {}", rows.join(" "));
    }

    // the population test for the midpoint-branch hypothesis: a sub-72ms
    // slider's sole scoring point sits 25-35ms after the head, so if stable
    // really scores those tails on a bare tap, PASSING plays should carry
    // (near) zero load-bearing midpoint drops -- each one they do carry is a
    // play whose header CONFIRMS stable dropped that midpoint tail too
    println!("\n  midpoint-branch (sub-72ms) tail population:");
    for (label, failing) in [("FAILING", true), ("PASSING", false)] {
        let mut kept = 0usize;
        let mut dropped_lb = 0usize;
        let mut dropped_other = 0usize;
        let mut plays_with_lb = 0usize;
        let mut plays = 0usize;
        for report in &reports {
            let is_midpoint_tail = |id: &PointId| {
                report.midpoint_tails.contains(&id.object_index)
                    && report
                        .points
                        .get(&id.object_index)
                        .and_then(|p| p.get(id.point_index as usize))
                        .is_some_and(|d| matches!(d.kind, StablePointKind::Tail))
            };
            for play in report.plays.iter().filter(|p| p.failing == failing) {
                plays += 1;
                kept += play.kept.iter().filter(|id| is_midpoint_tail(id)).count();
                let lb = play.dropped_load_bearing.iter().filter(|id| is_midpoint_tail(id)).count();
                dropped_lb += lb;
                if lb > 0 {
                    plays_with_lb += 1;
                }
                dropped_other += play
                    .dropped
                    .iter()
                    .chain(play.unjudged.iter())
                    .filter(|id| !play.dropped_load_bearing.contains(id) && is_midpoint_tail(id))
                    .count();
            }
        }
        let encounters = kept + dropped_lb + dropped_other;
        println!(
            "    {label:<7} {plays:>4} plays | midpoint tails met {encounters:>5} | kept {kept:>5} | \
             dropped load-bearing {dropped_lb:>4} ({:>5.1}%) | dropped other {dropped_other:>4} | \
             {plays_with_lb} plays carry a load-bearing drop",
            100.0 * dropped_lb as f64 / encounters.max(1) as f64
        );
    }

    // every surviving element with the cause its map's failing plays shared:
    // the mechanism-naming table
    println!("\n\n################ surviving elements, by shared cause ################");
    let mut by_profile: BTreeMap<&'static str, usize> = BTreeMap::new();
    let mut by_kind: BTreeMap<String, usize> = BTreeMap::new();
    println!(
        "  {:<18} {:<6} {:<26}  {:<34} map",
        "cause", "dir", "element", "failing-play signal ranges"
    );
    for (report, verdict) in &verdicts {
        for id in &verdict.survivors {
            let (name, detail) = profile(report, *id);
            *by_profile.entry(name).or_default() += 1;
            let kind = report
                .points
                .get(&id.object_index)
                .and_then(|p| p.get(id.point_index as usize))
                .map(|d| d.kind_label())
                .unwrap_or_else(|| "?".to_string());
            *by_kind.entry(kind).or_default() += 1;
            println!(
                "  {:<18} {:<6} {:<26}  {:<34} {}",
                name,
                verdict.direction.label(),
                describe(report, *id),
                detail,
                short_name(&report.path)
            );
        }
    }
    println!("\n  cause histogram: {by_profile:?}");
    println!("  element-kind histogram: {by_kind:?}");

    // the split the whole instrument exists to produce
    let mut invariant: Vec<&MapReport> = Vec::new();
    let mut killed: Vec<&MapReport> = Vec::new();
    let mut varying: Vec<&MapReport> = Vec::new();
    let mut broken: Vec<&MapReport> = Vec::new();
    for (report, verdict) in &verdicts {
        match verdict.kind {
            VerdictKind::Invariant => invariant.push(report),
            VerdictKind::Killed => killed.push(report),
            VerdictKind::Varying => varying.push(report),
            VerdictKind::NoData => broken.push(report),
        }
    }
    let plays_of = |maps: &[&MapReport]| -> (usize, usize) {
        let fail: usize = maps.iter().map(|r| r.plays.iter().filter(|p| p.failing).count()).sum();
        let pass: usize = maps.iter().map(|r| r.plays.iter().filter(|p| !p.failing).count()).sum();
        (fail, pass)
    };
    let sharp: Vec<&MapReport> = verdicts
        .iter()
        .filter(|(_, v)| v.kind == VerdictKind::Invariant && v.sharp)
        .map(|(r, _)| *r)
        .collect();
    let broad: Vec<&MapReport> = verdicts
        .iter()
        .filter(|(_, v)| v.kind == VerdictKind::Invariant && !v.sharp)
        .map(|(r, _)| *r)
        .collect();
    println!("\n\n################ summary ################");
    for (name, maps) in [
        ("ELEMENT-INVARIANT (survives the passing arena)", &invariant),
        ("  ...of which SHARP (survivors <= 2x implied flips)", &sharp),
        ("  ...of which over-BROAD (a habit, not a mechanism)", &broad),
        ("candidate KILLED by a passing play", &killed),
        ("PLAY-VARYING (no shared element -- cursor noise)", &varying),
        ("no usable data (simulate/decode errors)", &broken),
    ] {
        let (fail, pass) = plays_of(maps);
        println!("  {name:<48} {:>4} maps  {fail:>5} failing plays  {pass:>5} passing", maps.len());
    }
    let unfalsifiable = verdicts
        .iter()
        .filter(|(r, _)| r.plays.iter().all(|p| p.failing))
        .count();
    println!("  maps with NO passing play (unfalsifiable arena)   {unfalsifiable:>4}");
    let invariant_with_arena = verdicts
        .iter()
        .filter(|(r, v)| v.kind == VerdictKind::Invariant && r.plays.iter().any(|p| !p.failing))
        .count();
    println!("  ...of the invariant maps, tested against an arena {invariant_with_arena:>4}");
    let orphans: usize = reports
        .iter()
        .flat_map(|r| r.plays.iter())
        .map(|p| p.orphan_samples)
        .sum();
    println!("  orphaned trace samples (must be 0)                {orphans:>4}");
}

fn load_map(path: &str) -> Result<ProcessedBeatmap, String> {
    let map = decode_beatmap_path(&PathBuf::from(path)).map_err(|e| format!("decode: {e}"))?;
    process_beatmap(&map).map_err(|e| format!("process: {e}"))
}

/// the judged point list per slider object, replicating
/// `simulation::slider::SliderState::new` -- every non-repeat point is a
/// tick, and the LAST point is re-kinded to the tail and repositioned to
/// `max(start + duration/2, end - 36)` in truncated integer milliseconds
fn map_points(processed: &ProcessedBeatmap) -> (BTreeMap<u32, Vec<PointDesc>>, BTreeSet<u32>) {
    let mut out = BTreeMap::new();
    let mut midpoint_tails = BTreeSet::new();
    for (index, obj) in processed.objects.iter().enumerate() {
        let ProcessedKind::Slider(slider) = &obj.kind else { continue };
        let mut points: Vec<PointDesc> = slider
            .stable_points
            .iter()
            .map(|p| PointDesc {
                kind: match p.kind {
                    repeat @ StablePointKind::Repeat { .. } => repeat,
                    _ => StablePointKind::Tick,
                },
                time: p.time,
            })
            .collect();
        if let Some(last) = points.last_mut() {
            let start = obj.start_time as i64;
            let end = slider.stable_end_time as i64;
            let duration = end.wrapping_sub(start);
            let midpoint = start.wrapping_add(duration / 2);
            if midpoint > end.wrapping_sub(36) {
                midpoint_tails.insert(index as u32);
            }
            last.time = midpoint.max(end.wrapping_sub(36)) as f64;
            last.kind = StablePointKind::Tail;
        }
        out.insert(index as u32, points);
    }
    (out, midpoint_tails)
}

fn analyse(
    entry: &Entry,
    processed: &ProcessedBeatmap,
    points: &BTreeMap<u32, Vec<PointDesc>>,
    failing: bool,
    thresholds: &Thresholds,
) -> Result<PlayFacts, String> {
    let osr = decode_osr(&std::fs::read(&entry.replay_path).map_err(|e| format!("read: {e}"))?)
        .map_err(|e| format!("osr: {e}"))?;
    let frames = convert_frames(&osr.actions, processed.format_version);

    trace::start();
    let simulated = simulate(processed, &frames);
    let decisions = trace::finish();
    let timeline = simulated.map_err(|e| format!("simulate: {e}"))?;

    // the head is not a point but it counts toward the aggregate rate, so it
    // decides whether a point is grade-load-bearing
    let mut head_hit: BTreeMap<u32, bool> = BTreeMap::new();
    for event in &timeline.events {
        if let JudgementKind::SliderHead { hit } = event.kind {
            head_hit.insert(event.object_index as u32, hit);
        }
    }

    let mut signals: BTreeMap<PointId, Signals> = BTreeMap::new();
    let mut judged_count: BTreeMap<u32, usize> = BTreeMap::new();
    let mut scored_count: BTreeMap<u32, u32> = BTreeMap::new();
    let mut orphan_samples = 0usize;
    for decision in &decisions {
        let id = PointId {
            object_index: decision.object_index as u32,
            point_index: decision.point_index as u32,
        };
        if decision.radius_sq.is_nan() {
            orphan_samples += 1;
        }
        *judged_count.entry(id.object_index).or_default() += 1;
        if decision.hit {
            *scored_count.entry(id.object_index).or_default() += 1;
        }
        signals.insert(
            id,
            Signals {
                hit: decision.hit,
                ratio: decision.radius_ratio(),
                gate: decision.gate_slack(),
                lag: decision.lag(),
                sliding_before: decision.sliding_before,
                acceptable: decision.acceptable,
                ever_slid: decision.slide_start > 0.0,
                rescued_one_update_earlier: decision.would_score_one_update_earlier(),
            },
        );
    }

    let mut facts = PlayFacts {
        stem: entry.stem.clone(),
        failing,
        direction: Direction::ScoreOnly,
        d300: delta(entry, "count_300"),
        d100: delta(entry, "count_100"),
        d50: delta(entry, "count_50"),
        dmiss: delta(entry, "count_miss"),
        dcombo: delta(entry, "max_combo"),
        implied_flips: (delta(entry, "count_300").abs()
            + delta(entry, "count_100").abs()
            + delta(entry, "count_50").abs()
            + delta(entry, "count_miss").abs())
            / 2,
        signals,
        dropped: BTreeSet::new(),
        unjudged: BTreeSet::new(),
        dropped_load_bearing: BTreeSet::new(),
        kept: BTreeSet::new(),
        kept_marginal: BTreeSet::new(),
        rescuable: BTreeSet::new(),
        orphan_samples,
    };
    facts.direction = direction_of(facts.d300, facts.d100, facts.d50, facts.dmiss);

    for (&object_index, descs) in points {
        let total = descs.len();
        let scored_points = scored_count.get(&object_index).copied().unwrap_or(0);
        let judged = judged_count.get(&object_index).copied().unwrap_or(0);
        // rate numerator counts the head too (slider.rs update_post_for)
        let head = u32::from(head_hit.get(&object_index).copied().unwrap_or(false));
        let scored = scored_points + head;
        let grade_now = grade_of(scored, total);
        let grade_plus = grade_of(scored + 1, total);
        let grade_minus = grade_of(scored.saturating_sub(1), total);

        for point_index in 0..total {
            let id = PointId {
                object_index,
                point_index: point_index as u32,
            };
            match facts.signals.get(&id) {
                Some(signal) if signal.hit => {
                    facts.kept.insert(id);
                    let marginal = signal.ratio >= thresholds.ratio || signal.gate <= thresholds.gate;
                    if marginal && grade_minus != grade_now {
                        facts.kept_marginal.insert(id);
                    }
                }
                Some(signal) => {
                    facts.dropped.insert(id);
                    if grade_plus != grade_now {
                        facts.dropped_load_bearing.insert(id);
                        if signal.rescued_one_update_earlier {
                            facts.rescuable.insert(id);
                        }
                    }
                }
                None => {
                    // never judged: the aggregate fired with the point still
                    // due, so no event and no trace record exist for it
                    if point_index >= judged {
                        facts.unjudged.insert(id);
                        facts.dropped.insert(id);
                        if grade_plus != grade_now {
                            facts.dropped_load_bearing.insert(id);
                        }
                    }
                }
            }
        }
    }
    Ok(facts)
}

fn delta(entry: &Entry, field: &str) -> i64 {
    entry.fields.get(field).map_or(0, |f| f.simulated - f.header)
}

fn direction_of(d300: i64, d100: i64, d50: i64, dmiss: i64) -> Direction {
    let up = d300 > 0 || dmiss < 0;
    let down = d300 < 0 || dmiss > 0;
    match (up, down) {
        (true, false) => Direction::Keeps,
        (false, true) => Direction::Drops,
        (true, true) => Direction::Mixed,
        (false, false) if d100 != 0 || d50 != 0 => Direction::Mixed,
        (false, false) => Direction::ScoreOnly,
    }
}

/// slider.rs update_post_for's own fold, so a load-bearing test asks exactly
/// what the machine would answer
fn grade_of(scored: u32, points: usize) -> &'static str {
    let rate = f64::from(scored) / (points as f64 + 1.0);
    if rate >= 1.0 {
        "300"
    } else if rate >= 0.5 {
        "100"
    } else if rate > 0.0 {
        "50"
    } else {
        "miss"
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VerdictKind {
    Invariant,
    Killed,
    Varying,
    NoData,
}

struct Verdict {
    kind: VerdictKind,
    direction: Direction,
    /// candidates that survived the passing arena
    survivors: BTreeSet<PointId>,
    /// candidates the failing plays agreed on, before the arena
    candidates: BTreeSet<PointId>,
    /// how many of `candidates` a passing play contradicted
    contradicted: usize,
    /// the largest element count any failing play's header movement implies
    implied: i64,
    /// the surviving set is small enough to actually name the divergence:
    /// an intersection of 55 elements on a map that lost 8 grades has found
    /// a habit, not a mechanism
    sharp: bool,
}

impl Verdict {
    fn tag(&self) -> &'static str {
        match self.kind {
            VerdictKind::Invariant => "INVARIANT",
            VerdictKind::Killed => "killed",
            VerdictKind::Varying => "varying",
            VerdictKind::NoData => "nodata",
        }
    }

    /// an invariant element on a map with no passing play was never put to
    /// the arena, so its survival proves only that no arena exists
    fn tag_with_arena(&self, report: &MapReport) -> String {
        let arena = report.plays.iter().any(|p| !p.failing);
        match (self.kind, arena, self.sharp) {
            (VerdictKind::Invariant, _, false) => "broad".to_string(),
            (VerdictKind::Invariant, false, true) => "INVARIANT*".to_string(),
            _ => self.tag().to_string(),
        }
    }

    fn describe_elements(&self, report: &MapReport) -> String {
        if self.survivors.is_empty() {
            return match self.kind {
                VerdictKind::Killed => format!("-- ({} candidates killed)", self.contradicted),
                _ => "--".to_string(),
            };
        }
        let mut parts: Vec<String> = self
            .survivors
            .iter()
            .take(2)
            .map(|id| describe(report, *id))
            .collect();
        if self.survivors.len() > 2 {
            parts.push(format!("+{} more", self.survivors.len() - 2));
        }
        parts.join(" ")
    }
}

/// how the failing plays of a map all failed on ONE surviving element. this
/// is the mechanism-naming half: an element whose failing plays share a
/// cause is a boundary candidate; one whose plays fail for different reasons
/// is invariant only by coincidence of position
fn profile(report: &MapReport, id: PointId) -> (&'static str, String) {
    let rows: Vec<&Signals> = report
        .plays
        .iter()
        .filter(|p| p.failing)
        .filter_map(|p| p.signals.get(&id))
        .collect();
    let judged = report.plays.iter().filter(|p| p.failing).count();
    if rows.len() < judged {
        return ("unjudged", format!("{}/{judged} plays never judged it", judged - rows.len()));
    }
    let stats = |values: Vec<f64>| -> String {
        let lo = values.iter().copied().fold(f64::INFINITY, f64::min);
        let hi = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        format!("{lo:.3}..{hi:.3}")
    };
    let rescued = rows.iter().filter(|r| r.rescued_one_update_earlier).count();
    let detail = format!(
        "ratio {} lag {} gate {} rescued-1-update {rescued}/{}",
        stats(rows.iter().map(|r| r.ratio).collect()),
        stats(rows.iter().map(|r| r.lag).collect()),
        if rows.iter().all(|r| r.ever_slid) {
            stats(rows.iter().map(|r| r.gate).collect())
        } else {
            "never-slid".to_string()
        },
        rows.len(),
    );
    if rows.iter().all(|r| r.hit) {
        return ("keeps", detail);
    }
    if rows.iter().any(|r| r.hit) {
        return ("hit-mixed", detail);
    }
    if rows.iter().all(|r| !r.acceptable) {
        ("drop/button", detail)
    } else if rows.iter().all(|r| r.acceptable && !r.sliding_before) {
        ("drop/slide-dead", detail)
    } else if rows.iter().all(|r| r.acceptable && r.sliding_before) {
        ("drop/outside-2.4r", detail)
    } else {
        ("drop/mixed", detail)
    }
}

fn describe(report: &MapReport, id: PointId) -> String {
    match report
        .points
        .get(&id.object_index)
        .and_then(|p| p.get(id.point_index as usize))
    {
        Some(desc) => format!("obj{} {} t={}", id.object_index, desc.kind_label(), desc.time),
        None => format!("obj{} pt{}", id.object_index, id.point_index),
    }
}

/// the whole discriminator: intersect the failing plays' candidate sets,
/// then subtract everything a passing play of the same map contradicts
fn judge(report: &MapReport) -> Verdict {
    let failing: Vec<&PlayFacts> = report.plays.iter().filter(|p| p.failing).collect();
    let passing: Vec<&PlayFacts> = report.plays.iter().filter(|p| !p.failing).collect();
    if failing.len() < 2 {
        return Verdict {
            kind: VerdictKind::NoData,
            direction: Direction::ScoreOnly,
            survivors: BTreeSet::new(),
            candidates: BTreeSet::new(),
            contradicted: 0,
            implied: 0,
            sharp: false,
        };
    }

    // the map's direction is the one its failing plays agree on; a map whose
    // plays disagree is mixed by construction and cannot be one mechanism
    let mut direction = failing[0].direction;
    for play in &failing[1..] {
        if play.direction != direction {
            direction = Direction::Mixed;
        }
    }

    let (candidates, contradiction) = match direction {
        Direction::Drops => {
            let candidates = intersect(failing.iter().map(|p| &p.dropped_load_bearing));
            // a passing play that dropped the same element proves dropping it
            // is what stable did too
            let contradiction = union(passing.iter().map(|p| &p.dropped));
            (candidates, contradiction)
        }
        Direction::Keeps => {
            let candidates = intersect(failing.iter().map(|p| &p.kept_marginal));
            // a passing play that kept the same element proves keeping it is
            // what stable did too
            let contradiction = union(passing.iter().map(|p| &p.kept));
            (candidates, contradiction)
        }
        _ => {
            // mixed maps still get both sets, unioned: the element is asked
            // for, the direction is reported as mixed
            let dropped = intersect(failing.iter().map(|p| &p.dropped_load_bearing));
            let kept = intersect(failing.iter().map(|p| &p.kept_marginal));
            let mut candidates = dropped;
            candidates.extend(kept);
            let mut contradiction = union(passing.iter().map(|p| &p.dropped));
            contradiction.extend(union(passing.iter().map(|p| &p.kept)));
            (candidates, contradiction)
        }
    };

    let survivors: BTreeSet<PointId> = candidates.difference(&contradiction).copied().collect();
    let contradicted = candidates.len() - survivors.len();
    let kind = if !survivors.is_empty() {
        VerdictKind::Invariant
    } else if contradicted > 0 {
        VerdictKind::Killed
    } else {
        VerdictKind::Varying
    };
    // the largest per-play element budget the headers admit; twice it is
    // generous slack for a play whose flips are not all on this map's shared
    // element
    let implied = failing.iter().map(|p| p.implied_flips).max().unwrap_or(0).max(1);
    let sharp = !survivors.is_empty() && survivors.len() as i64 <= 2 * implied;
    Verdict {
        kind,
        direction,
        survivors,
        candidates,
        contradicted,
        implied,
        sharp,
    }
}

fn intersect<'a>(mut sets: impl Iterator<Item = &'a BTreeSet<PointId>>) -> BTreeSet<PointId> {
    let Some(first) = sets.next() else { return BTreeSet::new() };
    let mut acc: BTreeSet<PointId> = first.clone();
    for set in sets {
        acc = acc.intersection(set).copied().collect();
    }
    acc
}

fn union<'a>(sets: impl Iterator<Item = &'a BTreeSet<PointId>>) -> BTreeSet<PointId> {
    let mut acc = BTreeSet::new();
    for set in sets {
        acc.extend(set.iter().copied());
    }
    acc
}

fn short_name(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or(path)
}

fn print_detail(report: &MapReport, verdict: &Verdict, thresholds: &Thresholds) {
    let failing: Vec<&PlayFacts> = report.plays.iter().filter(|p| p.failing).collect();
    let passing: Vec<&PlayFacts> = report.plays.iter().filter(|p| !p.failing).collect();
    println!("\n---- {}", short_name(&report.path));
    println!(
        "  {} failing / {} passing | direction {} | verdict {}",
        failing.len(),
        passing.len(),
        verdict.direction.label(),
        verdict.tag_with_arena(report)
    );
    for problem in &report.errors {
        println!("  ERROR {problem}");
    }

    for play in &failing {
        println!(
            "  FAIL {:<14} dir {:<5} d300 {:+} d100 {:+} d50 {:+} dmiss {:+} dcombo {:+}",
            &play.stem[..play.stem.len().min(14)],
            play.direction.label(),
            play.d300,
            play.d100,
            play.d50,
            play.dmiss,
            play.dcombo
        );
        println!(
            "       dropped {} (load-bearing {}, unjudged {}) | kept {} (marginal load-bearing {})",
            play.dropped.len(),
            play.dropped_load_bearing.len(),
            play.unjudged.len(),
            play.kept.len(),
            play.kept_marginal.len()
        );
    }
    for play in &passing {
        println!(
            "  PASS {:<14} dropped {} (load-bearing {}) | kept-marginal {}",
            &play.stem[..play.stem.len().min(14)],
            play.dropped.len(),
            play.dropped_load_bearing.len(),
            play.kept_marginal.len()
        );
    }

    println!(
        "  failing-play intersection: {} candidate element(s), {} contradicted by a passing play; \
         headers imply at most {} flipped element(s) per play -> {}",
        verdict.candidates.len(),
        verdict.contradicted,
        verdict.implied,
        if verdict.sharp { "SHARP" } else { "over-broad or empty" }
    );
    let mut listed = 0usize;
    for id in verdict.candidates.iter() {
        if listed >= 12 {
            println!("    ... {} more", verdict.candidates.len() - listed);
            break;
        }
        listed += 1;
        let alive = verdict.survivors.contains(id);
        let (cause, ranges) = profile(report, *id);
        println!(
            "    {} {} | {cause} ({ranges})",
            if alive { "ALIVE " } else { "killed" },
            describe(report, *id)
        );
        for play in report.plays.iter() {
            let Some(signal) = play.signals.get(id) else {
                if play.failing {
                    println!("      FAIL {:<14} never judged", &play.stem[..play.stem.len().min(14)]);
                }
                continue;
            };
            println!(
                "      {} {:<14} hit={} ratio {:.4} gate {:>8} lag {:+6.1} sliding={} accept={} \
                 rescuable={}",
                if play.failing { "FAIL" } else { "PASS" },
                &play.stem[..play.stem.len().min(14)],
                u8::from(signal.hit),
                signal.ratio,
                if signal.ever_slid {
                    format!("{:+.1}", signal.gate)
                } else {
                    "never".to_string()
                },
                signal.lag,
                u8::from(signal.sliding_before),
                u8::from(signal.acceptable),
                u8::from(signal.rescued_one_update_earlier)
            );
        }
    }
    if verdict.candidates.is_empty() {
        // with no shared element, the useful evidence is HOW MUCH the plays
        // disagree: the per-play candidate sizes and their pairwise overlap
        let sets: Vec<&BTreeSet<PointId>> = match verdict.direction {
            Direction::Keeps => failing.iter().map(|p| &p.kept_marginal).collect(),
            _ => failing.iter().map(|p| &p.dropped_load_bearing).collect(),
        };
        let sizes: Vec<usize> = sets.iter().map(|s| s.len()).collect();
        let pairwise: Vec<usize> = sets
            .windows(2)
            .map(|w| w[0].intersection(w[1]).count())
            .collect();
        println!("    per-play candidate sizes {sizes:?}, adjacent-pair overlaps {pairwise:?}");
        println!(
            "    (marginal at ratio >= {} or gate <= {}ms)",
            thresholds.ratio, thresholds.gate
        );
    }
}
