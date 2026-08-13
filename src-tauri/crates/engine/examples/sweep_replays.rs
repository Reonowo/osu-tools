//! sweep_replays: measures the engine's parity rate across a whole local
//! osu! stable play library on demand -- the committed instrument behind the
//! engine parity pass. a sweep is measurement, never curation: it applies
//! exactly the corpus admission filters (complete, NoMod, stable-set,
//! stable-written -- see `.scratch/export-integrity/corpus-checklist.md` and
//! `fixtures/README.md`), simulates every admitted play, and reports how the
//! engine's simulated and derived values compare against each `.osr`
//! header's own numbers (the scoring oracle,
//! `docs/adr/0001-stable-headers-are-the-scoring-oracle.md`).
//!
//! usage (from `src-tauri/`; release is the profile every quoted verdict
//! comes from):
//!
//!   cargo run -p engine --release --example sweep_replays -- <stable-dir>
//!   OSU_STABLE_DIR=E:\osu! cargo run -p engine --release --example sweep_replays
//!   ... sweep_replays -- <stable-dir> --manifest <path>
//!
//! the stable install location comes from the first positional argument or
//! the `OSU_STABLE_DIR` environment variable; no personal path is committed
//! anywhere. candidates are enumerated from the client's own `Data/r` and
//! `Replays` directories and matched to their exact difficulty through the
//! install's `osu!.db` md5 listing (re-hashed on disk, so a stale listing
//! rejects rather than mis-matching).
//!
//! this is an example, never a test: ci never sees it, and a red sweep exits
//! 0 -- the numbers themselves are the output.
//!
//! # admission filters, in application order
//!
//! each candidate is rejected by the first filter it fails, and the per-filter
//! rejection counts are printed so the population is auditable:
//!
//! 1. `duplicate` -- same `replay_md5` already seen (Data/r and Replays both
//!    hold client-written files and can overlap)
//! 2. `undecodable` -- `.osr` decode failed
//! 3. `non_std` -- header mode is not osu!standard
//! 4. `modded` -- header mods bitfield is nonzero (NoMod only)
//! 5. `lazer_written` -- header version >= 30000000 (lazer-stamped, not
//!    stable-set)
//! 6. `zeroed_geki_katu` -- both geki and katu are zero: the corpus-checklist
//!    heuristic for a file stable did not write itself (leaderboard downloads
//!    and lazer exports zero these fields; the rare legitimate all-miss-
//!    sections play is knowingly rejected with them)
//! 7. `unmatched_beatmap` -- no `osu!.db` entry with the header's beatmap
//!    md5, or the listed file is missing or hashes differently on disk
//! 8. `unprocessable` -- the matched `.osu` failed to decode or process
//! 9. `incomplete` -- the judged-count identity fails: `300 + 100 + 50 +
//!    miss != hit-object count`, i.e. the play ended early
//! 10. `simulation_error` -- `simulate` returned a typed error (counted, not
//!     a crash; the no-panic guarantee holds either way)
//!
//! # manifest schema
//!
//! the failure manifest is json, written to `--manifest <path>` or the
//! default `fixtures/replays/local/sweep_manifest.json` (a gitignored path;
//! the corpus test ignores non-`.osr` files there). shape:
//!
//! ```json
//! {
//!   "stable_dir": "E:\\osu!",
//!   "population": {
//!     "candidates": 4382,
//!     "rejected": { "<filter name>": 123, ... },
//!     "admitted": 1059
//!   },
//!   "failures": [
//!     {
//!       "stem": "player - artist - title [diff] (date) osu",
//!       "replay_path": "E:\\osu!\\Replays\\....osr",
//!       "beatmap_path": "E:\\osu!\\Songs\\...\\....osu",
//!       "header_misses": 3,
//!       "has_spinners": true,
//!       "fields": {
//!         "<field>": { "header": 123, "simulated": 456 }, ...
//!       }
//!     }, ...
//!   ]
//! }
//! ```
//!
//! `fields` holds only the diverging fields, out of: `count_300`,
//! `count_100`, `count_50`, `count_miss`, `max_combo`, `count_geki`,
//! `count_katsu`, `total_score`. `header_misses` and `has_spinners` are the
//! two triage axes the 2026-08-12 baseline bucketed by;
//! `header_count_100`/`header_count_50`/`header_max_combo`/
//! `max_achievable_combo` carry the corpus-admission context issue 11's
//! wishlist rows key on (dropped-element and dropped-tail-forfeits-perfect
//! signatures need the header's own counts against the map's ceiling).

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use engine::beatmap::{process_beatmap, ProcessedKind};
use engine::formats::beatmap::decode_beatmap_bytes;
use engine::formats::osr::{decode_osr, FIRST_LAZER_VERSION};
use engine::formats::GameMode;
use engine::replay::frames::convert_frames;
use engine::score::{peppy_stars, section_tally, total_score, ScoreContext, NOMOD_SCORE_MULTIPLIER};
use engine::simulation::simulate;
use md5::{Digest, Md5};
use serde::Serialize;

