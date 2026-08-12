mod fixture_util;

use engine::formats::osr::{decode_osr, FIRST_LAZER_VERSION};
use engine::replay::document::ReplayDocument;

/// the lazer-export passthrough/strip contract, proven against a real lazer
/// file for the first time (engine parity pass, issue 10). newer
/// lazer-exported `.osr`s append a score-info trailer the engine
/// deliberately does not parse; the shipped contract is final-state
/// passthrough -- a pristine document re-emits unknown trailing bytes
/// verbatim, a dirty document strips the unparsed trailer.
///
/// corpus-style skip-if-absent: drop a lazer-exported `.osr` of your own
/// play at the gitignored path `fixtures/replays/local/lazer-export.osr`
/// (it carries your username; it stays out of git). an absent file skips
/// with a notice so ci never depends on personal data.
#[test]
fn a_real_lazer_export_passes_through_pristine_and_strips_dirty() {
    let path = fixture_util::fixtures_dir().join("replays/local/lazer-export.osr");
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!("lazer export contract: {path:?} missing, skipping (see this test's doc comment)");
        return;
    };

    // decode succeeds and identifies the file as lazer-native
    let file = decode_osr(&bytes).unwrap_or_else(|e| panic!("lazer export must decode: {e}"));
    assert!(
        file.header.version >= FIRST_LAZER_VERSION,
        "a lazer export stamps a lazer-native version (got {})",
        file.header.version
    );
    let format_version = 14;

    // pristine passthrough re-emits the file byte-identically, trailer included
    let doc = ReplayDocument::new(file, format_version);
    assert_eq!(
        doc.export_with_derived(None).expect("pristine export"),
        bytes,
        "pristine passthrough must be byte-identical, unknown trailer included"
    );

    // a metadata-dirtied export strips the trailer and reports it did: the
    // re-decoded trailer is the framed empty score-info array, not the blob
    let file = decode_osr(&bytes).unwrap();
    let had_trailer = !file.trailer.is_empty();
    let mut doc = ReplayDocument::new(file, format_version);
    doc.set_player_name(Some("contract test".into()));
    assert!(doc.metadata_dirty() && !doc.frames_dirty());
    let exported = doc.export_with_derived(None).expect("carried export");
    let re = decode_osr(&exported).expect("carried export re-decodes");
    if had_trailer {
        assert_eq!(
            re.trailer,
            0i32.to_le_bytes(),
            "the dirty export must strip the unparsed trailer down to the framed empty array"
        );
    } else {
        eprintln!("lazer export contract: note -- this export carried no trailer, so only passthrough was exercised");
    }

    eprintln!("lazer export contract: verified against {} bytes", bytes.len());
}
