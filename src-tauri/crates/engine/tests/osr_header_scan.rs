//! the header-only `.osr` entry point pinned against the full decoder.
//!
//! `formats::osr::scan_osr_header` exists so the replay browser can list a
//! folder of thousands without decompressing a frame, which makes it a
//! SECOND reader of the same bytes -- and two readers of one format drift.
//! this file is what stops them: every committed `.osr` fixture and every
//! replay in the personal corpus is read both ways, and the two must agree
//! field for field on everything the scan claims to answer.

mod fixture_util;

use engine::formats::osr::{decode_osr, scan_osr_header, OsrHeaderScan};

/// the committed replays, which is what CI has; the corpus below is the
/// per-machine other half
fn committed_replays() -> Vec<(String, Vec<u8>)> {
    let dir = fixture_util::fixtures_dir().join("replays");
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).expect("fixtures/replays") {
        let path = entry.expect("dir entry").path();
        if path.extension().is_some_and(|e| e == "osr") {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            out.push((name, std::fs::read(&path).expect("read fixture")));
        }
    }
    assert!(!out.is_empty(), "no committed .osr fixtures found");
    out
}

/// the gitignored personal corpus, skipped when absent exactly as the
/// simulation corpus test skips it
fn corpus_replays() -> Vec<(String, Vec<u8>)> {
    let dir = fixture_util::fixtures_dir().join("replays/local");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("corpus: {dir:?} missing, skipping");
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries {
        let path = entry.expect("dir entry").path();
        if path.extension().is_some_and(|e| e == "osr") {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            out.push((name, std::fs::read(&path).expect("read corpus replay")));
        }
    }
    out
}

fn all_replays() -> Vec<(String, Vec<u8>)> {
    let mut all = committed_replays();
    all.extend(corpus_replays());
    all
}

/// the whole reason this entry point may exist: on every real replay it
/// answers what the full decoder answers, and consumes exactly the header
#[test]
fn the_header_scan_matches_the_full_decoder_on_every_real_replay() {
    let replays = all_replays();
    for (name, bytes) in &replays {
        let full = decode_osr(bytes).unwrap_or_else(|e| panic!("{name}: {e}"));
        let OsrHeaderScan::Complete { header, consumed } =
            scan_osr_header(bytes).unwrap_or_else(|e| panic!("{name}: {e}"))
        else {
            panic!("{name}: a whole file read as incomplete");
        };
        // the online score id is the one field the scan cannot reach -- it
        // sits past the frame payload (the entry point's doc says why), so
        // it is compared out rather than asserted equal
        let expected = engine::formats::osr::OsrHeader {
            online_score_id: 0,
            ..full.header.clone()
        };
        assert_eq!(header, expected, "{name}");

        // "exactly the header's bytes": one less and the payload's length
        // prefix is unread, one more and a frame byte has been touched
        assert!(consumed < bytes.len(), "{name}: the scan ran past the file");
        let declared = i32::from_le_bytes(bytes[consumed - 4..consumed].try_into().unwrap());
        if declared > 0 {
            assert_eq!(
                &bytes[consumed..consumed + declared as usize],
                full.compressed_payload.as_slice(),
                "{name}: `consumed` does not name the payload's own offset"
            );
        }
    }
    eprintln!("header scan: {} replays agree with the full decoder", replays.len());
}

/// the distinction the entry point exists to draw. every prefix of a real
/// header is "hand me more bytes", never "this file is corrupt" -- a chunked
/// reader that could not tell them apart would either give up on a replay it
/// had only half read, or grow its buffer over a file that is not a replay
#[test]
fn every_prefix_of_a_real_header_reports_incomplete_rather_than_corrupt() {
    for (name, bytes) in all_replays() {
        let OsrHeaderScan::Complete { consumed, .. } = scan_osr_header(&bytes).unwrap() else {
            panic!("{name}: a whole file read as incomplete");
        };
        for cut in 1..consumed {
            match scan_osr_header(&bytes[..cut]) {
                Ok(OsrHeaderScan::Incomplete) => {}
                other => panic!("{name}: prefix of {cut} bytes gave {other:?}"),
            }
        }
        // the empty buffer too, which is what a zero-byte file in the
        // Replays folder hands the scan
        assert_eq!(scan_osr_header(&[]).unwrap(), OsrHeaderScan::Incomplete);
    }
}

/// a malformed header is corrupt at ANY length: the incomplete answer must
/// not swallow a file that will never decode however many bytes arrive
#[test]
fn a_malformed_header_is_an_error_even_on_a_short_buffer() {
    let (_, bytes) = committed_replays().into_iter().next().unwrap();

    // the mode byte, which no amount of further reading can fix
    let mut broken = bytes.clone();
    broken[0] = 9;
    assert!(scan_osr_header(&broken).is_err());
    assert!(scan_osr_header(&broken[..1]).is_err(), "one byte is enough to know");

    // the beatmap md5's string tag: past the mode byte and the version int
    let mut broken = bytes.clone();
    assert_eq!(broken[5], 0x0b, "fixture layout moved");
    broken[5] = 0x0c;
    assert!(scan_osr_header(&broken).is_err());
    assert!(scan_osr_header(&broken[..6]).is_err());
}