const REJECTION_ORDER: [&str; 10] = [
    "duplicate",
    "undecodable",
    "non_std",
    "modded",
    "lazer_written",
    "zeroed_geki_katu",
    "unmatched_beatmap",
    "unprocessable",
    "incomplete",
    "simulation_error",
];

const FIELD_NAMES: [&str; 8] = [
    "count_300",
    "count_100",
    "count_50",
    "count_miss",
    "max_combo",
    "count_geki",
    "count_katsu",
    "total_score",
];

#[derive(Serialize)]
struct FieldDivergence {
    header: u64,
    simulated: u64,
}

#[derive(Serialize)]
struct Failure {
    stem: String,
    replay_path: String,
    beatmap_path: String,
    header_misses: u32,
    has_spinners: bool,
    // corpus-admission triage context (issue 11's wishlist rows key on
    // these): the header's own counts/combo, the strict perfect check, and
    // the map's achievable ceiling
    header_count_100: u32,
    header_count_50: u32,
    header_max_combo: u32,
    max_achievable_combo: u32,
    fields: BTreeMap<&'static str, FieldDivergence>,
}

#[derive(Serialize)]
struct Population {
    candidates: usize,
    rejected: BTreeMap<&'static str, usize>,
    admitted: usize,
}

#[derive(Serialize)]
struct Manifest {
    stable_dir: String,
    population: Population,
    failures: Vec<Failure>,
}

/// one admitted play's eight oracle comparisons, header vs simulated
struct Verdict {
    header: [u64; 8],
    simulated: [u64; 8],
    header_misses: u32,
    has_spinners: bool,
    max_achievable_combo: u32,
    beatmap_path: PathBuf,
}

impl Verdict {
    fn field_passes(&self, i: usize) -> bool {
        self.header[i] == self.simulated[i]
    }
    fn counts_exact(&self) -> bool {
        (0..4).all(|i| self.field_passes(i))
    }
    fn simulation_exact(&self) -> bool {
        (0..5).all(|i| self.field_passes(i))
    }
    fn all_exact(&self) -> bool {
        (0..8).all(|i| self.field_passes(i))
    }
}

