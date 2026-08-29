//! probe_headmiss: issue 15 instrument -- correlates every sweep play's
//! total-score delta against the structure and event order of its
//! head-missed sliders. reads the sweep manifest (failures) and the passing
//! dump written by sweep_replays, re-simulates each play, and tests the
//! candidate "-20 per head-missed slider" predicates against the exact
//! header delta. the passing dump is the falsification arena: a predicate
//! that fires on any exact play is dead.
//!
//! usage (from `src-tauri/`):
//!
//!   cargo run -p engine --release --example probe_headmiss
//!   cargo run -p engine --release --example probe_headmiss -- --verbose
//!
//! like the sweep, this is an example, never a test: it always exits 0 with
//! the numbers as its output.

use std::collections::BTreeMap;
use std::path::PathBuf;

use engine::beatmap::stable_points::StablePointKind;
use engine::beatmap::{process_beatmap, ProcessedKind};
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::decode_osr;
use engine::replay::frames::convert_frames;
use engine::score::{peppy_stars, total_score, ScoreContext, NOMOD_SCORE_MULTIPLIER};
use engine::simulation::score::JudgementKind;
use engine::simulation::simulate;

#[derive(serde::Deserialize)]
struct Entry {
    stem: String,
    replay_path: String,
    beatmap_path: String,
    has_spinners: bool,
    /// diverging fields as the sweep recorded them; empty for passing plays
    fields: std::collections::BTreeMap<String, serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct Manifest {
    failures: Vec<Entry>,
}

/// one head-missed slider's shape, as the predicates see it
struct HeadMissedSlider {
    object_index: usize,
    tail_hit: bool,
    /// stable point count 1 -- head + tail only, no ticks or repeats
    tickless: bool,
    /// the head-miss event was emitted before the tail's judgement
    head_miss_first: bool,
    /// a tick or repeat scored between the head-miss and the tail --
    /// i.e. the tail was NOT the first thing scored after the miss
    scored_between: bool,
    points: usize,
}

struct PlayReport {
    stem: String,
    beatmap_path: String,
    delta: i64,
    has_spinners: bool,
    /// every non-score field matched the header (score-only or passing)
    count_exact: bool,
    sliders: Vec<HeadMissedSlider>,
}

/// map-structural shape counts, computed once per beatmap path
#[derive(Clone)]
struct MapShape {
    sliders: usize,
    /// sliders whose -36 tail judge time lands at or before the last
    /// tick's time -- the out-of-order shape where tail and final tick
    /// fall due together for the pointsPassed-valued stable walk
    reordered_tail: usize,
    /// same but strictly before (tail < tick)
    reordered_tail_strict: usize,
    /// sliders whose last tick sits within 36ms of the stable end
    tick_in_final_36: usize,
    /// repeat sliders (span_count > 1)
    repeat_sliders: usize,
}

fn main() {
    let verbose = std::env::args().any(|a| a == "--verbose");
    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/replays/local");

    let mut entries: Vec<(Entry, bool)> = Vec::new();
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(local.join("sweep_manifest.json")).expect("read manifest"))
            .expect("parse manifest");
    for entry in manifest.failures {
        entries.push((entry, false));
    }
    let passing: Vec<Entry> =
        serde_json::from_slice(&std::fs::read(local.join("sweep_passing.json")).expect("read passing"))
            .expect("parse passing");
    for entry in passing {
        entries.push((entry, true));
    }
    eprintln!("probe: {} plays to simulate", entries.len());

    let mut reports: Vec<PlayReport> = Vec::new();
    let mut shapes: BTreeMap<String, MapShape> = BTreeMap::new();
    let mut errors = 0usize;
    for (i, (entry, _)) in entries.iter().enumerate() {
        if i % 250 == 0 {
            eprintln!("probe: {i}/{}", entries.len());
        }
        match probe(entry, &mut shapes) {
            Ok(report) => reports.push(report),
            Err(problem) => {
                eprintln!("probe: {}: {problem}", entry.stem);
                errors += 1;
            }
        }
    }

