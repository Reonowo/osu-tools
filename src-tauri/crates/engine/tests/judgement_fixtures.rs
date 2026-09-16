mod fixture_util;

use std::collections::BTreeMap;

use engine::beatmap::process_beatmap;
use engine::formats::beatmap::decode_beatmap_path;
use engine::score::{rank_from_accuracy, ScoreRank};
use fixture_util::{snake_case_result, JudgementDump};

/// smoke test over the committed judgement-dump family: every scenario
/// deserializes, its map decodes and processes, its events stay inside
/// the map's object/nested bounds, and its end state is consistent with its
/// own events. skipless -- the family is committed, so an absent or
/// malformed dump is a failure, never a notice. the per-mechanism
/// comparisons against these dumps live with their fixes (spinner scoring,
/// slider tracking, note-lock lifetime, the native walk), not here
#[test]
fn judgement_dumps_deserialize_and_stay_in_bounds() {
    for scenario in fixture_util::JUDGEMENT_SCENARIOS {
        let dump = fixture_util::load_judgement_dump(scenario);
        assert_eq!(dump.scenario, scenario, "{scenario}: dump names itself");
        // each scenario names its own rules path: the classic mod for the
        // legacy path the stable profile ports, no mods at all for lazer's
        // default gameplay the native profile ports
        assert!(
            dump.mods == vec!["CL"] || dump.mods.is_empty(),
            "{scenario}: mods are classic or none, got {:?}",
            dump.mods
        );
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

        assert_end_state_follows_the_events(&dump);
    }
}

/// the end state is a pure function of the events, so the dump must agree
/// with itself: every result tallied exactly, the max combo the highest
/// running combo, and the rank the one the engine's port of lazer's rank
/// rule reads off the dumped accuracy and miss count -- which is what pins
/// `rank_from_accuracy` against lazer's own ScoreProcessor on every
/// scenario, classic and native alike
fn assert_end_state_follows_the_events(dump: &JudgementDump) {
    let scenario = &dump.scenario;
    let end = &dump.end_state;

    let mut tallied: BTreeMap<String, i64> = BTreeMap::new();
    for event in &dump.events {
        *tallied.entry(snake_case_result(&event.result)).or_default() += 1;
    }
    assert_eq!(tallied, end.statistics, "{scenario}: statistics tally the events");

    let highest_combo = dump.events.iter().map(|e| e.combo_after).max().unwrap_or(0);
    assert_eq!(end.max_combo, highest_combo, "{scenario}: max combo is the highest running combo");

    // a result with a maximum never exceeds it (ok, meh and the misses
    // count toward great's maximum and carry none of their own), and the
    // basic results sum to the maximum's great count: a judged play
    // resolves every basic element one way or another
    for (result, count) in &end.statistics {
        if let Some(maximum) = end.maximum_statistics.get(result) {
            assert!(count <= maximum, "{scenario}: {result} scored {count} above its maximum {maximum}");
        }
    }
    let basic: i64 = ["great", "ok", "meh", "miss"]
        .iter()
        .map(|r| end.statistics.get(*r).copied().unwrap_or(0))
        .sum();
    assert_eq!(
        basic,
        end.maximum_statistics.get("great").copied().unwrap_or(0),
        "{scenario}: every basic element judged once"
    );

    assert!((0.0..=1.0).contains(&end.accuracy), "{scenario}: accuracy in range");
    assert!(end.total_score >= 0, "{scenario}: total score non-negative");
    let misses = end.statistics.get("miss").copied().unwrap_or(0) as u32;
    let expected = ScoreRank::from_name(&end.rank)
        .unwrap_or_else(|| panic!("{scenario}: lazer rank {:?} unknown to the engine", end.rank));
    assert_eq!(
        rank_from_accuracy(end.accuracy, misses),
        expected,
        "{scenario}: the engine's rank rule reads lazer's rank off lazer's accuracy"
    );
}