fn main() {
    let mut args = std::env::args().skip(1);
    let mut stable_dir: Option<PathBuf> = None;
    let mut manifest_path: Option<PathBuf> = None;
    let mut passing_path: Option<PathBuf> = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--manifest" => {
                let value = args.next().unwrap_or_else(|| usage("--manifest needs a path"));
                manifest_path = Some(PathBuf::from(value));
            }
            // corpus-candidate sourcing: dumps every all-eight-exact play
            // (stem, paths, miss count, spinner presence) so admissions can
            // be picked per quirk instead of re-running anything
            "--dump-passing" => {
                let value = args.next().unwrap_or_else(|| usage("--dump-passing needs a path"));
                passing_path = Some(PathBuf::from(value));
            }
            other if stable_dir.is_none() => stable_dir = Some(PathBuf::from(other)),
            other => usage(&format!("unexpected argument {other:?}")),
        }
    }
    let stable_dir = stable_dir
        .or_else(|| std::env::var_os("OSU_STABLE_DIR").map(PathBuf::from))
        .unwrap_or_else(|| usage("no stable install given"));
    if !stable_dir.is_dir() {
        usage(&format!("stable dir {} does not exist", stable_dir.display()));
    }
    let manifest_path = manifest_path.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/replays/local/sweep_manifest.json")
    });

    let by_md5 = build_md5_index(&stable_dir);
    eprintln!("beatmap index: {} entries", by_md5.len());

    let mut candidates: Vec<PathBuf> = Vec::new();
    for dir in [stable_dir.join("Data").join("r"), stable_dir.join("Replays")] {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            eprintln!("note: {} missing or unreadable, skipping", dir.display());
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("osr") {
                candidates.push(path);
            }
        }
    }
    candidates.sort();

    let mut rejected: BTreeMap<&'static str, usize> = REJECTION_ORDER.iter().map(|&k| (k, 0)).collect();
    let mut seen_replay_md5: HashSet<String> = HashSet::new();
    let mut verdicts: Vec<Verdict> = Vec::new();
    let mut failures: Vec<Failure> = Vec::new();
    let mut passing: Vec<Failure> = Vec::new();
    // play libraries concentrate many replays on the same maps, so the
    // decode + process pass (slider geometry, the expensive one) memoizes
    // by verified md5 -- the hash is checked on first read, so the stale-
    // index safety property is preserved
    let mut map_cache: MapCache = std::collections::HashMap::new();

    for path in &candidates {
        match admit_and_verify(path, &by_md5, &mut seen_replay_md5, &mut map_cache) {
            Ok(verdict) => {
                if !verdict.all_exact() {
                    failures.push(failure_entry(path, &verdict));
                } else if passing_path.is_some() {
                    // an all-exact entry reuses the failure shape with an
                    // empty fields map
                    passing.push(failure_entry(path, &verdict));
                }
                verdicts.push(verdict);
            }
            Err(filter) => *rejected.get_mut(filter).expect("known filter name") += 1,
        }
    }

    let admitted = verdicts.len();
    println!("population: {} candidates from Data/r + Replays", candidates.len());
    for name in REJECTION_ORDER {
        let n = rejected[name];
        if n > 0 {
            println!("  rejected {name}: {n}");
        }
    }
    println!("  admitted: {admitted}");
    if admitted == 0 {
        eprintln!("nothing admitted; not writing a manifest");
        return;
    }

    println!("\nper-assertion pass rates over admitted plays:");
    for (i, name) in FIELD_NAMES.iter().enumerate() {
        let passing = verdicts.iter().filter(|v| v.field_passes(i)).count();
        println!("  {name:<12} {}", rate(passing, admitted));
    }

    let counts_exact = verdicts.iter().filter(|v| v.counts_exact()).count();
    let simulation_exact = verdicts.iter().filter(|v| v.simulation_exact()).count();
    let all_exact = verdicts.iter().filter(|v| v.all_exact()).count();
    println!("\ngrouped:");
    println!("  counts exact (300/100/50/miss)   {}", rate(counts_exact, admitted));
    println!("  simulation exact (counts+combo)  {}", rate(simulation_exact, admitted));
    println!("  all eight exact                  {}", rate(all_exact, admitted));

    // the two triage tables the 2026-08-12 baseline used: derived fields
    // over the simulation-exact subset split by spinner presence, and
    // simulation exactness bucketed by header miss count
    println!("\nderived fields over simulation-exact plays, by spinner presence:");
    for (label, want_spinners) in [("spinner-free", false), ("has spinners", true)] {
        let subset: Vec<&Verdict> = verdicts
            .iter()
            .filter(|v| v.simulation_exact() && v.has_spinners == want_spinners)
            .collect();
        if subset.is_empty() {
            println!("  {label:<13} (none)");
            continue;
        }
        let geki = subset.iter().filter(|v| v.field_passes(5)).count();
        let katu = subset.iter().filter(|v| v.field_passes(6)).count();
        let score = subset.iter().filter(|v| v.field_passes(7)).count();
        println!(
            "  {label:<13} n={:<5} geki {}  katu {}  score {}",
            subset.len(),
            rate(geki, subset.len()),
            rate(katu, subset.len()),
            rate(score, subset.len()),
        );
    }

    println!("\nsimulation exactness by header miss bucket:");
    for (label, lo, hi) in [("0", 0u32, 0u32), ("1-3", 1, 3), ("4-10", 4, 10), ("11+", 11, u32::MAX)] {
        let bucket: Vec<&Verdict> = verdicts
            .iter()
            .filter(|v| v.header_misses >= lo && v.header_misses <= hi)
            .collect();
        if bucket.is_empty() {
            println!("  {label:<5} (none)");
            continue;
        }
        let exact = bucket.iter().filter(|v| v.simulation_exact()).count();
        println!("  {label:<5} {}", rate(exact, bucket.len()));
    }

    let manifest = Manifest {
        stable_dir: stable_dir.display().to_string(),
        population: Population {
            candidates: candidates.len(),
            rejected,
            admitted,
        },
        failures,
    };
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent).expect("create manifest dir");
    }
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest).expect("serialize manifest"),
    )
    .expect("write manifest");
    println!(
        "\nmanifest: {} ({} failing replays)",
        manifest_path.display(),
        manifest.failures.len()
    );

    if let Some(passing_path) = passing_path {
        std::fs::write(
            &passing_path,
            serde_json::to_string_pretty(&passing).expect("serialize passing dump"),
        )
        .expect("write passing dump");
        println!("passing dump: {} ({} replays)", passing_path.display(), passing.len());
    }
}

