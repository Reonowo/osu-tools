//! golden tests for the score dump family: every expected value here was
//! computed by lazer's own code via tools/fixture-gen (see fixtures/README.md)

mod fixture_util;

use fixture_util::LegacyScoreAttributesDump;

use engine::beatmap::{process_beatmap, NestedKind, ProcessedBeatmap, ProcessedKind};
use engine::formats::beatmap::decode_beatmap_path;
use engine::score::{max_achievable_combo, peppy_stars, total_score, ScoreContext, NOMOD_SCORE_MULTIPLIER};
use engine::simulation::score::JudgementKind;
use engine::simulation::{HitTotals, JudgementEvent, JudgementTimeline};
use serde::Deserialize;

#[derive(Deserialize)]
struct PeppyDump {
    triples: Vec<TripleDump>,
    maps: Vec<MapDump>,
}

#[derive(Deserialize)]
struct TripleDump {
    hp: f32,
    od: f32,
    cs: f32,
    object_count: i32,
    drain_length: i32,
    peppy_stars: i32,
}

#[derive(Deserialize)]
struct MapDump {
    name: String,
    hp: f32,
    od: f32,
    cs: f32,
    object_count: i32,
    drain_length: i32,
    peppy_stars: i32,
}

#[test]
fn peppy_stars_match_the_lazer_dumped_triples() {
    let dump: PeppyDump = fixture_util::load_json("score/peppy_stars.json");
    assert!(!dump.triples.is_empty());

    for case in &dump.triples {
        let ctx = ScoreContext {
            hp_drain_rate: case.hp,
            overall_difficulty: case.od,
            circle_size: case.cs,
            object_count: case.object_count,
            drain_length_seconds: case.drain_length,
        };
        assert_eq!(
            peppy_stars(&ctx).unwrap(),
            case.peppy_stars,
            "triple (hp {}, od {}, cs {}, objects {}, drain {})",
            case.hp,
            case.od,
            case.cs,
            case.object_count,
            case.drain_length,
        );
    }
}

fn processed_fixture(name: &str) -> ProcessedBeatmap {
    let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{name}.osu")))
        .unwrap_or_else(|e| panic!("{name}: decode failed: {e}"));
    process_beatmap(&map).unwrap_or_else(|e| panic!("{name}: process failed: {e}"))
}

/// a synthetic full-combo timeline in the exact element order lazer's
/// simulator walks: objects in sequence, slider parts inline before their
/// aggregate. spinner maps never reach this helper
fn full_combo_timeline(processed: &ProcessedBeatmap) -> JudgementTimeline {
    use engine::beatmap::difficulty::HitGrade;

    let mut events = Vec::new();
    let mut push = |object_index: usize, time: f64, kind: JudgementKind| {
        events.push(JudgementEvent {
            time,
            object_index,
            kind,
            combo_after: 0,
            accuracy_after: 1.0,
        });
    };

    for (index, object) in processed.objects.iter().enumerate() {
        match &object.kind {
            ProcessedKind::Circle => push(index, object.start_time, JudgementKind::Circle(HitGrade::Great)),
            ProcessedKind::Slider(slider) => {
                for nested in &slider.nested {
                    let kind = match nested.kind {
                        NestedKind::Head => JudgementKind::SliderHead { hit: true },
                        NestedKind::Tick => JudgementKind::SliderTick { hit: true },
                        NestedKind::Repeat => JudgementKind::SliderRepeat { hit: true },
                        NestedKind::Tail => JudgementKind::SliderTail { hit: true },
                    };
                    push(index, nested.time, kind);
                }
                push(index, object.end_time, JudgementKind::SliderAggregate(HitGrade::Great));
            }
            ProcessedKind::Spinner(_) => {
                panic!("full_combo_timeline is for spinner-free maps only")
            }
        }
    }

    JudgementTimeline {
        events,
        totals: HitTotals::default(),
    }
}

#[derive(Deserialize)]
struct HashDump {
    cases: Vec<HashCase>,
}

