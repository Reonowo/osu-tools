mod fixture_util;

use engine::beatmap::process_beatmap;
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::decode_osr;
use engine::replay::frames::convert_frames;
use engine::score::{peppy_stars, section_tally, total_score, ScoreContext, NOMOD_SCORE_MULTIPLIER};
use engine::simulation::simulate;

/// human-ratified deliberate divergences in the local corpus -- a visible
/// exception ledger, never a silent allowlist. each entry names the replay
/// stem, the single field allowed to diverge with its exact signed delta
/// (simulated minus header), the mechanism, and where the ratification is
/// recorded. the corpus test enforces the entry in both directions: a
/// drifted delta is new behaviour hiding behind an old record, and a
/// vanished divergence is a stale record -- either way the run fails and
/// the entry comes back for human review
struct RatifiedDivergence {
    stem: &'static str,
    /// simulated total score minus the header's; every other field must stay exact
    score_delta: i64,
    mechanism: &'static str,
    record: &'static str,
}

const RATIFIED_DIVERGENCES: &[RatifiedDivergence] = &[RatifiedDivergence {
    stem: "L033---cosmobousou-p---denpa-shoujo",
    score_delta: -19_580,
    mechanism: "intra-frame ordering: a head-miss deadline and a tail point 2ms apart land on one \
                replay frame and apply in walk order, not due-time order, costing one combo unit \
                over the closing run",
    record: "ratified 2026-08-12; .scratch/engine-parity-pass/issues/05 closing comment",
}];

/// spec parity rule 2: the .osr header's counts and max combo are the oracle.
/// corpus layout: fixtures/replays/local/<name>.osr with a sibling
/// <name>.osu (same stem). the directory is gitignored; an empty or missing
/// directory passes with a notice so ci stays green without personal data
#[test]
fn local_nomod_replays_self_verify() {
    let dir = fixture_util::fixtures_dir().join("replays/local");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("corpus: {dir:?} missing, skipping");
        return;
    };

    let mut checked = 0;
    let mut ratified = 0;
    // every failing pair is reported before the assertion so a red run
    // shows the whole corpus picture, not the alphabetically first mismatch
    let mut failures: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("osr") {
            continue;
        }
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let osu_path = path.with_extension("osu");
        if !osu_path.exists() {
            eprintln!("corpus: {name}: no sibling .osu, skipping");
            continue;
        }

        let osr = match decode_osr(&std::fs::read(&path).unwrap()) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("corpus: {name}: not simulatable ({e}), skipping");
                continue;
            }
        };
        if osr.header.mods != 0 {
            eprintln!("corpus: {name}: modded (0x{:x}), skipping", osr.header.mods);
            continue;
        }

        let map = decode_beatmap_path(&osu_path).unwrap_or_else(|e| panic!("{name}: beatmap: {e}"));
        let processed = process_beatmap(&map).unwrap_or_else(|e| panic!("{name}: process: {e}"));
        let frames = convert_frames(&osr.actions, map.format_version);
        let timeline = simulate(&processed, &frames).unwrap_or_else(|e| panic!("{name}: simulate: {e}"));

        let simulated = (
            timeline.totals.count_300,
            timeline.totals.count_100,
            timeline.totals.count_50,
            timeline.totals.count_miss,
            timeline.totals.max_combo,
        );
        let header = (
            u32::from(osr.header.count_300),
            u32::from(osr.header.count_100),
            u32::from(osr.header.count_50),
            u32::from(osr.header.count_miss),
            u32::from(osr.header.max_combo),
        );
        let ratification = RATIFIED_DIVERGENCES.iter().find(|r| r.stem == name);
        if simulated != header {
            // the ledger covers total score only; a ratified stem whose
            // counts diverge means the record no longer describes reality
            let stale = ratification
                .map(|r| format!(" (a ratified score-only divergence is on record -- review it: {})", r.record))
                .unwrap_or_default();
            failures.push(format!(
                "{name}: simulated totals {simulated:?} diverge from the header's {header:?}{stale}"
            ));
            continue;
        }

        // the derived fields the export regenerates, against the same oracle.
        // this is the only oracle geki/katu have (the pinned lazer encoder
        // writes zeros for osu!), and the first observable check on achieved
        // scorev1 -- a mismatch that implicates simulation itself (e.g.
        // spinner bonus-spin counts) is a simulation finding to file, never
        // something to patch silently inside the score module
        let tally = section_tally(&processed, &timeline);
        let stars =
            peppy_stars(&ScoreContext::from_beatmap(&map)).unwrap_or_else(|e| panic!("{name}: stars: {e}"));
        let derived = (
            tally.count_geki,
            tally.count_katsu,
            total_score(&timeline, &processed, stars, NOMOD_SCORE_MULTIPLIER),
        );
        let header_derived = (
            u32::from(osr.header.count_geki),
            u32::from(osr.header.count_katsu),
            u64::from(osr.header.total_score),
        );
        match ratification {
            Some(r) => {
                let score_delta = derived.2 as i64 - header_derived.2 as i64;
                if (derived.0, derived.1) != (header_derived.0, header_derived.1) {
                    failures.push(format!(
                        "{name}: geki/katu ({}, {}) diverge from the header's ({}, {}); the ratified \
                         record covers total score only -- review it: {}",
                        derived.0, derived.1, header_derived.0, header_derived.1, r.record
                    ));
                } else if score_delta == r.score_delta {
                    eprintln!(
                        "corpus: {name}: ratified divergence stands (score {:+}; {}; {})",
                        r.score_delta, r.mechanism, r.record
                    );
                    ratified += 1;
                } else if score_delta == 0 {
                    failures.push(format!(
                        "{name}: the ratified score divergence ({:+}) no longer reproduces -- the \
                         ledger entry is stale; review it: {}",
                        r.score_delta, r.record
                    ));
                } else {
                    failures.push(format!(
                        "{name}: score delta {score_delta:+} differs from the ratified {:+} -- new \
                         behaviour is hiding behind the record; review it: {}",
                        r.score_delta, r.record
                    ));
                }
                continue;
            }
            None if derived != header_derived => {
                failures.push(format!(
                    "{name}: derived geki/katu/score {derived:?} diverge from the header's {header_derived:?}"
                ));
                continue;
            }
            None => {}
        }
        checked += 1;
    }
    // a ledger entry whose pair is absent from THIS corpus validates
    // nothing this run -- said out loud rather than silently passing, but
    // never a failure: the corpus is per-machine personal data and another
    // machine legitimately lacks the stem
    let verified_stems: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    for entry in RATIFIED_DIVERGENCES {
        if !verified_stems.iter().any(|s| s == entry.stem) {
            eprintln!(
                "corpus NOTICE: ratified-divergence ledger entry {} has no pair in this corpus -- unverified this run",
                entry.stem
            );
        }
    }
    for failure in &failures {
        eprintln!("corpus FAIL: {failure}");
    }
    assert!(
        failures.is_empty(),
        "{} corpus replays diverge from their headers (list above)",
        failures.len()
    );
    eprintln!("corpus: verified {checked} replays exact, {ratified} on the ratified-divergence ledger");
}