/// md5 -> beatmap path, lowercased keys. fast path is the install's osu!.db
/// via the osu-db crate; when that parse fails (the crate is dormant and a
/// 2026 client's db format is newer than it knows -- the same limitation
/// applies to the app's stable.rs lookup), fall back to hashing every
/// `Songs/**/*.osu`, which is the corpus-checklist's own documented build
/// path. matched files are re-hashed before use either way, so a stale
/// index rejects rather than mismatching
fn build_md5_index(stable_dir: &Path) -> std::collections::HashMap<String, PathBuf> {
    let mut by_md5 = std::collections::HashMap::new();
    let db_path = stable_dir.join("osu!.db");
    let songs_dir = stable_dir.join("Songs");

    match osu_db::listing::Listing::from_file(&db_path) {
        Ok(listing) => {
            for entry in &listing.beatmaps {
                if let (Some(hash), Some(folder), Some(file)) = (
                    entry.hash.as_deref(),
                    entry.folder_name.as_deref(),
                    entry.file_name.as_deref(),
                ) {
                    by_md5.insert(hash.to_ascii_lowercase(), songs_dir.join(folder).join(file));
                }
            }
            eprintln!("beatmap index: osu!.db listing ({} beatmaps)", listing.beatmaps.len());
        }
        Err(e) => {
            eprintln!("beatmap index: osu!.db parse failed ({e}); hashing Songs/**/*.osu instead");
            let mut stack = vec![songs_dir];
            let mut hashed = 0usize;
            while let Some(dir) = stack.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        stack.push(path);
                    } else if path.extension().and_then(|e| e.to_str()) == Some("osu") {
                        let Ok(bytes) = std::fs::read(&path) else { continue };
                        let mut hasher = Md5::new();
                        hasher.update(&bytes);
                        by_md5.insert(format!("{:x}", hasher.finalize()), path);
                        hashed += 1;
                        if hashed % 5000 == 0 {
                            eprintln!("  hashed {hashed} .osu files...");
                        }
                    }
                }
            }
        }
    }
    by_md5
}

fn usage(problem: &str) -> ! {
    eprintln!("sweep_replays: {problem}");
    eprintln!("usage: cargo run -p engine --release --example sweep_replays -- <stable-dir> [--manifest <path>]");
    eprintln!("       (or set OSU_STABLE_DIR instead of the positional argument)");
    std::process::exit(2);
}

fn rate(passing: usize, total: usize) -> String {
    format!("{passing}/{total} ({:.1}%)", 100.0 * passing as f64 / total as f64)
}

type MapCache = std::collections::HashMap<String, std::rc::Rc<(engine::formats::beatmap::Beatmap, engine::beatmap::ProcessedBeatmap)>>;

