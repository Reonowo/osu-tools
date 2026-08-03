mod fixture_util;

use engine::beatmap::process_beatmap;
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::decode_osr;
use engine::replay::frames::convert_frames;
use engine::simulation::simulate;

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

        assert_eq!(
            (
                timeline.totals.count_300,
                timeline.totals.count_100,
                timeline.totals.count_50,
                timeline.totals.count_miss,
                timeline.totals.max_combo,
            ),
            (
                u32::from(osr.header.count_300),
                u32::from(osr.header.count_100),
                u32::from(osr.header.count_50),
                u32::from(osr.header.count_miss),
                u32::from(osr.header.max_combo),
            ),
            "{name}: simulated totals diverge from the .osr header"
        );
        checked += 1;
    }
    eprintln!("corpus: verified {checked} replays");
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
    let map =
        decode_beatmap_path(&fixture_util::fixtures_dir().join("beatmaps/slider-zoo-v14.osu")).unwrap();
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
            let button = if i % 2 == 0 { Buttons::LEFT_1 } else { Buttons::RIGHT_1 };
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
        ReplayFrame { time, pos, buttons: Buttons::new(button) }
    }

    fn idle(time: f64, pos: Vec2) -> ReplayFrame {
        ReplayFrame { time, pos, buttons: Buttons::new(0) }
    }
}
