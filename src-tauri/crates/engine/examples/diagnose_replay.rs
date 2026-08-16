//! diagnose_replay: per-play triage instrument for the engine parity pass --
//! where the sweep (sweep_replays) measures the library and its manifest
//! names the diverging fields, this dumps ONE play in enough detail to
//! root-cause the divergence: the eight oracle comparisons, per-combo-section
//! grades behind geki/katu, every slider whose parts did not all score,
//! spinner half-spin tallies behind the stable scorev1 tick model, and the
//! map's nested composition against the header's implied combo ceiling.
//!
//! usage (from `src-tauri/`):
//!
//!   cargo run -p engine --release --example diagnose_replay -- <map.osu>
//!   cargo run -p engine --release --example diagnose_replay -- <map.osu> <replay.osr> [--events]
//!
//! with only a map, prints the slider nested composition and the maximum
//! achievable combo -- enough to test a map-level tick-generation hypothesis
//! against any known max combo. with a replay, adds the simulated timeline
//! views. `--events` dumps every judgement event instead of only the
//! not-fully-scored sliders.
//!
//! like the sweep, this is an example, never a test: ci never sees it, and
//! it always exits 0 with the numbers as its output.

use std::collections::BTreeMap;
use std::path::PathBuf;

use engine::beatmap::stable_points::StablePointKind;
use engine::beatmap::{process_beatmap, NestedKind, ProcessedBeatmap, ProcessedKind};
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::decode_osr;
use engine::replay::frames::convert_frames;
use engine::score::{
    max_achievable_combo, peppy_stars, section_tally, total_score, ScoreContext, NOMOD_SCORE_MULTIPLIER,
};
use engine::simulation::score::JudgementKind;
use engine::simulation::{simulate, JudgementTimeline};

fn main() {
    let mut args = std::env::args().skip(1);
    let map_path = args.next().map(PathBuf::from).unwrap_or_else(|| usage("no map given"));
    let mut replay_path: Option<PathBuf> = None;
    let mut dump_events = false;
    for arg in args {
        match arg.as_str() {
            "--events" => dump_events = true,
            other if replay_path.is_none() => replay_path = Some(PathBuf::from(other)),
            other => usage(&format!("unexpected argument {other:?}")),
        }
    }

    let map = decode_beatmap_path(&map_path).expect("decode beatmap");
    let processed = process_beatmap(&map).expect("process beatmap");
    print_map_summary(&processed);

    let Some(replay_path) = replay_path else { return };
    let osr = decode_osr(&std::fs::read(&replay_path).expect("read replay")).expect("decode replay");
    let frames = convert_frames(&osr.actions, map.format_version);
    let timeline = simulate(&processed, &frames).expect("simulate");
    let tally = section_tally(&processed, &timeline);
    let stars = peppy_stars(&ScoreContext::from_beatmap(&map)).expect("stars");
    let score = total_score(&timeline, &processed, stars, NOMOD_SCORE_MULTIPLIER);

    println!("\n== header vs simulated ==");
    let rows: [(&str, u64, u64); 8] = [
        ("count_300", osr.header.count_300.into(), timeline.totals.count_300.into()),
        ("count_100", osr.header.count_100.into(), timeline.totals.count_100.into()),
        ("count_50", osr.header.count_50.into(), timeline.totals.count_50.into()),
        ("count_miss", osr.header.count_miss.into(), timeline.totals.count_miss.into()),
        ("max_combo", osr.header.max_combo.into(), timeline.totals.max_combo.into()),
        ("count_geki", osr.header.count_geki.into(), tally.count_geki.into()),
        ("count_katsu", osr.header.count_katsu.into(), tally.count_katsu.into()),
        ("total_score", osr.header.total_score.into(), score),
    ];
    for (name, header, simulated) in rows {
        let marker = if header == simulated { "" } else { "   <-- DIVERGES" };
        println!("  {name:<12} header {header:>10}  simulated {simulated:>10}{marker}");
    }
    println!("  peppy stars {stars}");

    print_sections(&processed, &timeline);
    print_gekikatu_trace(&processed, &timeline);
    print_sliders(&processed, &timeline, dump_events);
    print_spinners(&processed, &timeline);
    if dump_events {
        println!("\n== full event timeline with scorev1 contributions ==");
        // replay the achieved fold event by event so each row shows what it
        // added -- the same arithmetic as score::scorev1::total_score
        use engine::simulation::score::ScoreState;
        let mut state = ScoreState::default();
        let mut running: u64 = 0;
        for event in &timeline.events {
            let combo_before = u64::from(state.combo);
            let added = match event.kind {
                JudgementKind::SliderHead { hit }
                | JudgementKind::SliderRepeat { hit, .. }
                | JudgementKind::SliderTail { hit } => {
                    if hit {
                        30
                    } else {
                        0
                    }
                }
                JudgementKind::SliderTick { hit } => {
                    if hit {
                        10
                    } else {
                        0
                    }
                }
                JudgementKind::SpinnerSpin | JudgementKind::SpinnerBonus => 0,
                JudgementKind::Circle(grade)
                | JudgementKind::SpinnerFinal(grade)
                | JudgementKind::SliderAggregate(grade) => {
                    let base: u64 = match grade {
                        engine::beatmap::difficulty::HitGrade::Great => 300,
                        engine::beatmap::difficulty::HitGrade::Ok => 100,
                        engine::beatmap::difficulty::HitGrade::Meh => 50,
                        engine::beatmap::difficulty::HitGrade::Miss => 0,
                    };
                    base + combo_before.saturating_sub(1) * (base / 25) * stars.max(0) as u64
                }
            };
            state.apply(&event.kind);
            running += added;
            println!(
                "  t={:<10} obj {:<4} {:?} combo {}->{} +{added} = {running}",
                event.time, event.object_index, event.kind, combo_before, state.combo
            );
        }
    }
}