/// committed stand-in for the corpus: a synthetic replay that full-combos the
/// slider-zoo fixture map (`beatmaps/slider-zoo-v14.osu`), with hand-derivable
/// totals. exercises decode -> process -> simulate end to end on every ci run
///
/// precondition check (plan defect a7): the fixture map's five sliders start
/// at 1000/4000/8000/12000/15000ms and the smallest end-to-start gap is
/// 13500 -> 15000 = 1500ms, dwarfing every window that could let one
/// object's auto-judgement interfere with an adjacent one -- the od7 meh
/// window (129.5ms, from `windows.meh` in the fixture dump), the tail
/// leniency window (36ms) and the note-lock shake leniency (3ms). the
/// originally-considered `stacking-v14.osu` fails this same check: its od8.3
/// meh window is 115.5ms (`difficulty_range(8.3, 200, 150, 100).floor() -
/// 0.5` = `150 - 10*(8.3-5)` truncated to 116, minus 0.5), while its circles
/// sit only 100ms apart (1000/1100/1200, 2400/2500, 3400/3500) --
/// `2 * 115.5 = 231 > 100`, so consecutive hit windows genuinely overlap
/// there. `spinners-combos-od10.osu` has spinners, which this test's frame
/// builder does not drive; `old-format-v4.osu`'s od6 meh window (139.5ms)
/// overlaps its own 100ms circle gaps the same way; `v7-tick-multiplier.osu`
/// has only one object, so "consecutive" is vacuous and it is not the map
/// this test's derivation was written against. slider-zoo-v14 is therefore
/// both the correctly-named and the only comfortably non-overlapping choice
#[test]
fn synthetic_full_combo_on_the_fixture_map() {
    let map = decode_beatmap_path(&fixture_util::fixtures_dir().join("beatmaps/slider-zoo-v14.osu")).unwrap();
    let processed = process_beatmap(&map).unwrap();

    // build frames that press exactly on every object's stacked position at
    // its start time (alternating buttons to sidestep the slider key
    // restriction), track every slider ball sampled at 10ms steps, and idle
    // otherwise. the map has no circles or spinners by construction -- every
    // object is a slider
    let frames = engine_test_helpers::full_combo_frames(&processed);
    let timeline = simulate(&processed, &frames).unwrap();

    let expected_basics = processed.objects.len() as u32;
    assert_eq!(timeline.totals.count_300, expected_basics, "everything greats");
    assert_eq!(timeline.totals.count_miss, 0);

    // stable max combo: circles 1 each; sliders head + ticks + repeats + tail.
    // for this map (five sliders, no circles) the per-object nested counts
    // are 10, 2, 2, 11, 3 -- sum 28 (slider 1: head + 6 ticks + 2 repeats +
    // tail; sliders 2 and 3: head + tail only, span_count 1 and, for slider
    // 3, ticks disabled by the 8000,nan inherited timing point; slider 4:
    // head + 8 ticks + 1 repeat + tail; slider 5: head + 1 tick + tail)
    let expected_max_combo: u32 = processed
        .objects
        .iter()
        .map(|o| match &o.kind {
            engine::beatmap::ProcessedKind::Slider(s) => s.nested.len() as u32,
            _ => 1,
        })
        .sum();
    assert_eq!(timeline.totals.max_combo, expected_max_combo);

    // a full combo of nothing but greats makes every section geki, so the
    // committed path also exercises the corpus's derived-field assertions
    let tally = section_tally(&processed, &timeline);
    assert_eq!(
        (tally.count_geki, tally.count_katsu, tally.sections_without_burst),
        (tally.sections, 0, 0),
        "an all-great full combo is all geki"
    );

    // and the achieved total on this spinner-free full combo is exactly the
    // theoretical maximum lazer's own simulator dumped for the map
    let dump: fixture_util::LegacyScoreAttributesDump =
        fixture_util::load_json("score/legacy_score_attributes.json");
    let attributes = dump
        .maps
        .iter()
        .find(|m| m.name == "slider-zoo-v14")
        .expect("the score dump family covers the fixture maps");
    let stars = peppy_stars(&ScoreContext::from_beatmap(&map)).unwrap();
    assert_eq!(
        total_score(&timeline, &processed, stars, NOMOD_SCORE_MULTIPLIER),
        attributes.accuracy_score + attributes.combo_score,
        "simulated full-combo total matches lazer's dumped attributes"
    );
}

