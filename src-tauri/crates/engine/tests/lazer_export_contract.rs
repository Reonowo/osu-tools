mod fixture_util;

use engine::formats::osr::{decode_osr, OsrTrailer, ScoreInfoBlock, FIRST_LAZER_VERSION};
use engine::replay::document::ReplayDocument;
use engine::score::DerivedFields;

/// the lazer-export contract, proven against a real lazer file: a pristine
/// document re-emits the file byte for byte, a metadata edit carries the
/// score-info block byte for byte under the rewritten header
/// (docs/adr/0007), and a frame edit strips it down to the framed empty
/// array, since a block describing the source's play would lie about the
/// edited one.
///
/// corpus-style skip-if-absent: drop a lazer-exported `.osr` of your own
/// play at the gitignored path `fixtures/replays/local/lazer-export.osr`
/// (it carries your username; it stays out of git). an absent file skips
/// with a notice so ci never depends on personal data.
#[test]
fn a_real_lazer_export_passes_through_carries_on_rename_and_strips_on_frame_edit() {
    let path = fixture_util::fixtures_dir().join("replays/local/lazer-export.osr");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("lazer export contract: {path:?} missing, skipping (see this test's doc comment)");
        return;
    };

    // decode succeeds, identifies the file as lazer-native, and reads the
    // block: the native result names lazer writes are in its statistics
    let file = decode_osr(&bytes).unwrap_or_else(|e| panic!("lazer export must decode: {e}"));
    assert!(
        file.header.version >= FIRST_LAZER_VERSION,
        "a lazer export stamps a lazer-native version (got {})",
        file.header.version
    );
    let info = file
        .trailer
        .score_info()
        .unwrap_or_else(|| panic!("a current lazer export carries a readable block, got {:?}", file.trailer.block))
        .clone();
    let names: Vec<&str> = info.statistics.iter().map(|e| e.result.as_str()).collect();
    assert!(
        names.iter().any(|n| *n == "large_tick_hit" || *n == "slider_tail_hit"),
        "the statistics carry lazer's native result names, got {names:?}"
    );
    assert!(
        !info.maximum_statistics.is_empty(),
        "the maximum statistics are read"
    );
    let block_bytes = match &file.trailer.block {
        ScoreInfoBlock::Present { raw, .. } => raw.clone(),
        other => panic!("expected a present block, got {other:?}"),
    };
    let format_version = 14;

    // pristine passthrough re-emits the file byte-identically, block included
    let doc = ReplayDocument::new(file, format_version);
    assert_eq!(
        doc.export_with_derived(None).expect("pristine export"),
        bytes,
        "pristine passthrough must be byte-identical, block included"
    );

    // a metadata-dirtied export carries the block byte for byte under the
    // rewritten header
    let file = decode_osr(&bytes).unwrap();
    let mut doc = ReplayDocument::new(file, format_version);
    doc.set_player_name(Some("contract test".into()));
    assert!(doc.metadata_dirty() && !doc.frames_dirty());
    let exported = doc.export_with_derived(None).expect("carried export");
    let re = decode_osr(&exported).expect("carried export re-decodes");
    assert_eq!(re.header.player_name.as_deref(), Some("contract test"));
    match &re.trailer.block {
        ScoreInfoBlock::Present { raw, value } => {
            assert_eq!(raw, &block_bytes, "the carried block is the source's own bytes");
            assert_eq!(value, &info);
        }
        other => panic!("a rename must carry the block, got {other:?}"),
    }
    assert!(re.trailer.trailing.is_empty());

    // a frame-dirtied export strips it down to the framed empty array (the
    // stable profile's regenerating path; the native one is its own ticket)
    let file = decode_osr(&bytes).unwrap();
    let mut doc = ReplayDocument::new(file, format_version);
    let moved = doc.frames()[0].pos + engine::math::Vec2::new(1.0, 1.0);
    doc.move_frame(0, moved).unwrap();
    let derived = DerivedFields {
        count_300: 1,
        count_100: 0,
        count_50: 0,
        count_geki: 0,
        count_katsu: 0,
        count_miss: 0,
        max_combo: 1,
        perfect: true,
        total_score: 300,
        life_bar: String::new(),
        life_bar_converged: true,
    };
    let exported = doc.export_with_derived(Some(&derived)).expect("regenerating export");
    let re = decode_osr(&exported).expect("regenerating export re-decodes");
    assert_eq!(re.trailer, OsrTrailer::empty_block());

    eprintln!("lazer export contract: verified against {} bytes", bytes.len());
}