fn usage(problem: &str) -> ! {
    eprintln!("diagnose_replay: {problem}");
    eprintln!("usage: cargo run -p engine --release --example diagnose_replay -- <map.osu> [replay.osr] [--events]");
    std::process::exit(2);
}

fn print_map_summary(processed: &ProcessedBeatmap) {
    let mut circles = 0usize;
    let mut sliders = 0usize;
    let mut spinners = 0usize;
    for obj in &processed.objects {
        match obj.kind {
            ProcessedKind::Circle => circles += 1,
            ProcessedKind::Slider(_) => sliders += 1,
            ProcessedKind::Spinner(_) => spinners += 1,
        }
    }
    println!("== map ==");
    println!("  objects: {} ({circles} circles, {sliders} sliders, {spinners} spinners)", processed.objects.len());
    println!("  max achievable combo: {}", max_achievable_combo(processed));

    println!("\n== slider nested composition ==");
    for (index, obj) in processed.objects.iter().enumerate() {
        let ProcessedKind::Slider(slider) = &obj.kind else { continue };
        let mut kinds: BTreeMap<&'static str, usize> = BTreeMap::new();
        for nested in &slider.nested {
            *kinds
                .entry(match nested.kind {
                    NestedKind::Head => "head",
                    NestedKind::Tick => "tick",
                    NestedKind::Repeat => "repeat",
                    NestedKind::Tail => "tail",
                })
                .or_default() += 1;
        }
        let breakdown: Vec<String> = kinds.iter().map(|(k, n)| format!("{n} {k}")).collect();
        let stable_ticks = slider
            .stable_points
            .iter()
            .filter(|p| p.kind == StablePointKind::Tick)
            .count();
        // lazer's tick count for the same slider, for the side-by-side
        let lazer_ticks = kinds.get("tick").copied().unwrap_or(0);
        let marker = if stable_ticks != lazer_ticks
            || (slider.stable_end_time - obj.end_time.floor()).abs() > 0.5
        {
            "   <-- stable differs"
        } else {
            ""
        };
        println!(
            "  obj {index:<4} t={:<9} spans {} tickdist {:.3} nested {} ({}) | stable {} pts ({stable_ticks} ticks) end {} (lazer end {}){marker}",
            obj.start_time,
            slider.span_count,
            slider.tick_distance,
            slider.nested.len(),
            breakdown.join(", "),
            slider.stable_points.len(),
            slider.stable_end_time,
            obj.end_time,
        );
    }
}

