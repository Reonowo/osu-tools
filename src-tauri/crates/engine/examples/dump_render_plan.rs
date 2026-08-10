//! dumps build_render_plan output for every fixtures/beatmaps/*.osu into
//! fixtures/render_plan/*.json. these dumps are RUST-generated (not lazer
//! goldens): they are the production-shaped geometry the frontend receives
//! over ipc, and the frontend's progress->position parity test evaluates
//! them against lazer's ball_samples in fixtures/beatmap/*.json. regenerate
//! whenever render_plan's serialization or the fixture beatmaps change:
//!
//!   cargo run -p engine --example dump_render_plan

use std::path::PathBuf;

fn main() {
    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures");
    let out_dir = fixtures.join("render_plan");
    std::fs::create_dir_all(&out_dir).expect("create render_plan dir");

    let mut paths: Vec<PathBuf> = std::fs::read_dir(fixtures.join("beatmaps"))
        .expect("read fixtures/beatmaps")
        .map(|entry| entry.expect("dir entry").path())
        .filter(|path| path.extension().and_then(|e| e.to_str()) == Some("osu"))
        .collect();
    paths.sort();
    assert!(
        !paths.is_empty(),
        "no fixture beatmaps found at {}",
        fixtures.display()
    );

    for path in paths {
        let bytes = std::fs::read(&path).expect("read .osu");
        let map = engine::formats::beatmap::decode_beatmap_bytes(&bytes).expect("decode");
        let processed = engine::beatmap::process_beatmap(&map).expect("process");
        let plan = engine::render_plan::build_render_plan(&map, &processed);
        let json = serde_json::to_string_pretty(&plan).expect("serialize");
        let stem = path.file_stem().unwrap().to_string_lossy();
        let out = out_dir.join(format!("{stem}.json"));
        std::fs::write(&out, json).expect("write dump");
        println!("wrote render_plan/{stem}.json ({} objects)", plan.objects.len());
    }
}