/// applies the admission filters in order and, for an admitted play, runs
/// the eight oracle comparisons. Err carries the rejecting filter's name
fn admit_and_verify(
    path: &Path,
    by_md5: &std::collections::HashMap<String, PathBuf>,
    seen_replay_md5: &mut HashSet<String>,
    map_cache: &mut MapCache,
) -> Result<Verdict, &'static str> {
    let bytes = std::fs::read(path).map_err(|_| "undecodable")?;
    let osr = decode_osr(&bytes).map_err(|_| "undecodable")?;

    if let Some(replay_md5) = &osr.header.replay_md5 {
        if !seen_replay_md5.insert(replay_md5.to_ascii_lowercase()) {
            return Err("duplicate");
        }
    }
    if osr.header.mode != GameMode::Osu {
        return Err("non_std");
    }
    if osr.header.mods != 0 {
        return Err("modded");
    }
    if osr.header.version >= FIRST_LAZER_VERSION {
        return Err("lazer_written");
    }
    if osr.header.count_geki == 0 && osr.header.count_katsu == 0 {
        return Err("zeroed_geki_katu");
    }

    let beatmap_md5 = osr.header.beatmap_md5.as_deref().ok_or("unmatched_beatmap")?;
    let md5_key = beatmap_md5.to_ascii_lowercase();
    let osu_path = by_md5.get(&md5_key).ok_or("unmatched_beatmap")?;
    let pair = if let Some(cached) = map_cache.get(&md5_key) {
        std::rc::Rc::clone(cached)
    } else {
        let osu_bytes = std::fs::read(osu_path).map_err(|_| "unmatched_beatmap")?;
        let mut hasher = Md5::new();
        hasher.update(&osu_bytes);
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(beatmap_md5) {
            return Err("unmatched_beatmap");
        }
        let map = decode_beatmap_bytes(&osu_bytes).map_err(|_| "unprocessable")?;
        let processed = process_beatmap(&map).map_err(|_| "unprocessable")?;
        let pair = std::rc::Rc::new((map, processed));
        map_cache.insert(md5_key, std::rc::Rc::clone(&pair));
        pair
    };
    let (map, processed) = (&pair.0, &pair.1);

    if osr.header.judged_count() != map.hit_objects.len() as u32 {
        return Err("incomplete");
    }

    let frames = convert_frames(&osr.actions, map.format_version);
    let timeline = simulate(processed, &frames).map_err(|_| "simulation_error")?;
    let tally = section_tally(processed, &timeline);
    let stars = peppy_stars(&ScoreContext::from_beatmap(map)).map_err(|_| "simulation_error")?;
    let simulated_score = total_score(&timeline, processed, stars, NOMOD_SCORE_MULTIPLIER);

    Ok(Verdict {
        header: [
            u64::from(osr.header.count_300),
            u64::from(osr.header.count_100),
            u64::from(osr.header.count_50),
            u64::from(osr.header.count_miss),
            u64::from(osr.header.max_combo),
            u64::from(osr.header.count_geki),
            u64::from(osr.header.count_katsu),
            u64::from(osr.header.total_score),
        ],
        simulated: [
            u64::from(timeline.totals.count_300),
            u64::from(timeline.totals.count_100),
            u64::from(timeline.totals.count_50),
            u64::from(timeline.totals.count_miss),
            u64::from(timeline.totals.max_combo),
            u64::from(tally.count_geki),
            u64::from(tally.count_katsu),
            simulated_score,
        ],
        header_misses: u32::from(osr.header.count_miss),
        has_spinners: processed
            .objects
            .iter()
            .any(|o| matches!(o.kind, ProcessedKind::Spinner(_))),
        max_achievable_combo: engine::score::max_achievable_combo(processed),
        beatmap_path: osu_path.clone(),
    })
}

fn failure_entry(path: &Path, verdict: &Verdict) -> Failure {
    let mut fields = BTreeMap::new();
    for (i, name) in FIELD_NAMES.iter().enumerate() {
        if !verdict.field_passes(i) {
            fields.insert(
                *name,
                FieldDivergence {
                    header: verdict.header[i],
                    simulated: verdict.simulated[i],
                },
            );
        }
    }
    Failure {
        stem: path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        replay_path: path.display().to_string(),
        beatmap_path: verdict.beatmap_path.display().to_string(),
        header_misses: verdict.header_misses,
        has_spinners: verdict.has_spinners,
        header_count_100: verdict.header[1] as u32,
        header_count_50: verdict.header[2] as u32,
        header_max_combo: verdict.header[4] as u32,
        max_achievable_combo: verdict.max_achievable_combo,
        fields,
    }
}