/// the stable section boundaries sections.rs derives under
/// (`stable_new_combo`), with each member's final grade. this is the
/// grade-view only -- the temporal machine's counter attribution and
/// allClicked withholding are order effects this listing cannot show
fn print_sections(processed: &ProcessedBeatmap, timeline: &JudgementTimeline) {
    let mut grades: Vec<Option<&'static str>> = vec![None; processed.objects.len()];
    for event in &timeline.events {
        let grade = match event.kind {
            JudgementKind::Circle(g) | JudgementKind::SliderAggregate(g) | JudgementKind::SpinnerFinal(g) => g,
            _ => continue,
        };
        grades[event.object_index] = Some(match grade {
            engine::beatmap::difficulty::HitGrade::Great => "300",
            engine::beatmap::difficulty::HitGrade::Ok => "100",
            engine::beatmap::difficulty::HitGrade::Meh => "50",
            engine::beatmap::difficulty::HitGrade::Miss => "miss",
        });
    }

    println!("\n== stable sections (grade-view) ==");
    let mut section = 0usize;
    let mut first_index = 0usize;
    let mut members: Vec<String> = Vec::new();
    for (index, _) in processed.objects.iter().enumerate() {
        members.push(grades[index].unwrap_or("unjudged").to_string());
        let last = index + 1 == processed.objects.len()
            || processed.objects[index + 1].stable_new_combo;
        if last {
            println!(
                "  section {section:<4} objs {first_index}-{index} [{}] -> {}",
                members.join(" "),
                classify(&members)
            );
            section += 1;
            first_index = index + 1;
            members.clear();
        }
    }
}

fn classify(grades: &[String]) -> &'static str {
    if grades.iter().any(|g| g == "miss" || g == "50" || g == "unjudged") {
        "neither"
    } else if grades.iter().all(|g| g == "300") {
        "geki"
    } else {
        "katu"
    }
}

/// replays score::sections' temporal machine with tracing: every non-great
/// counter bump and every trigger decision, so a header katu/geki mismatch
/// localizes to the exact section and the exact order effect
fn print_gekikatu_trace(processed: &ProcessedBeatmap, timeline: &JudgementTimeline) {
    use engine::beatmap::difficulty::HitGrade;
    let objects = &processed.objects;
    let is_section_last = |i: usize| i + 1 == objects.len() || objects[i + 1].stable_new_combo;

    // final result event index + time per object, and slider head times
    let mut final_event: Vec<Option<(usize, f64)>> = vec![None; objects.len()];
    let mut head_time: Vec<Option<f64>> = vec![None; objects.len()];
    for (k, event) in timeline.events.iter().enumerate() {
        match event.kind {
            JudgementKind::Circle(_) | JudgementKind::SliderAggregate(_) | JudgementKind::SpinnerFinal(_) => {
                final_event[event.object_index] = Some((k, event.time));
            }
            JudgementKind::SliderHead { .. } => head_time[event.object_index] = Some(event.time),
            _ => {}
        }
    }

    // section number by the ender's object index, so the trace matches the
    // section listing even when triggers fire out of object order
    let mut section_of_ender = vec![0usize; objects.len()];
    let mut section_counter = 0usize;
    for i in 0..objects.len() {
        if is_section_last(i) {
            section_of_ender[i] = section_counter;
            section_counter += 1;
        }
    }

    println!("\n== geki/katu machine trace (bumps and non-geki triggers) ==");
    let mut current_katu = 0u32;
    let mut current_bad = 0u32;
    for (k, event) in timeline.events.iter().enumerate() {
        let grade = match event.kind {
            JudgementKind::Circle(g) | JudgementKind::SliderAggregate(g) | JudgementKind::SpinnerFinal(g) => g,
            _ => continue,
        };
        match grade {
            HitGrade::Ok => {
                current_katu += 1;
                println!("  bump katu (obj {} @ t={} event {k})", event.object_index, event.time);
            }
            HitGrade::Meh | HitGrade::Miss => {
                current_bad += 1;
                println!("  bump bad  (obj {} @ t={} event {k}, {grade:?})", event.object_index, event.time);
            }
            HitGrade::Great => {}
        }
        let index = event.object_index;
        if index >= objects.len() || !is_section_last(index) {
            continue;
        }
        // reproduce the allClicked walk with the blocker named
        let mut blocker: Option<usize> = None;
        for j in (0..index).rev() {
            let finished = match objects[j].kind {
                ProcessedKind::Slider(_) => final_event[j]
                    .map(|(_, t)| t)
                    .unwrap_or(f64::NEG_INFINITY)
                    .max(head_time[j].unwrap_or(f64::INFINITY)),
                _ => final_event[j].map(|(_, t)| t).unwrap_or(f64::NEG_INFINITY),
            };
            if finished < event.time {
                continue;
            }
            if !final_event[j].map(|(e, _)| e <= k).unwrap_or(false) {
                blocker = Some(j);
                break;
            }
            if objects[j].stable_new_combo {
                break;
            }
        }
        let award = if grade == HitGrade::Miss {
            "none (ender missed)"
        } else if blocker.is_some() {
            "none (allClicked blocked)"
        } else if current_katu == 0 && current_bad == 0 {
            "geki"
        } else if current_bad == 0 {
            "katu"
        } else {
            "none (bad counter)"
        };
        if award != "geki" {
            println!(
                "  trigger section {:<4} obj {index:<4} t={:<9} event {k:<5} grade {grade:?} katu {current_katu} bad {current_bad}{} -> {award}",
                section_of_ender[index],
                event.time,
                blocker.map(|b| format!(" BLOCKED by obj {b}")).unwrap_or_default()
            );
        }
        current_katu = 0;
        current_bad = 0;
    }
}