/// the native baseline is the native profile's own regression canary, as
/// the classic baseline is the stable profile's: every outcome follows from
/// the inputs, so a change here means the harness or the pinned lazer
/// moved. it also fixes the native result vocabulary the walk emits: a
/// timed grade on a slider head, LargeTickHit per tick, SliderTailHit on
/// the tail that increments combo, IgnoreHit for the slider itself, and
/// small then large bonus per spinner tick
#[test]
fn native_baseline_scenario_matches_its_design() {
    let dump = fixture_util::load_judgement_dump("native-baseline");
    assert!(dump.mods.is_empty(), "the native baseline runs lazer's default gameplay");

    let circle_results: Vec<(&str, bool)> = dump
        .events
        .iter()
        .filter(|e| e.kind == "HitCircle")
        .map(|e| (e.result.as_str(), e.is_hit))
        .collect();
    assert_eq!(
        circle_results,
        vec![("Great", true), ("Ok", true), ("Meh", true), ("Miss", false)],
        "the four circles judge great / ok / meh / miss in order"
    );

    let slider_elements: Vec<(&str, &str, u32)> = dump
        .events
        .iter()
        .filter(|e| e.object_index == 4)
        .map(|e| (e.kind.as_str(), e.result.as_str(), e.combo_after))
        .collect();
    assert_eq!(
        slider_elements,
        vec![
            ("SliderHeadCircle", "Great", 1),
            ("SliderTick", "LargeTickHit", 2),
            ("SliderTick", "LargeTickHit", 3),
            ("SliderTick", "LargeTickHit", 4),
            ("SliderTailCircle", "SliderTailHit", 5),
            ("Slider", "IgnoreHit", 5),
        ],
        "the tracked slider's head is graded, its ticks and tail count combo, and the slider itself is ignored"
    );

    let spinner = dump.events.iter().find(|e| e.kind == "Spinner").expect("the spinner aggregates");
    assert_eq!((spinner.result.as_str(), spinner.combo_after), ("Great", 6), "the fast spin is great and counts combo");
    let bonus: Vec<&str> = dump
        .events
        .iter()
        .filter(|e| e.object_index == 5 && e.nested_index.is_some() && e.is_hit)
        .map(|e| e.result.as_str())
        .collect();
    assert!(
        bonus.starts_with(&["SmallBonus"]) && bonus.ends_with(&["LargeBonus"]),
        "spinner ticks award small bonus first, then large: {bonus:?}"
    );

    let end = &dump.end_state;
    assert_eq!(end.max_combo, 6);
    assert_eq!(end.statistics.get("great"), Some(&3));
    assert_eq!(end.statistics.get("ok"), Some(&1));
    assert_eq!(end.statistics.get("meh"), Some(&1));
    assert_eq!(end.statistics.get("miss"), Some(&1));
    assert_eq!(end.statistics.get("large_tick_hit"), Some(&3));
    assert_eq!(end.statistics.get("slider_tail_hit"), Some(&1));
    assert_eq!(end.maximum_statistics.get("great"), Some(&6), "six basic elements: four circles, a head, a spinner");
    assert_eq!(end.rank, "D");
}

/// one set of frames dumped under both rules paths: where the two profiles
/// differ is exactly what the native fold must not inherit from the stable
/// one. the head's judgement, the tail's result and the combo through the
/// tail all differ; the circles before the slider do not
#[test]
fn the_pinned_apart_pair_separates_the_profiles() {
    let classic = fixture_util::load_judgement_dump("pinned-apart-classic");
    let native = fixture_util::load_judgement_dump("pinned-apart-native");
    assert_eq!(classic.mods, vec!["CL"]);
    assert!(native.mods.is_empty());
    assert_eq!(classic.frames.len(), native.frames.len(), "the same frames");
    assert!(
        classic.frames.iter().zip(&native.frames).all(|(a, b)| a.time == b.time && a.pos == b.pos),
        "the same frames"
    );

    let elements = |dump: &JudgementDump, object: usize| -> Vec<(String, String, u32)> {
        dump.events
            .iter()
            .filter(|e| e.object_index == object)
            .map(|e| (e.kind.clone(), e.result.clone(), e.combo_after))
            .collect()
    };
    for circle in 0..3 {
        assert_eq!(elements(&classic, circle), elements(&native, circle), "circle {circle} judges alike");
    }

    let head = |dump: &JudgementDump| {
        dump.events.iter().find(|e| e.kind == "SliderHeadCircle").map(|e| e.result.clone()).unwrap()
    };
    assert_eq!(head(&classic), "LargeTickHit", "classic: a late head is a tick, not a grade");
    assert_eq!(head(&native), "Ok", "native: a late head carries its timing grade");

    let tail = |dump: &JudgementDump| {
        dump.events
            .iter()
            .find(|e| e.kind == "SliderTailCircle")
            .map(|e| (e.result.clone(), e.combo_after))
            .unwrap()
    };
    assert_eq!(tail(&classic), ("SmallTickHit".to_owned(), 2), "classic: the tail does not increment combo");
    assert_eq!(tail(&native), ("SliderTailHit".to_owned(), 3), "native: the tail increments combo");

    let aggregate = |dump: &JudgementDump| {
        dump.events.iter().find(|e| e.kind == "Slider").map(|e| e.result.clone()).unwrap()
    };
    assert_eq!(aggregate(&classic), "Great", "classic: the slider itself carries the grade");
    assert_eq!(aggregate(&native), "IgnoreHit", "native: the slider itself is ignored");

    assert_ne!(
        classic.end_state.statistics, native.end_state.statistics,
        "the two end states are different vocabularies"
    );
    assert_ne!(classic.end_state.total_score, native.end_state.total_score);
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
