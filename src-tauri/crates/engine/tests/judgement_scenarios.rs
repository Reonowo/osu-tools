mod fixture_util;

use engine::beatmap::difficulty::HitGrade;
use engine::beatmap::process_beatmap;
use engine::formats::beatmap::decode_beatmap_path;
use engine::simulation::score::JudgementKind;
use engine::simulation::simulate;
use fixture_util::{judgement_frames, load_judgement_dump, JudgementDump};

// per-mechanism parity against the judgement-dump scenario fixtures: lazer
// itself judged these hand-built replays (fixtures/judgement/), so each
// comparison here is engine-vs-lazer at the mechanism level, beneath what
// count-level parity can see. comparisons follow the dump's own rules
// (fixtures/README.md): result kinds, hit flags, application order, and
// running combo, compared around the documented tail-combo divergence

fn simulate_scenario(dump: &JudgementDump) -> engine::simulation::JudgementTimeline {
    let map_path = fixture_util::fixtures_dir()
        .join("judgement/maps")
        .join(&dump.beatmap_file);
    let map = decode_beatmap_path(&map_path).expect("scenario map decodes");
    let processed = process_beatmap(&map).expect("scenario map processes");
    simulate(&processed, &judgement_frames(dump)).expect("scenario simulates")
}

fn grade_name(grade: HitGrade) -> &'static str {
    match grade {
        HitGrade::Great => "Great",
        HitGrade::Ok => "Ok",
        HitGrade::Meh => "Meh",
        HitGrade::Miss => "Miss",
    }
}

/// spinner accumulation follows lazer's gameplay ticks: per spinner, the
/// engine's SpinnerSpin/SpinnerBonus event counts must equal the dump's
/// hit SpinnerTick/SpinnerBonusTick counts, and the finals must grade
/// identically (issue 03's mechanism baseline; the *scoring* of those spins
/// follows stable, oracled separately)
#[test]
fn spinner_accumulation_matches_the_lazer_dump() {
    let dump = load_judgement_dump("spinner-accumulation");
    let timeline = simulate_scenario(&dump);

    // spinner object indices in the scenario map
    for object_index in [0usize, 1] {
        let engine_spins = timeline
            .events
            .iter()
            .filter(|e| e.object_index == object_index && e.kind == JudgementKind::SpinnerSpin)
            .count();
        let engine_bonuses = timeline
            .events
            .iter()
            .filter(|e| e.object_index == object_index && e.kind == JudgementKind::SpinnerBonus)
            .count();
        let dump_spins = dump
            .events
            .iter()
            .filter(|e| e.object_index == object_index && e.kind == "SpinnerTick" && e.is_hit)
            .count();
        let dump_bonuses = dump
            .events
            .iter()
            .filter(|e| e.object_index == object_index && e.kind == "SpinnerBonusTick" && e.is_hit)
            .count();
        assert_eq!(
            (engine_spins, engine_bonuses),
            (dump_spins, dump_bonuses),
            "spinner {object_index}: spin/bonus tick counts must match lazer's"
        );

        let engine_final = timeline
            .events
            .iter()
            .find_map(|e| match e.kind {
                JudgementKind::SpinnerFinal(grade) if e.object_index == object_index => Some(grade),
                _ => None,
            })
            .expect("spinner final present");
        let dump_final = dump
            .events
            .iter()
            .find(|e| e.object_index == object_index && e.kind == "Spinner")
            .expect("dump spinner final present");
        assert_eq!(
            grade_name(engine_final),
            dump_final.result,
            "spinner {object_index}: final grade must match lazer's"
        );
    }
}

