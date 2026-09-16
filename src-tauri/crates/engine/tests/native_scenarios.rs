mod fixture_util;

use std::collections::BTreeMap;

use engine::beatmap::difficulty::HitGrade;
use engine::beatmap::process_beatmap;
use engine::formats::beatmap::decode_beatmap_path;
use engine::score::{HitResult, ScoreRank};
use engine::simulation::score::JudgementKind;
use engine::simulation::{simulate_native, JudgementTimeline};
use fixture_util::{judgement_frames, load_judgement_dump, JudgementDump};

// the native profile against lazer's own judgement of the same frames: every
// no-mod scenario in fixtures/judgement/ is replayed through the native walk
// and compared element for element -- object, nested index, result, hit
// flag and running combo, in application order -- and then the end state
// lazer's score processor derived is compared against the walk's own fold.
// the dumps carry no judgement times (the one thing lazer's display cadence
// does not fix), so time is the one field not compared here

/// every dump generated with no mods
fn native_scenarios() -> Vec<JudgementDump> {
    fixture_util::JUDGEMENT_SCENARIOS
        .iter()
        .map(|name| load_judgement_dump(name))
        .filter(|dump| dump.mods.is_empty())
        .collect()
}

fn simulate_scenario(dump: &JudgementDump) -> JudgementTimeline {
    let map_path = fixture_util::fixtures_dir()
        .join("judgement/maps")
        .join(&dump.beatmap_file);
    let map = decode_beatmap_path(&map_path).expect("scenario map decodes");
    let processed = process_beatmap(&map).expect("scenario map processes");
    simulate_native(&processed, &judgement_frames(dump)).expect("scenario simulates natively")
}

/// one judgement as both sides describe it
#[derive(Debug, Clone, PartialEq, Eq)]
struct Element {
    object: usize,
    nested: Option<usize>,
    result: &'static str,
    hit: bool,
    combo_after: u32,
}

fn grade_name(grade: HitGrade) -> &'static str {
    match grade {
        HitGrade::Great => "Great",
        HitGrade::Ok => "Ok",
        HitGrade::Meh => "Meh",
        HitGrade::Miss => "Miss",
    }
}

fn hit_or(hit: bool, on_hit: &'static str, on_miss: &'static str) -> (&'static str, bool) {
    if hit {
        (on_hit, true)
    } else {
        (on_miss, false)
    }
}

/// the walk's events in the dump's vocabulary. spinner ticks carry no index
/// on the timeline, so it is recovered from their order: lazer awards them
/// in nested order, one per completed spin
fn engine_elements(timeline: &JudgementTimeline) -> Vec<Element> {
    let mut spinner_ticks: BTreeMap<usize, usize> = BTreeMap::new();
    timeline
        .events
        .iter()
        .map(|event| {
            let (nested, (result, hit)) = match event.kind {
                JudgementKind::Circle(grade) => (None, (grade_name(grade), grade != HitGrade::Miss)),
                JudgementKind::SliderHead { grade } => (Some(0), (grade_name(grade), grade != HitGrade::Miss)),
                JudgementKind::SliderTick { hit, nested_index } | JudgementKind::SliderRepeat { hit, nested_index, .. } => (
                    nested_index.map(|i| i as usize),
                    hit_or(hit, "LargeTickHit", "LargeTickMiss"),
                ),
                JudgementKind::SliderTail { hit, nested_index } => (
                    nested_index.map(|i| i as usize),
                    hit_or(hit, "SliderTailHit", "IgnoreMiss"),
                ),
                JudgementKind::SliderEnd { complete } => (None, hit_or(complete, "IgnoreHit", "IgnoreMiss")),
                JudgementKind::SliderAggregate(_) => panic!("the native walk never emits the stable aggregate"),
                JudgementKind::SpinnerSpin | JudgementKind::SpinnerBonus => {
                    let index = spinner_ticks.entry(event.object_index).or_insert(0);
                    let nested = *index;
                    *index += 1;
                    let name = if event.kind == JudgementKind::SpinnerSpin {
                        "SmallBonus"
                    } else {
                        "LargeBonus"
                    };
                    (Some(nested), (name, true))
                }
                JudgementKind::SpinnerFinal(grade) => (None, (grade_name(grade), grade != HitGrade::Miss)),
            };
            Element {
                object: event.object_index,
                nested,
                result,
                hit,
                combo_after: event.combo_after,
            }
        })
        .collect()
}

