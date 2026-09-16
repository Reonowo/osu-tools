mod fixture_util;

use engine::beatmap::process_beatmap;
use engine::configuration::{resolve_play_configuration, RulesProfile, SimulationSupport};
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::{
    decode_osr, OsrFile, OsrHeader, OsrTrailer, ReplayAction, LATEST_LAZER_VERSION, SEED_FRAME_DELTA,
};
use engine::formats::GameMode;
use engine::math::Vec2;
use engine::replay::document::ReplayDocument;
use engine::replay::frames::convert_frames;
use engine::score::{
    derive_native_export, maximum_achievable_combo, native_drain, native_health, replay_hash, CarriedIdentity,
    ScoreRank,
};
use engine::simulation::{simulate, simulate_native};
use fixture_util::{judgement_frames, load_judgement_dump};

/// the committed end-to-end case for the native profile: a synthetic
/// lazer-written file over the native baseline map is decoded, resolved,
/// simulated natively, frame-edited, exported, and decoded again -- and the
/// regenerated header and block must describe the re-simulation of the
/// exported frames exactly. no corpus, no personal data: the frames are the
/// scenario dump's own
#[test]
fn a_frame_edited_native_file_exports_a_header_and_block_that_describe_its_own_resimulation() {
    let dump = load_judgement_dump("native-baseline");
    let map_path = fixture_util::fixtures_dir()
        .join("judgement/maps")
        .join(&dump.beatmap_file);
    let map = decode_beatmap_path(&map_path).expect("the scenario map decodes");
    let processed = process_beatmap(&map).expect("processes");
    let frames = judgement_frames(&dump);

    // the synthetic lazer file: a lazer version with no block (the first
    // lazer version writes none), so the resolver falls back to the empty
    // bitfield and the native profile is authoritative
    let mut actions: Vec<ReplayAction> = Vec::new();
    let mut last = 0i64;
    for frame in &frames {
        let time = frame.time as i64;
        actions.push(ReplayAction {
            delta: time - last,
            x: frame.pos.x,
            y: frame.pos.y,
            z: frame.buttons.raw as i32,
        });
        last = time;
    }
    actions.push(ReplayAction {
        delta: SEED_FRAME_DELTA,
        x: 0.0,
        y: 0.0,
        z: 0,
    });
    let file = OsrFile {
        header: OsrHeader {
            mode: GameMode::Osu,
            version: 30000000,
            beatmap_md5: Some("aabbccddeeff00112233445566778899".into()),
            player_name: Some("someone".into()),
            replay_md5: None,
            count_300: 0,
            count_100: 0,
            count_50: 0,
            count_geki: 0,
            count_katsu: 0,
            count_miss: 0,
            total_score: 0,
            max_combo: 0,
            perfect: false,
            mods: 0,
            life_graph: None,
            timestamp_ticks: 638_712_000_000_000_000,
            online_score_id: 0,
        },
        actions,
        compressed_payload: Vec::new(),
        decompressed_payload: Vec::new(),
        trailer: OsrTrailer::absent(),
    };
    let configuration = resolve_play_configuration(&file, false);
    assert_eq!(configuration.profile, RulesProfile::Native);
    assert_eq!(
        configuration.capabilities.simulate,
        SimulationSupport::Authoritative {
            profile: RulesProfile::Native
        },
        "a lazer-native NoMod play is authoritative under the native profile"
    );
    assert!(configuration.capabilities.edit_frames.is_allowed() && configuration.capabilities.regenerate_export.is_allowed());

    // the document's own frames simulate as the dump did
    let mut document = ReplayDocument::new(file, map.format_version);
    let original = simulate(&processed, document.frames(), &configuration).expect("simulates");
    assert_eq!(original.totals.max_combo, dump.end_state.max_combo);

    // the edit: the third circle's press (meh at +120) moved off the circle,
    // so it times out instead
    let press = document
        .frames()
        .iter()
        .position(|f| f.time == 3120.0 && f.buttons.left())
        .expect("the dump presses the third circle at 3120");
    document.move_frame(press, Vec2::new(30.0, 30.0)).unwrap();
    let mut edited = simulate_native(&processed, document.frames()).expect("the edited play simulates");
    assert_eq!(edited.totals.count_miss, original.totals.count_miss + 1, "the moved press misses");

    // the export, under the health fold's rank
    let drain = native_drain(&processed, map.hp_drain_rate);
    let health = native_health(&processed, &edited, map.hp_drain_rate, drain);
    if health.fail_time.is_some() {
        edited.totals.rank = ScoreRank::F;
    }
    assert!(health.fail_time.is_none(), "one extra miss does not fail this map");
    let fields = derive_native_export(
        &edited,
        edited.totals.rank,
        None,
        &configuration.mods,
        &CarriedIdentity::from_source(None),
        "osu-replay-editor test",
    )
    .expect("narrows");
    let bytes = document.export_regenerated_native(&fields).expect("exports");

    // decoded again: the header projection, the version, the hash, the block
    let out = decode_osr(&bytes).expect("the export decodes");
    assert_eq!(out.header.version, LATEST_LAZER_VERSION);
    assert_eq!(
        out.header.replay_md5.as_deref(),
        Some(replay_hash("someone", out.header.timestamp_ticks).unwrap().as_str())
    );
    assert_eq!(out.header.life_graph.as_deref(), Some(""), "lazer writes an empty graph");
    let block = out.trailer.score_info().expect("a fresh block");
    assert_eq!(block.online_id, -1);
    assert_eq!(block.client_version, "osu-replay-editor test");
    assert_eq!(block.rank, Some(edited.totals.rank));

    // the self-consistency property: the exported frames re-simulate to
    // exactly what the header and block claim
    let re_frames = convert_frames(&out.actions, map.format_version);
    assert_eq!(re_frames, document.frames(), "the rebuilt action list is the edited frames");
    let re_configuration = resolve_play_configuration(&out, false);
    assert_eq!(re_configuration.profile, RulesProfile::Native);
    let fresh = simulate(&processed, &re_frames, &re_configuration).expect("re-simulates");
    let fresh_native = fresh.native.as_ref().expect("native outcome");
    assert_eq!(u32::from(out.header.count_300), fresh.totals.count_300);
    assert_eq!(u32::from(out.header.count_100), fresh.totals.count_100);
    assert_eq!(u32::from(out.header.count_50), fresh.totals.count_50);
    assert_eq!(u32::from(out.header.count_miss), fresh.totals.count_miss);
    assert_eq!((out.header.count_geki, out.header.count_katsu), (0, 0));
    assert_eq!(u32::from(out.header.max_combo), fresh.totals.max_combo);
    assert_eq!(i64::from(out.header.total_score), fresh_native.total_score);
    assert_eq!(
        out.header.perfect,
        fresh.totals.max_combo == maximum_achievable_combo(&fresh_native.maximum_statistics)
    );
    let named = |counts: &[(engine::score::HitResult, u32)]| -> Vec<(String, i64)> {
        counts
            .iter()
            .map(|(r, c)| (r.snake_name().to_owned(), i64::from(*c)))
            .collect()
    };
    let block_statistics: Vec<(String, i64)> = block.statistics.iter().map(|e| (e.result.clone(), e.count)).collect();
    assert_eq!(block_statistics, named(&fresh_native.statistics));
    let block_maximum: Vec<(String, i64)> = block
        .maximum_statistics
        .iter()
        .map(|e| (e.result.clone(), e.count))
        .collect();
    assert_eq!(block_maximum, named(&fresh_native.maximum_statistics));
    assert_eq!(block.total_score_without_mods, Some(fresh_native.total_score));

    // and a rename on the unedited file carries: same version, no block
    let pristine = decode_osr(&bytes).unwrap();
    let mut renamed = ReplayDocument::new(pristine, map.format_version);
    renamed.set_player_name(Some("renamed".into()));
    let carried = decode_osr(&renamed.export_with_derived(None).unwrap()).unwrap();
    assert_eq!(carried.header.version, LATEST_LAZER_VERSION);
    assert_eq!(carried.trailer.score_info(), Some(block), "a carried export keeps the block byte for byte");
}