/// sliders whose parts did not all score -- the shapes behind the manifest's
/// count/combo/score divergence classes. `--events` widens to every slider
fn print_sliders(processed: &ProcessedBeatmap, timeline: &JudgementTimeline, all: bool) {
    println!("\n== sliders with unscored parts{} ==", if all { " (all sliders)" } else { "" });
    for (index, obj) in processed.objects.iter().enumerate() {
        let ProcessedKind::Slider(slider) = &obj.kind else { continue };
        let events: Vec<_> = timeline.events.iter().filter(|e| e.object_index == index).collect();
        let all_scored = events.iter().all(|e| {
            !matches!(
                e.kind,
                JudgementKind::SliderHead { hit: false }
                    | JudgementKind::SliderTick { hit: false }
                    | JudgementKind::SliderRepeat { hit: false, .. }
                    | JudgementKind::SliderTail { hit: false }
            )
        });
        // a part event count below nested len means points went unjudged
        // (aggregate rides separately); surface those too
        let part_events = events
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    JudgementKind::SliderHead { .. }
                        | JudgementKind::SliderTick { .. }
                        | JudgementKind::SliderRepeat { .. }
                        | JudgementKind::SliderTail { .. }
                )
            })
            .count();
        let complete = part_events == slider.nested.len();
        if all_scored && complete && !all {
            continue;
        }
        println!("  obj {index} t={} ({} nested, {part_events} part events):", obj.start_time, slider.nested.len());
        for event in events {
            println!("    t={:<10} {:?} (combo {})", event.time, event.kind, event.combo_after);
        }
    }
}

fn print_spinners(processed: &ProcessedBeatmap, timeline: &JudgementTimeline) {
    if timeline.spinner_scoring.is_empty() {
        return;
    }
    println!("\n== spinner stable scoring ==");
    for scoring in &timeline.spinner_scoring {
        let Some(ProcessedKind::Spinner(spinner)) =
            processed.objects.get(scoring.object_index).map(|o| &o.kind)
        else {
            continue;
        };
        println!(
            "  obj {} half_spins {} (required {}, possible {}, gate {})",
            scoring.object_index,
            scoring.scoring_half_spins,
            spinner.stable_half_spins_required,
            spinner.total_half_spins_possible,
            spinner.stable_half_spins_required + 3,
        );
    }
}
