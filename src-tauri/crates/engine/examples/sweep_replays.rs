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
//! install's `osu!.db` md5 listing, read by the engine's own codec -- the
//! same reader the app's stable lookup uses, so a sweep over a real library
//! is that codec's end-to-end check -- and re-hashed on disk, so a stale
//! listing rejects rather than mis-matching. beatmaps are assumed at
//! `<stable-dir>\Songs`; a relocated `BeatmapDirectory` is not honoured here.
//!
//! this is an example, never a test: ci never sees it, and a red sweep exits
//! 0 -- the numbers themselves are the output.
//!
//! # admission filters, in application order
//!
//! each candidate is rejected by the first filter it fails, and the per-filter
//! rejection counts are printed so the population is auditable:
//!
//! 1. `undecodable` -- the file could not be read, or `.osr` decode failed
//! 2. `duplicate` -- same `replay_md5` already seen (Data/r and Replays both
//!    hold client-written files and can overlap)
//! 3. `non_std` -- header mode is not osu!standard
//! 4. `lazer_written` -- header version >= 30000000 (lazer-stamped, not
//!    stable-set). this is where the two populations part: such a play never
//!    reaches the stable filters below and is handed to the native filters
//!    instead, so `lazer_written` counts the native population's CANDIDATES
//!    rather than a plain rejection
//! 5. `modded` -- header mods bitfield is nonzero (NoMod only)
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
//! # native admission filters, in application order
//!
//! every `lazer_written` candidate is then admitted to the NATIVE population,
//! which is measured and reported entirely separately -- a native rate is
//! never blended into the stable one above:
//!
//! 1. `native_modded` -- the resolved configuration is not native NoMod
//! 2. `native_no_block` -- no score-info block, so there is no oracle at all
//! 3. `native_no_rank` -- the block states no rank, so the rank field has no
//!    oracle. this and the two above are MISSING ORACLES; a play whose block
//!    and engine genuinely disagree is never filtered here, it stays admitted
//!    and counts against the rate. the cost is deliberate and worth stating:
//!    such a block still carries both statistics maps, and the header still
//!    carries max combo and total score, so rejecting the play forfeits four
//!    comparisons to drop one. it is taken because the five rates share one
//!    denominator; a per-field "unmeasured" state is the alternative, and is
//!    worth building the day a real no-rank block appears (none has)
//! 4. `native_unmatched_beatmap` / 5. `native_unprocessable` -- as their
//!    stable twins
//! 6. `native_simulation_error` -- `simulate_native` returned a typed error
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
//!   "native_population": { "candidates": 12, "rejected": {...}, "admitted": 9, "exact": 8 },
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
//!   ],
//!   "native_failures": [
//!     {
//!       "stem": "...", "replay_path": "...", "beatmap_path": "...",
//!       "client_version": "2026.401.0-lazer",
//!       "rank_block": "F", "truncated_at": 28509.5,
//!       "fields": { "<native field>": { "block": "...", "simulated": "..." } }
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
use engine::configuration::resolve_play_configuration;
use engine::formats::beatmap::decode_beatmap_bytes;
use engine::formats::osr::{decode_osr, FIRST_LAZER_VERSION};
use engine::formats::GameMode;
use engine::replay::frames::convert_frames;
use engine::configuration::RulesProfile;
use engine::score::{
    native_drain, native_health, peppy_stars, section_tally, total_score, HitResult, ScoreContext, ScoreRank,
    NOMOD_SCORE_MULTIPLIER,
};
use engine::simulation::{outcome_up_to, simulate, simulate_native};
use md5::{Digest, Md5};
use serde::Serialize;

/// printed in APPLICATION order, the same order the module doc lists them in,
/// so the console histogram and the doc can be read side by side
const REJECTION_ORDER: [&str; 10] = [
    "undecodable",
    "duplicate",
    "non_std",
    "lazer_written",
    "modded",
    "zeroed_geki_katu",
    "unmatched_beatmap",
    "unprocessable",
    "incomplete",
    "simulation_error",
];

/// the native population's own filters, applied to every lazer-written
/// candidate the stable population rejects as `lazer_written`: admission is
/// the configuration's (effective mods empty, block present and stating a
/// rank), never the stable filters, which reject a lazer play outright
const NATIVE_REJECTION_ORDER: [&str; 6] = [
    "native_modded",
    "native_no_block",
    "native_no_rank",
    "native_unmatched_beatmap",
    "native_unprocessable",
    "native_simulation_error",
];

