mod fixture_util;

use engine::beatmap::process_beatmap;
use engine::formats::beatmap::decode_beatmap_path;

/// smoke test over the committed judgement-dump family: every scenario
/// deserializes, its map decodes and processes, and its events stay inside
/// the map's object/nested bounds. skipless -- the family is committed, so
/// an absent or malformed dump is a failure, never a notice. the
/// per-mechanism comparisons against these dumps live with their fixes
/// (spinner scoring, slider tracking, note-lock lifetime), not here
#[test]
fn judgement_dumps_deserialize_and_stay_in_bounds() {
    for scenario in fixture_util::JUDGEMENT_SCENARIOS {
        let dump = fixture_util::load_judgement_dump(scenario);
        assert_eq!(dump.scenario, scenario, "{scenario}: dump names itself");
        assert_eq!(dump.mods, vec!["CL"], "{scenario}: the legacy rules path is the classic mod");
        assert!(!dump.frames.is_empty(), "{scenario}: frames present");
        assert!(!dump.events.is_empty(), "{scenario}: events present");

        let map_path = fixture_util::fixtures_dir()
            .join("judgement/maps")
            .join(&dump.beatmap_file);
        let map = decode_beatmap_path(&map_path).unwrap_or_else(|e| panic!("{scenario}: beatmap: {e}"));
        let processed = process_beatmap(&map).unwrap_or_else(|e| panic!("{scenario}: process: {e}"));

        let frames = fixture_util::judgement_frames(&dump);
        assert!(
            frames.windows(2).all(|w| w[0].time <= w[1].time),
            "{scenario}: frames are time-sorted"
        );

        for (i, event) in dump.events.iter().enumerate() {
            let object = processed
                .objects
                .get(event.object_index)
                .unwrap_or_else(|| panic!("{scenario} event {i}: object_index out of bounds"));
            if let Some(nested_index) = event.nested_index {
                // only sliders and spinners carry nested elements the dump
                // can address; the engine's nested counts need not equal
                // lazer's (spinner ticks are lazer-side bookkeeping), so
                // nested indices are checked for shape, not bounds
                assert!(
                    !matches!(object.kind, engine::beatmap::ProcessedKind::Circle),
                    "{scenario} event {i}: nested element on a circle"
                );
                let _ = nested_index;
            }
            assert!(!event.kind.is_empty() && !event.result.is_empty(), "{scenario} event {i}: named");
        }

        // every top-level object resolves exactly once: each circle,
        // slider, and spinner has exactly one aggregate event
        let mut top_level_counts = vec![0usize; processed.objects.len()];
        for event in dump.events.iter().filter(|e| e.nested_index.is_none()) {
            top_level_counts[event.object_index] += 1;
        }
        assert_eq!(
            top_level_counts,
            vec![1; processed.objects.len()],
            "{scenario}: one aggregate judgement per object"
        );
    }
}

/// the baseline scenario is the harness's own regression canary: its
/// outcomes are fully predictable from the inputs, so a change here means
/// the harness (or the pinned lazer) moved, independent of any engine work
#[test]
fn baseline_scenario_matches_its_design() {
    let dump = fixture_util::load_judgement_dump("baseline");
    let circle_results: Vec<(&str, bool)> = dump
        .events
        .iter()
        .filter(|e| e.kind == "HitCircle")
        .map(|e| (e.result.as_str(), e.is_hit))
        .collect();
    assert_eq!(
        circle_results,
        vec![("Great", true), ("Ok", true), ("Miss", false)],
        "the three circles judge great / ok / miss in order"
    );
    let slider_aggregate = dump
        .events
        .iter()
        .find(|e| e.kind == "Slider")
        .expect("the slider aggregates");
    assert_eq!(
        (slider_aggregate.result.as_str(), slider_aggregate.is_hit),
        ("Great", true),
        "the fully tracked slider aggregates great"
    );
}