#[derive(Deserialize)]
struct HashCase {
    username: String,
    ticks: i64,
    date_string: String,
    hash: String,
}

#[test]
fn replay_hashes_match_the_lazer_dumped_goldens() {
    let dump: HashDump = fixture_util::load_json("score/replay_hash.json");
    assert!(!dump.cases.is_empty());

    for case in &dump.cases {
        // the date leg pins .net's invariant formatting separately from the
        // md5, so a mismatch localises to formatting or hashing
        assert_eq!(
            engine::score::invariant_date_string(case.ticks).unwrap(),
            case.date_string,
            "{} @ {}: date string",
            case.username,
            case.ticks
        );
        assert_eq!(
            engine::score::replay_hash(&case.username, case.ticks).unwrap(),
            case.hash,
            "{} @ {}: hash",
            case.username,
            case.ticks
        );
    }
}

#[test]
fn achievable_combo_matches_the_lazer_simulators_own_counter() {
    // LegacyScoreAttributes.MaxCombo is osulegacyscoresimulator.cs's `combo`
    // field after walking every combo-increasing element -- the exact
    // quantity max_achievable_combo counts
    let dump: LegacyScoreAttributesDump = fixture_util::load_json("score/legacy_score_attributes.json");
    assert!(!dump.maps.is_empty());

    for case in &dump.maps {
        let processed = processed_fixture(&case.name);
        assert_eq!(
            max_achievable_combo(&processed),
            case.max_combo,
            "{}: achievable combo",
            case.name
        );
    }
}

#[test]
fn synthetic_full_combo_totals_match_the_lazer_dumped_attributes() {
    // on a spinner-free map the achieved full-combo score IS the theoretical
    // maximum: accuracy + combo portions, no bonus. spinner maps differ by
    // construction (the simulator assumes the bonus-maximising spin count),
    // so they are excluded rather than approximated
    let dump: LegacyScoreAttributesDump = fixture_util::load_json("score/legacy_score_attributes.json");
    let mut covered = 0;

    for case in &dump.maps {
        let processed = processed_fixture(&case.name);
        if processed
            .objects
            .iter()
            .any(|o| matches!(o.kind, ProcessedKind::Spinner(_)))
        {
            continue;
        }
        assert_eq!(case.bonus_score, 0, "{}: spinner-free maps earn no bonus", case.name);

        let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{}.osu", case.name)))
            .unwrap();
        let stars = peppy_stars(&ScoreContext::from_beatmap(&map)).unwrap();
        let timeline = full_combo_timeline(&processed);

        assert_eq!(
            total_score(&timeline, stars, NOMOD_SCORE_MULTIPLIER),
            case.accuracy_score + case.combo_score,
            "{}: full-combo total",
            case.name
        );
        covered += 1;
    }

    assert!(covered >= 3, "expected several spinner-free fixture maps, got {covered}");
}

#[test]
fn score_contexts_and_peppy_stars_match_the_lazer_dumped_maps() {
    let dump: PeppyDump = fixture_util::load_json("score/peppy_stars.json");
    assert!(!dump.maps.is_empty());

    for case in &dump.maps {
        let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{}.osu", case.name)))
            .unwrap_or_else(|e| panic!("{}: decode failed: {e}", case.name));
        let ctx = ScoreContext::from_beatmap(&map);

        // the context legs pin issue-level pieces separately so a drain or
        // difficulty mismatch localises apart from the decimal arithmetic
        assert_eq!(ctx.hp_drain_rate, case.hp, "{}: hp", case.name);
        assert_eq!(ctx.overall_difficulty, case.od, "{}: od", case.name);
        assert_eq!(ctx.circle_size, case.cs, "{}: cs", case.name);
        assert_eq!(ctx.object_count, case.object_count, "{}: object count", case.name);
        assert_eq!(ctx.drain_length_seconds, case.drain_length, "{}: drain length", case.name);

        assert_eq!(
            peppy_stars(&ctx).unwrap(),
            case.peppy_stars,
            "{}: peppy stars",
            case.name
        );
    }
}