/// the native oracle's five comparisons against the block and the header
const NATIVE_FIELD_NAMES: [&str; 5] = ["statistics", "maximum_statistics", "max_combo", "total_score", "rank"];

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
    /// the lazer-native population, reported apart from stable's: its own
    /// candidates, rejections and exact-agreement rate, never blended
    native_population: NativePopulation,
    native_failures: Vec<NativeFailure>,
}

#[derive(Serialize)]
struct NativePopulation {
    candidates: usize,
    rejected: BTreeMap<&'static str, usize>,
    admitted: usize,
    exact: usize,
}

#[derive(Serialize)]
struct NativeFailure {
    stem: String,
    replay_path: String,
    beatmap_path: String,
    client_version: String,
    rank_block: Option<String>,
    truncated_at: Option<f64>,
    fields: BTreeMap<&'static str, NativeDivergence>,
}

#[derive(Serialize)]
struct NativeDivergence {
    block: String,
    simulated: String,
}

/// one admitted native play's five oracle comparisons, block/header vs the
/// native fold (truncated at the engine's fail point for a rank-F source)
struct NativeVerdict {
    block: [String; 5],
    simulated: [String; 5],
    client_version: String,
    rank_block: Option<String>,
    truncated_at: Option<f64>,
    beatmap_path: PathBuf,
}

impl NativeVerdict {
    fn field_passes(&self, i: usize) -> bool {
        self.block[i] == self.simulated[i]
    }
    fn all_exact(&self) -> bool {
        (0..5).all(|i| self.field_passes(i))
    }
}

/// what admission decided for one candidate: a stable play's eight
/// comparisons, a lazer-native play's five, or a rejection by name
enum Admitted {
    Stable(Verdict),
    Native(NativeVerdict),
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

    // build_md5_index prints its own first line: which path built the index
    // and how many entries it holds
    let by_md5 = build_md5_index(&stable_dir);

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
    let mut native_rejected: BTreeMap<&'static str, usize> =
        NATIVE_REJECTION_ORDER.iter().map(|&k| (k, 0)).collect();
    let mut seen_replay_md5: HashSet<String> = HashSet::new();
    let mut verdicts: Vec<Verdict> = Vec::new();
    let mut native_verdicts: Vec<NativeVerdict> = Vec::new();
    let mut failures: Vec<Failure> = Vec::new();
    let mut native_failures: Vec<NativeFailure> = Vec::new();
    let mut passing: Vec<Failure> = Vec::new();
    // play libraries concentrate many replays on the same maps, so the
    // decode + process pass (slider geometry, the expensive one) memoizes
    // by verified md5 -- the hash is checked on first read, so the stale-
    // index safety property is preserved
    let mut map_cache: MapCache = std::collections::HashMap::new();