/// shared test-only frame builder for the synthetic full-combo test above
mod engine_test_helpers {
    use engine::beatmap::{ProcessedBeatmap, ProcessedKind};
    use engine::math::Vec2;
    use engine::replay::frames::{Buttons, ReplayFrame};

    /// walks `processed.objects` in order and builds a replay that hits
    /// everything: circles get an idle approach frame then a press on their
    /// stacked position; sliders get a press on the head followed by frames
    /// every 10ms tracing `stacked_position + curve_position_at(progress)`
    /// through `end_time`, holding one button the whole way, then a release
    /// 20ms later. buttons alternate left/right per object so the slider
    /// key-restriction (sliderinputmanager.cs:31-44) never has a chance to
    /// engage across adjacent objects. every time is rounded onto the whole
    /// millisecond a real replay frame is confined to
    pub fn full_combo_frames(processed: &ProcessedBeatmap) -> Vec<ReplayFrame> {
        let mut frames = Vec::new();
        for (i, obj) in processed.objects.iter().enumerate() {
            let button = if i % 2 == 0 {
                Buttons::LEFT_1
            } else {
                Buttons::RIGHT_1
            };
            match &obj.kind {
                ProcessedKind::Circle => {
                    frames.push(idle(obj.start_time - 200.0, obj.stacked_position));
                    frames.push(press(obj.start_time, obj.stacked_position, button));
                    frames.push(idle(obj.start_time + 10.0, obj.stacked_position));
                }
                ProcessedKind::Slider(s) => {
                    let mut t = obj.start_time;
                    while t < obj.end_time {
                        let progress = ((t - obj.start_time) / s.duration).clamp(0.0, 1.0);
                        let pos = obj.stacked_position + s.curve_position_at(progress);
                        frames.push(press(t.round(), pos, button));
                        t += 10.0;
                    }
                    let tail_pos = obj.stacked_position + s.curve_position_at(1.0);
                    frames.push(press(obj.end_time.round(), tail_pos, button));
                    frames.push(idle((obj.end_time + 20.0).round(), tail_pos));
                }
                ProcessedKind::Spinner(_) => {
                    unreachable!("the fixture map this helper is built for has no spinners")
                }
            }
        }
        frames
    }

    fn press(time: f64, pos: Vec2, button: u32) -> ReplayFrame {
        ReplayFrame {
            time,
            pos,
            buttons: Buttons::new(button),
        }
    }

    fn idle(time: f64, pos: Vec2) -> ReplayFrame {
        ReplayFrame {
            time,
            pos,
            buttons: Buttons::new(0),
        }
    }
}