/// the dump's events, minus the unreached spinner ticks the walk records
/// in its counts rather than on the timeline
fn dump_elements(dump: &JudgementDump) -> Vec<Element> {
    dump.events
        .iter()
        .filter(|e| !((e.kind == "SpinnerTick" || e.kind == "SpinnerBonusTick") && !e.is_hit))
        .map(|e| Element {
            object: e.object_index,
            nested: e.nested_index,
            result: Box::leak(e.result.clone().into_boxed_str()),
            hit: e.is_hit,
            combo_after: e.combo_after,
        })
        .collect()
}

#[test]
fn every_native_scenario_judges_element_for_element_as_lazer_did() {
    let scenarios = native_scenarios();
    // fourteen: the family's nineteen less the four classic originals and
    // the classic half of the pinned-apart pair
    assert_eq!(scenarios.len(), 14, "the native family is committed in full");
    for dump in &scenarios {
        let timeline = simulate_scenario(dump);
        let expected = dump_elements(dump);
        let actual = engine_elements(&timeline);
        assert_eq!(actual, expected, "{}: the judgement sequence", dump.scenario);
    }
}

#[test]
fn every_native_scenarios_end_state_is_lazers() {
    for dump in &native_scenarios() {
        let scenario = &dump.scenario;
        let timeline = simulate_scenario(dump);
        let native = timeline.native.as_ref().expect("the native fold rides the timeline");
        let end = &dump.end_state;

        let statistics: BTreeMap<String, i64> = native
            .statistics
            .iter()
            .map(|(result, count)| (result.snake_name().to_owned(), i64::from(*count)))
            .collect();
        assert_eq!(statistics, end.statistics, "{scenario}: statistics");
        let maximum: BTreeMap<String, i64> = native
            .maximum_statistics
            .iter()
            .map(|(result, count)| (result.snake_name().to_owned(), i64::from(*count)))
            .collect();
        assert_eq!(maximum, end.maximum_statistics, "{scenario}: maximum statistics");

        // the statistics come in the enum order lazer writes a block's map
        // in (the dump's own map is in display order, a choice of the
        // harness; the real export in the corpus pins the enum order)
        let written: Vec<String> = native.statistics.iter().map(|(r, _)| r.snake_name().to_owned()).collect();
        let mut dumped_by_order: Vec<String> = end.statistics.keys().cloned().collect();
        dumped_by_order.sort_by_key(|name| HitResult::from_snake_name(name).map(|r| r.ordinal()));
        assert_eq!(written, dumped_by_order, "{scenario}: enum order");

        assert_eq!(timeline.totals.max_combo, end.max_combo, "{scenario}: max combo");
        assert_eq!(timeline.totals.accuracy, end.accuracy, "{scenario}: accuracy");
        assert_eq!(native.total_score, end.total_score, "{scenario}: total score");
        // the curve's LAST step is that same total. the spec pins it because
        // two surfaces lead with the curve instead of folding the score a
        // second time, so a step the fold moved without recording is a number
        // on screen that never catches up
        assert_eq!(
            native.score_curve.last().map(|step| step.score),
            Some(u64::try_from(native.total_score).unwrap_or(0)),
            "{scenario}: the score curve's last step is the derived total"
        );
        assert_eq!(
            timeline.totals.rank,
            ScoreRank::from_name(&end.rank).expect("a known rank"),
            "{scenario}: rank"
        );
    }
}

/// the pinned-apart pair: the stable walk over the classic dump and the
/// native walk over the native dump each match their own oracle on the
/// elements that differ between the profiles
#[test]
fn the_pinned_apart_frames_judge_differently_under_each_profile() {
    let native = load_judgement_dump("pinned-apart-native");
    let timeline = simulate_scenario(&native);
    let head = timeline
        .events
        .iter()
        .find_map(|e| match e.kind {
            JudgementKind::SliderHead { grade } => Some(grade),
            _ => None,
        })
        .expect("the slider head judges");
    assert_eq!(head, HitGrade::Ok, "a late head carries its grade under native");
    let tail = timeline
        .events
        .iter()
        .find_map(|e| match e.kind {
            JudgementKind::SliderTail { hit, .. } => Some((hit, e.combo_after)),
            _ => None,
        })
        .expect("the tail judges");
    assert_eq!(tail, (true, 3), "the native tail increments combo");
    assert!(
        !timeline.events.iter().any(|e| matches!(e.kind, JudgementKind::SliderAggregate(_))),
        "no stable aggregate under native"
    );
}