    // map-level view: a map is "class" when every count-exact play of it
    // shares one nonzero delta -- the play-invariant term in its pure form
    println!("== map-constant deltas (count-exact plays only) ==");
    let mut by_map: BTreeMap<&str, Vec<&PlayReport>> = BTreeMap::new();
    for report in reports.iter().filter(|r| r.count_exact) {
        by_map.entry(&report.beatmap_path).or_default().push(report);
    }
    for (map, plays) in &by_map {
        let deltas: Vec<i64> = plays.iter().map(|p| p.delta).collect();
        let first = deltas[0];
        if first != 0 && deltas.iter().all(|&d| d == first) {
            let shape = &shapes[*map];
            let name = map.rsplit('\\').next().unwrap_or(map);
            println!(
                "  delta {first:+} x{} plays | sliders {} reorder {}/{} tick36 {} repeats {} spin={} | {name}",
                deltas.len(),
                shape.sliders,
                shape.reordered_tail,
                shape.reordered_tail_strict,
                shape.tick_in_final_36,
                shape.repeat_sliders,
                plays[0].has_spinners,
            );
        }
    }
    println!("\n== maps with VARYING deltas across count-exact plays ==");
    for (map, plays) in &by_map {
        let deltas: Vec<i64> = plays.iter().map(|p| p.delta).collect();
        let first = deltas[0];
        if deltas.len() >= 2 && !deltas.iter().all(|&d| d == first) && deltas.iter().any(|&d| d != 0) {
            let shape = &shapes[*map];
            let name = map.rsplit('\\').next().unwrap_or(map);
            println!(
                "  deltas {deltas:?} | sliders {} reorder {}/{} tick36 {} repeats {} spin={} | {name}",
                shape.sliders,
                shape.reordered_tail,
                shape.reordered_tail_strict,
                shape.tick_in_final_36,
                shape.repeat_sliders,
                plays[0].has_spinners,
            );
        }
    }

    // predicate table: name + counter over one play's head-missed sliders
    let predicates: [(&str, fn(&PlayReport) -> i64); 5] = [
        ("head-missed & tail-hit", |r| {
            r.sliders.iter().filter(|s| s.tail_hit).count() as i64
        }),
        ("head-missed & tail-hit & tickless", |r| {
            r.sliders.iter().filter(|s| s.tail_hit && s.tickless).count() as i64
        }),
        ("head-missed & tail-hit & head-miss-first", |r| {
            r.sliders.iter().filter(|s| s.tail_hit && s.head_miss_first).count() as i64
        }),
        ("head-missed & tail-hit & head-miss-first & tickless", |r| {
            r.sliders
                .iter()
                .filter(|s| s.tail_hit && s.head_miss_first && s.tickless)
                .count() as i64
        }),
        ("head-missed & tail-hit & head-miss-first & nothing scored between", |r| {
            r.sliders
                .iter()
                .filter(|s| s.tail_hit && s.head_miss_first && !s.scored_between)
                .count() as i64
        }),
    ];

    // arbitrate on count-exact spinner-free plays only: a play whose counts
    // diverge cannot arbitrate a scoring-fold rule, and the spinner cadence
    // residual pollutes deltas in 100/1100 quanta that would drown the 20s
    let arena: Vec<&PlayReport> = reports.iter().filter(|r| !r.has_spinners && r.count_exact).collect();
    let with_delta = arena.iter().filter(|r| r.delta != 0).count();
    let with_sites = arena.iter().filter(|r| !r.sliders.is_empty()).count();
    println!("== arena: {} count-exact spinner-free plays ({with_delta} diverging, {with_sites} with head-missed sliders; {errors} errors) ==", arena.len());

    for (name, count) in predicates {
        let mut matched = 0usize;
        let mut mismatched: Vec<String> = Vec::new();
        for report in &arena {
            let predicted = 20 * count(report);
            if predicted == report.delta {
                matched += 1;
            } else {
                mismatched.push(format!(
                    "{}: delta {:+} predicted {:+}",
                    report.stem, report.delta, predicted
                ));
            }
        }
        println!("\npredicate: delta == 20 * #({name})");
        println!("  matched {matched}/{} plays", arena.len());
        if mismatched.len() <= 25 || verbose {
            for m in &mismatched {
                println!("  MISS {m}");
            }
        } else {
            for m in mismatched.iter().take(25) {
                println!("  MISS {m}");
            }
            println!("  ... {} more", mismatched.len() - 25);
        }
    }

    // per-slider shapes for every arena play that diverges or carries a
    // head-missed slider while diverging nowhere -- the inspectable record
    println!("\n== arena plays with delta != 0 (per-slider shapes) ==");
    for report in &arena {
        if report.delta == 0 {
            continue;
        }
        println!("  {} delta {:+}", report.stem, report.delta);
        for s in &report.sliders {
            println!(
                "    obj {} pts {} tail_hit={} tickless={} head_miss_first={} scored_between={}",
                s.object_index, s.points, s.tail_hit, s.tickless, s.head_miss_first, s.scored_between
            );
        }
    }
}

