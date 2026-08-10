//! shared test helpers for the app crate

use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::TimeZone;
use osu_db::listing::{Beatmap as DbBeatmap, Grade, Listing, RankedStatus};
use osu_db::Mode;

pub fn write_osz(path: &Path, entries: &[(&str, &[u8])]) {
    let file = std::fs::File::create(path).unwrap();
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default();
    for (name, bytes) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

pub fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("fixtures")
}

pub fn test_header(beatmap_md5: &str, mods: u32) -> engine::formats::osr::OsrHeader {
    engine::formats::osr::OsrHeader {
        mode: engine::formats::GameMode::Osu,
        version: 20151228,
        beatmap_md5: Some(beatmap_md5.to_string()),
        player_name: Some("test".into()),
        replay_md5: None,
        count_300: 1,
        count_100: 0,
        count_50: 0,
        count_geki: 0,
        count_katsu: 0,
        count_miss: 0,
        total_score: 300,
        max_combo: 1,
        perfect: true,
        mods,
        life_graph: None,
        timestamp_ticks: 0,
        online_score_id: 0,
    }
}

/// encodes a minimal valid .osr via the engine's own encoder; actions default
/// to a tiny cursor trace when None
pub fn osr_bytes(
    beatmap_md5: &str,
    mods: u32,
    actions: Option<Vec<engine::formats::osr::ReplayAction>>,
) -> Vec<u8> {
    osr_bytes_versioned(beatmap_md5, mods, actions, 20151228)
}

/// osr_bytes with an explicit header version -- the lazer-native gating
/// tests need version >= formats::osr::FIRST_LAZER_VERSION
pub fn osr_bytes_versioned(
    beatmap_md5: &str,
    mods: u32,
    actions: Option<Vec<engine::formats::osr::ReplayAction>>,
    version: u32,
) -> Vec<u8> {
    use engine::formats::osr::{encode_osr, EncodeOptions, OsrFile, PayloadSource, ReplayAction};
    let actions = actions.unwrap_or_else(|| {
        vec![
            ReplayAction {
                delta: 0,
                x: 256.0,
                y: 192.0,
                z: 0,
            },
            ReplayAction {
                delta: 1000,
                x: 256.0,
                y: 192.0,
                z: 1,
            },
            ReplayAction {
                delta: 16,
                x: 256.0,
                y: 192.0,
                z: 0,
            },
        ]
    });
    let mut header = test_header(beatmap_md5, mods);
    header.version = version;
    let file = OsrFile {
        header,
        actions,
        compressed_payload: Vec::new(),
        decompressed_payload: Vec::new(),
        trailer: Vec::new(),
    };
    encode_osr(
        &file,
        &EncodeOptions {
            payload: PayloadSource::Reserialize,
            include_trailer: false,
        },
    )
    .unwrap()
}

pub fn db_entry(hash: &str, folder: &str, file: &str) -> DbBeatmap {
    let epoch = chrono::Utc.timestamp_opt(0, 0).unwrap();
    DbBeatmap {
        artist_ascii: Some("fixture".into()),
        artist_unicode: None,
        title_ascii: Some("fixture".into()),
        title_unicode: None,
        creator: Some("fixture".into()),
        difficulty_name: Some("test".into()),
        audio: Some("audio.mp3".into()),
        hash: Some(hash.to_string()),
        file_name: Some(file.to_string()),
        status: RankedStatus::Ranked,
        hitcircle_count: 0,
        slider_count: 0,
        spinner_count: 0,
        last_modified: epoch,
        approach_rate: 9.0,
        circle_size: 4.0,
        hp_drain: 5.0,
        overall_difficulty: 8.3,
        slider_velocity: 1.4,
        std_ratings: Vec::new(),
        taiko_ratings: Vec::new(),
        ctb_ratings: Vec::new(),
        mania_ratings: Vec::new(),
        drain_time: 0,
        total_time: 0,
        preview_time: 0,
        timing_points: Vec::new(),
        beatmap_id: 1,
        beatmapset_id: 1,
        thread_id: 0,
        std_grade: Grade::Unplayed,
        taiko_grade: Grade::Unplayed,
        ctb_grade: Grade::Unplayed,
        mania_grade: Grade::Unplayed,
        local_beatmap_offset: 0,
        stack_leniency: 0.7,
        mode: Mode::Standard,
        song_source: None,
        tags: None,
        online_offset: 0,
        title_font: None,
        last_played: None,
        is_osz2: false,
        folder_name: Some(folder.to_string()),
        last_online_check: epoch,
        ignore_sounds: false,
        ignore_skin: false,
        disable_storyboard: false,
        disable_video: false,
        visual_override: false,
        mysterious_short: None,
        mysterious_last_modified: 0,
        mania_scroll_speed: 0,
    }
}

/// builds <root>/osu!.db plus <root>/songs/<folder>/<file> holding
/// `bytes`; returns the md5 the db records for it
pub fn fake_install(root: &std::path::Path, folder: &str, file: &str, bytes: &[u8]) -> String {
    let md5 = format!("{:x}", md5::compute(bytes));
    let map_dir = root.join("Songs").join(folder);
    std::fs::create_dir_all(&map_dir).unwrap();
    std::fs::write(map_dir.join(file), bytes).unwrap();
    let listing = Listing {
        version: 20191106,
        folder_count: 1,
        unban_date: None,
        player_name: Some("test".into()),
        beatmaps: vec![db_entry(&md5, folder, file)],
        user_permissions: 0,
    };
    listing.save(root.join("osu!.db")).unwrap();
    md5
}