/// slider tracking through leave-and-return follows lazer's
/// SliderInputManager: per nested element the engine's hit/miss must match
/// the dump -- tick 2 dropped while the cursor was away, the tail
/// recovered on slider 1; the tick held and the tail dropped on slider 2
/// (issue 05's mechanism baseline)
#[test]
fn slider_tracking_matches_the_lazer_dump() {
    let dump = load_judgement_dump("slider-tracking");
    let timeline = simulate_scenario(&dump);

    // per object: (head hit, tick hits in order, tail hit, aggregate grade)
    for object_index in [0usize, 1] {
        let engine_parts: Vec<(&'static str, bool)> = timeline
            .events
            .iter()
            .filter(|e| e.object_index == object_index)
            .filter_map(|e| match e.kind {
                JudgementKind::SliderHead { hit } => Some(("head", hit)),
                JudgementKind::SliderTick { hit } => Some(("tick", hit)),
                JudgementKind::SliderRepeat { hit } => Some(("repeat", hit)),
                JudgementKind::SliderTail { hit } => Some(("tail", hit)),
                _ => None,
            })
            .collect();
        let dump_parts: Vec<(&str, bool)> = dump
            .events
            .iter()
            .filter(|e| e.object_index == object_index)
            .filter_map(|e| match e.kind.as_str() {
                "SliderHeadCircle" => Some(("head", e.is_hit)),
                "SliderTick" => Some(("tick", e.is_hit)),
                "SliderRepeat" => Some(("repeat", e.is_hit)),
                "SliderTailCircle" => Some(("tail", e.is_hit)),
                _ => None,
            })
            .collect();
        assert_eq!(
            engine_parts, dump_parts,
            "slider {object_index}: nested element outcomes must match lazer's, in order"
        );

        let engine_aggregate = timeline
            .events
            .iter()
            .find_map(|e| match e.kind {
                JudgementKind::SliderAggregate(grade) if e.object_index == object_index => Some(grade),
                _ => None,
            })
            .expect("aggregate present");
        let dump_aggregate = dump
            .events
            .iter()
            .find(|e| e.object_index == object_index && e.kind == "Slider")
            .expect("dump aggregate present");
        assert_eq!(
            grade_name(engine_aggregate),
            dump_aggregate.result,
            "slider {object_index}: aggregate grade must match lazer's"
        );
    }
}

/// the dense-stack note-lock scenario (issue 06's oracle) -- where the
/// stable machine DIVERGES from the lazer dump, deliberately (ratified
/// 2026-08-12, `.scratch/engine-parity-pass/issues/06`): lazer's
/// `LegacyHitPolicy` consults only the immediate alive-list predecessor,
/// and the judged-but-fading spinner occupying that slot lets the shielded
/// press through (the dump records object 2 `Great`). stable's hit policy
/// (danser `CanBeHitStable`, the community-validated stable model this
/// engine ports) walks EVERY earlier unhit processed object, finds the
/// older unjudged stacked circle, and locks the press -- object 2 times
/// out `Miss`. no real play exercises the pattern (the corpus-wishlist
/// dense-stack row exists to find one), so stable headers cannot arbitrate;
/// until one does, this pins the stable machine's answer against the dump's
/// recorded lazer answer so any drift in either direction is loud
#[test]
fn notelock_stack_pins_the_stable_divergence_from_the_lazer_dump() {
    let dump = load_judgement_dump("notelock-stack");
    let timeline = simulate_scenario(&dump);

    let engine_basics: Vec<(usize, &'static str)> = timeline
        .events
        .iter()
        .filter_map(|e| match e.kind {
            JudgementKind::Circle(grade) | JudgementKind::SpinnerFinal(grade) => {
                Some((e.object_index, grade_name(grade)))
            }
            JudgementKind::SliderAggregate(grade) => Some((e.object_index, grade_name(grade))),
            _ => None,
        })
        .collect();
    let dump_basics: Vec<(usize, &str)> = dump
        .events
        .iter()
        .filter(|e| matches!(e.kind.as_str(), "HitCircle" | "Spinner" | "Slider"))
        .map(|e| (e.object_index, e.result.as_str()))
        .collect();

    // the dump's recorded lazer answer: the shielded press lands
    assert_eq!(
        dump_basics,
        vec![(1, "Great"), (2, "Great"), (0, "Miss"), (3, "Miss")],
        "the fixture still records lazer allowing the shielded hit"
    );
    // the stable machine's answer: the older unjudged stacked object locks
    // the press and object 2 times out
    assert_eq!(
        engine_basics,
        vec![(1, "Great"), (0, "Miss"), (2, "Miss"), (3, "Miss")],
        "the stable hit policy locks the press lazer would allow"
    );
}

/// the baseline scenario end to end: circle grades and the slider aggregate
/// must match the dump exactly (the harness canary, engine side)
#[test]
fn baseline_scenario_matches_the_lazer_dump() {
    let dump = load_judgement_dump("baseline");
    let timeline = simulate_scenario(&dump);

    let engine_circles: Vec<&'static str> = timeline
        .events
        .iter()
        .filter_map(|e| match e.kind {
            JudgementKind::Circle(grade) => Some(grade_name(grade)),
            _ => None,
        })
        .collect();
    let dump_circles: Vec<&str> = dump
        .events
        .iter()
        .filter(|e| e.kind == "HitCircle")
        .map(|e| e.result.as_str())
        .collect();
    assert_eq!(engine_circles, dump_circles, "circle grades match lazer's");

    let engine_aggregate = timeline
        .events
        .iter()
        .find_map(|e| match e.kind {
            JudgementKind::SliderAggregate(grade) => Some(grade),
            _ => None,
        })
        .expect("slider aggregate present");
    assert_eq!(engine_aggregate, HitGrade::Great, "fully tracked slider aggregates great");
}