fn probe(entry: &Entry, shapes: &mut BTreeMap<String, MapShape>) -> Result<PlayReport, String> {
    let map = decode_beatmap_path(&PathBuf::from(&entry.beatmap_path)).map_err(|e| format!("map: {e}"))?;
    let processed = process_beatmap(&map).map_err(|e| format!("process: {e}"))?;

    if !shapes.contains_key(&entry.beatmap_path) {
        let mut shape = MapShape {
            sliders: 0,
            reordered_tail: 0,
            reordered_tail_strict: 0,
            tick_in_final_36: 0,
            repeat_sliders: 0,
        };
        for obj in &processed.objects {
            let ProcessedKind::Slider(slider) = &obj.kind else { continue };
            shape.sliders += 1;
            if slider.span_count > 1 {
                shape.repeat_sliders += 1;
            }
            // the valuation's own truncated, wrapping i64 arithmetic, so a
            // boundary slider cannot classify half a millisecond off the fold
            let start = obj.start_time as i64;
            let end = slider.stable_end_time as i64;
            let tail_judge_time =
                start.wrapping_add(end.wrapping_sub(start) / 2).max(end.wrapping_sub(36));
            let last_tick_time = slider
                .stable_points
                .iter()
                .filter(|p| p.kind == StablePointKind::Tick)
                .map(|p| p.time as i64)
                .fold(i64::MIN, i64::max);
            if last_tick_time >= tail_judge_time {
                shape.reordered_tail += 1;
            }
            if last_tick_time > tail_judge_time {
                shape.reordered_tail_strict += 1;
            }
            if last_tick_time > end.wrapping_sub(36) {
                shape.tick_in_final_36 += 1;
            }
        }
        shapes.insert(entry.beatmap_path.clone(), shape);
    }
    let osr =
        decode_osr(&std::fs::read(&entry.replay_path).map_err(|e| format!("read: {e}"))?)
            .map_err(|e| format!("osr: {e}"))?;
    let frames = convert_frames(&osr.actions, map.format_version);
    let timeline = simulate(&processed, &frames).map_err(|e| format!("simulate: {e}"))?;
    let stars = peppy_stars(&ScoreContext::from_beatmap(&map)).map_err(|e| format!("stars: {e}"))?;
    let simulated = total_score(&timeline, &processed, stars, NOMOD_SCORE_MULTIPLIER);
    let delta = u64::from(osr.header.total_score) as i64 - simulated as i64;

    // per-object event bookkeeping: emission indices decide "first"
    let mut head: Vec<Option<(usize, bool)>> = vec![None; processed.objects.len()];
    let mut tail: Vec<Option<(usize, bool)>> = vec![None; processed.objects.len()];
    let mut scored_points: Vec<Vec<usize>> = vec![Vec::new(); processed.objects.len()];
    for (k, event) in timeline.events.iter().enumerate() {
        match event.kind {
            JudgementKind::SliderHead { hit } => head[event.object_index] = Some((k, hit)),
            JudgementKind::SliderTail { hit } => tail[event.object_index] = Some((k, hit)),
            JudgementKind::SliderTick { hit: true } | JudgementKind::SliderRepeat { hit: true, .. } => {
                scored_points[event.object_index].push(k)
            }
            _ => {}
        }
    }

    let mut sliders = Vec::new();
    for (index, obj) in processed.objects.iter().enumerate() {
        let ProcessedKind::Slider(slider) = &obj.kind else { continue };
        let Some((head_index, head_hit)) = head[index] else { continue };
        if head_hit {
            continue;
        }
        // a tail point left unjudged emits no event; that is "not hit"
        let (tail_index, tail_hit) = tail[index].unwrap_or((usize::MAX, false));
        let scored_between = scored_points[index]
            .iter()
            .any(|&k| k > head_index && k < tail_index);
        sliders.push(HeadMissedSlider {
            object_index: index,
            tail_hit,
            tickless: slider.stable_points.len() == 1,
            head_miss_first: head_index < tail_index,
            scored_between,
            points: slider.stable_points.len(),
        });
    }

    let has_spinners = processed
        .objects
        .iter()
        .any(|o| matches!(o.kind, ProcessedKind::Spinner(_)));
    let count_exact = entry.fields.keys().all(|k| k == "total_score");

    Ok(PlayReport {
        stem: entry.stem.clone(),
        beatmap_path: entry.beatmap_path.clone(),
        delta,
        has_spinners,
        count_exact,
        sliders,
    })
}