    for path in &candidates {
        match admit_and_verify(path, &by_md5, &mut seen_replay_md5, &mut map_cache) {
            Ok(Admitted::Stable(verdict)) => {
                if !verdict.all_exact() {
                    failures.push(failure_entry(path, &verdict));
                } else if passing_path.is_some() {
                    // an all-exact entry reuses the failure shape with an
                    // empty fields map
                    passing.push(failure_entry(path, &verdict));
                }
                verdicts.push(verdict);
            }
            Ok(Admitted::Native(verdict)) => {
                // a lazer-written play counts against the stable population
                // as `lazer_written` -- that is what the stable rate has
                // always excluded -- and is measured in its own
                *rejected.get_mut("lazer_written").expect("known filter name") += 1;
                if !verdict.all_exact() {
                    native_failures.push(native_failure_entry(path, &verdict));
                }
                native_verdicts.push(verdict);
            }
            Err(filter) => {
                if let Some(count) = native_rejected.get_mut(filter) {
                    // a lazer-written play the native population refused is
                    // still `lazer_written` to the stable one
                    *rejected.get_mut("lazer_written").expect("known filter name") += 1;
                    *count += 1;
                } else {
                    *rejected.get_mut(filter).expect("known filter name") += 1;
                }
            }
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

    // the native population, its own paragraph: what the stable one
    // rejected as lazer-written, admitted by the configuration
    let native_candidates = rejected["lazer_written"];
    let native_admitted = native_verdicts.len();
    let native_exact = native_verdicts.iter().filter(|v| v.all_exact()).count();
    println!("\nnative population: {native_candidates} lazer-written candidates");
    for name in NATIVE_REJECTION_ORDER {
        let n = native_rejected[name];
        if n > 0 {
            println!("  rejected {name}: {n}");
        }
    }
    println!("  admitted: {native_admitted}");
    if native_admitted > 0 {
        println!("  per-assertion pass rates over admitted native plays:");
        for (i, name) in NATIVE_FIELD_NAMES.iter().enumerate() {
            let passing = native_verdicts.iter().filter(|v| v.field_passes(i)).count();
            println!("    {name:<18} {}", rate(passing, native_admitted));
        }
        println!("  all five exact: {}", rate(native_exact, native_admitted));
    }

    if admitted == 0 && native_admitted == 0 {
        eprintln!("nothing admitted; not writing a manifest");
        return;
    }
    if admitted == 0 {
        write_manifest(
            &manifest_path,
            Manifest {
                stable_dir: stable_dir.display().to_string(),
                population: Population {
                    candidates: candidates.len(),
                    rejected,
                    admitted,
                },
                failures,
                native_population: NativePopulation {
                    candidates: native_candidates,
                    rejected: native_rejected,
                    admitted: native_admitted,
                    exact: native_exact,
                },
                native_failures,
            },
        );
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
        native_population: NativePopulation {
            candidates: native_candidates,
            rejected: native_rejected,
            admitted: native_admitted,
            exact: native_exact,
        },
        native_failures,
    };
    write_manifest(&manifest_path, manifest);

    if let Some(passing_path) = passing_path {
        std::fs::write(
            &passing_path,
            serde_json::to_string_pretty(&passing).expect("serialize passing dump"),
        )
        .expect("write passing dump");
        println!("passing dump: {} ({} replays)", passing_path.display(), passing.len());
    }
}

/// md5 -> beatmap path, lowercased keys. the primary path is the install's
/// own `osu!.db` through the engine's listing codec -- the SAME reader the
/// app's stable lookup uses, so a sweep against a real 22 MB library is also
/// the production codec's end-to-end check. only when that reader refuses the
/// listing does this fall back to hashing every `Songs/**/*.osu`, the
/// corpus-checklist's own documented build path, so a refusal never silently
/// shrinks the population it measures. matched files are re-hashed before use
/// either way, so a stale index rejects rather than mismatching.
///
/// this does not honour a relocated `BeatmapDirectory`: it assumes `Songs`
/// beside the listing, which the usage text states.
///
/// the fold below duplicates `stable::fold` in the app crate on purpose --
/// an engine example cannot depend on the app crate, and the shared thing is
/// the CODEC, which both call. what differs is the product: the app keeps
/// folder and file apart for a lookup it makes once, this joins them into the
/// path a sweep opens directly.
fn build_md5_index(stable_dir: &Path) -> std::collections::HashMap<String, PathBuf> {
    let mut by_md5 = std::collections::HashMap::new();
    let db_path = stable_dir.join("osu!.db");
    let songs_dir = stable_dir.join("Songs");

    // which path built the index is the first thing printed, so a reader
    // regression shows up before any parity verdict does
    match std::fs::read(&db_path).map_err(|e| e.to_string()).and_then(|bytes| {
        engine::formats::stable_listing::decode_stable_listing(&bytes).map_err(|e| e.to_string())
    }) {
        Ok(listing) => {
            for entry in &listing.entries {
                if let (Some(hash), Some(folder), Some(file)) = (
                    entry.md5.as_deref(),
                    entry.folder_name.as_deref(),
                    entry.file_name.as_deref(),
                ) {
                    by_md5.insert(hash.to_ascii_lowercase(), songs_dir.join(folder).join(file));
                }
            }
            eprintln!(
                "beatmap index: engine reader over {} (version {}, {} entries, {} resolvable)",
                db_path.display(),
                listing.version,
                listing.entries.len(),
                by_md5.len()
            );
        }
        Err(e) => {
            eprintln!(
                "beatmap index: hashing {}/**/*.osu -- the engine reader refused {} ({e})",
                songs_dir.display(),
                db_path.display()
            );
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
            eprintln!("beatmap index: hash fallback ({hashed} .osu files, {} entries)", by_md5.len());
        }
    }
    by_md5
}

fn write_manifest(manifest_path: &Path, manifest: Manifest) {
    if let Some(parent) = manifest_path.parent() {
        std::fs::create_dir_all(parent).expect("create manifest dir");
    }
    std::fs::write(
        manifest_path,
        serde_json::to_string_pretty(&manifest).expect("serialize manifest"),
    )
    .expect("write manifest");
    println!(
        "\nmanifest: {} ({} failing replays, {} failing native replays)",
        manifest_path.display(),
        manifest.failures.len(),
        manifest.native_failures.len()
    );
}

fn usage(problem: &str) -> ! {
    eprintln!("sweep_replays: {problem}");
    eprintln!("usage: cargo run -p engine --release --example sweep_replays -- <stable-dir> [--manifest <path>]");
    eprintln!("       (or set OSU_STABLE_DIR instead of the positional argument)");
    eprintln!("       beatmaps are assumed at <stable-dir>\\Songs; a relocated");
    eprintln!("       BeatmapDirectory from osu!.<user>.cfg is not honoured here");
    std::process::exit(2);
}

fn rate(passing: usize, total: usize) -> String {
    format!("{passing}/{total} ({:.1}%)", 100.0 * passing as f64 / total as f64)
}

type MapCache = std::collections::HashMap<String, std::rc::Rc<(engine::formats::beatmap::Beatmap, engine::beatmap::ProcessedBeatmap)>>;

/// applies the admission filters in order and, for an admitted play, runs
/// the oracle comparisons of its population. Err carries the rejecting
/// filter's name
fn admit_and_verify(
    path: &Path,
    by_md5: &std::collections::HashMap<String, PathBuf>,
    seen_replay_md5: &mut HashSet<String>,
    map_cache: &mut MapCache,
) -> Result<Admitted, &'static str> {
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
    // a lazer-written play is the native population's: admitted by its
    // configuration (effective mods empty, block present and stating a rank),
    // measured against the block and the header on lazer's own terms
    if osr.header.version >= FIRST_LAZER_VERSION {
        let configuration = resolve_play_configuration(&osr, false);
        if configuration.profile != RulesProfile::Native || !configuration.mods.is_empty() {
            return Err("native_modded");
        }
        if osr.trailer.score_info().is_none() {
            return Err("native_no_block");
        }
        // the rank field's oracle IS the block's rank, and a block may state
        // none (`formats::score_info`: "absent when the writer had none"). that
        // is a MISSING ORACLE, so the play leaves the measured population by a
        // named filter -- as distinct from the rank-F case in `verify_native`,
        // which is a real disagreement and stays admitted to be counted against
        if osr.trailer.score_info().is_some_and(|block| block.rank.is_none()) {
            return Err("native_no_rank");
        }
        let (osu_path, pair) =
            resolve_beatmap(&osr, by_md5, map_cache, "native_unmatched_beatmap", "native_unprocessable")?;
        let (map, processed) = (&pair.0, &pair.1);
        return verify_native(path, &osr, map, processed, osu_path).map(Admitted::Native);
    }
    if osr.header.mods != 0 {
        return Err("modded");
    }
    if osr.header.count_geki == 0 && osr.header.count_katsu == 0 {
        return Err("zeroed_geki_katu");
    }

    let (osu_path, pair) = resolve_beatmap(&osr, by_md5, map_cache, "unmatched_beatmap", "unprocessable")?;
    let (map, processed) = (&pair.0, &pair.1);

    if osr.header.judged_count() != map.hit_objects.len() as u32 {
        return Err("incomplete");
    }

    let frames = convert_frames(&osr.actions, map.format_version);
    let configuration = resolve_play_configuration(&osr, false);
    let timeline = simulate(processed, &frames, &configuration).map_err(|_| "simulation_error")?;
    let tally = section_tally(processed, &timeline);
    let stars = peppy_stars(&ScoreContext::from_beatmap(map)).map_err(|_| "simulation_error")?;
    let simulated_score = total_score(&timeline, processed, stars, NOMOD_SCORE_MULTIPLIER);

    Ok(Admitted::Stable(Verdict {
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
    }))
}

type MapPair = std::rc::Rc<(engine::formats::beatmap::Beatmap, engine::beatmap::ProcessedBeatmap)>;

/// the beatmap a play names, by verified md5, decoded and processed once
/// per map; the two error names are the population's own
fn resolve_beatmap<'a>(
    osr: &engine::formats::osr::OsrFile,
    by_md5: &'a std::collections::HashMap<String, PathBuf>,
    map_cache: &mut MapCache,
    unmatched: &'static str,
    unprocessable: &'static str,
) -> Result<(&'a PathBuf, MapPair), &'static str> {
    let beatmap_md5 = osr.header.beatmap_md5.as_deref().ok_or(unmatched)?;
    let md5_key = beatmap_md5.to_ascii_lowercase();
    let osu_path = by_md5.get(&md5_key).ok_or(unmatched)?;
    let pair = if let Some(cached) = map_cache.get(&md5_key) {
        std::rc::Rc::clone(cached)
    } else {
        let osu_bytes = std::fs::read(osu_path).map_err(|_| unmatched)?;
        let mut hasher = Md5::new();
        hasher.update(&osu_bytes);
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(beatmap_md5) {
            return Err(unmatched);
        }
        let map = decode_beatmap_bytes(&osu_bytes).map_err(|_| unprocessable)?;
        let processed = process_beatmap(&map).map_err(|_| unprocessable)?;
        let pair = std::rc::Rc::new((map, processed));
        map_cache.insert(md5_key, std::rc::Rc::clone(&pair));
        pair
    };
    Ok((osu_path, pair))
}

/// the native oracle, as `tests/replay_corpus.rs` applies it: the block's
/// statistics and maximum statistics, the header's max combo and total,
/// and the rank -- compared whole, or up to the engine's own fail point
/// when the block records rank F
fn verify_native(
    _path: &Path,
    osr: &engine::formats::osr::OsrFile,
    map: &engine::formats::beatmap::Beatmap,
    processed: &engine::beatmap::ProcessedBeatmap,
    osu_path: &Path,
) -> Result<NativeVerdict, &'static str> {
    let block = osr.trailer.score_info().ok_or("native_no_block")?;
    let frames = convert_frames(&osr.actions, map.format_version);
    let timeline = simulate_native(processed, &frames).map_err(|_| "native_simulation_error")?;
    let native = timeline.native.as_ref().ok_or("native_simulation_error")?;
    let drain = native_drain(processed, map.hp_drain_rate);
    let health = native_health(processed, &timeline, map.hp_drain_rate, drain);

    let named = |counts: &[(HitResult, u32)]| -> String {
        counts
            .iter()
            .map(|(r, c)| format!("{}={c}", r.snake_name()))
            .collect::<Vec<_>>()
            .join(",")
    };
    let entries = |entries: &[engine::formats::score_info::StatisticEntry]| -> String {
        entries
            .iter()
            .map(|e| format!("{}={}", e.result, e.count))
            .collect::<Vec<_>>()
            .join(",")
    };
    let (statistics, maximum, max_combo, total_score, rank, truncated_at) =
        match (block.rank, health.fail_event_index) {
            (Some(ScoreRank::F), Some(fail_event_index)) => {
                let truncated = outcome_up_to(processed, &timeline, fail_event_index)
                    .ok_or("native_simulation_error")?;
                (
                    named(&truncated.statistics),
                    named(&truncated.maximum_statistics),
                    truncated.max_combo,
                    truncated.total_score,
                    ScoreRank::F,
                    health.fail_time,
                )
            }
            // a block that records a fail the health fold does not reproduce is a
            // DISAGREEMENT, not a missing oracle: it falls through to the whole-timeline
            // reading below, whose rank is not F, so the play stays admitted and shows up
            // as a failing row. rejecting it here would delete exactly the plays the
            // rank-F truncation rule exists to police from the rate that publishes it
            // (spec: "a parity finding, never absorbed by widening the comparison"), and
            // `tests/replay_corpus.rs` treats the same condition as a hard failure
            _ => (
                named(&native.statistics),
                named(&native.maximum_statistics),
                timeline.totals.max_combo,
                native.total_score,
                if health.fail_time.is_some() {
                    ScoreRank::F
                } else {
                    timeline.totals.rank
                },
                None,
            ),
        };
    let block_rank = block.rank.map(|r| r.as_str().to_owned());
    Ok(NativeVerdict {
        block: [
            entries(&block.statistics),
            entries(&block.maximum_statistics),
            osr.header.max_combo.to_string(),
            osr.header.total_score.to_string(),
            block_rank.clone().unwrap_or_else(|| "none".into()),
        ],
        simulated: [
            statistics,
            maximum,
            max_combo.to_string(),
            total_score.to_string(),
            rank.as_str().to_owned(),
        ],
        client_version: block.client_version.clone(),
        rank_block: block_rank,
        truncated_at,
        beatmap_path: osu_path.to_path_buf(),
    })
}

fn native_failure_entry(path: &Path, verdict: &NativeVerdict) -> NativeFailure {
    let mut fields = BTreeMap::new();
    for (i, name) in NATIVE_FIELD_NAMES.iter().enumerate() {
        if !verdict.field_passes(i) {
            fields.insert(
                *name,
                NativeDivergence {
                    block: verdict.block[i].clone(),
                    simulated: verdict.simulated[i].clone(),
                },
            );
        }
    }
    NativeFailure {
        stem: path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        replay_path: path.display().to_string(),
        beatmap_path: verdict.beatmap_path.display().to_string(),
        client_version: verdict.client_version.clone(),
        rank_block: verdict.rank_block.clone(),
        truncated_at: verdict.truncated_at,
        fields,
    }
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
