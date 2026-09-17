mod fixture_util;

use engine::beatmap::process_beatmap;
use engine::configuration::{resolve_play_configuration, PlayConfiguration, RulesProfile};
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::decode_osr;
use engine::replay::frames::convert_frames;
use engine::score::{
    compare_life_bar_graph, derive_health, drain_rate_search, format_graph_number, life_bar_graph,
    max_achievable_combo, native_drain, native_health, peppy_stars, section_tally, total_score, HitResult,
    ScoreContext, ScoreRank, NOMOD_SCORE_MULTIPLIER,
};
use engine::simulation::score::JudgementKind;
use engine::simulation::{outcome_up_to, simulate, simulate_native, JudgementEvent};

/// human-ratified deliberate divergences in the local corpus -- a visible
/// exception ledger, never a silent allowlist. each entry names the replay
/// stem, the single field allowed to diverge with its exact signed delta
/// (simulated minus header), the mechanism, and where the ratification is
/// recorded. the corpus test enforces the entry in both directions: a
/// drifted delta is new behaviour hiding behind an old record, and a
/// vanished divergence is a stale record -- either way the run fails and
/// the entry comes back for human review
struct RatifiedDivergence {
    stem: &'static str,
    /// simulated minus header for (geki, katu, total score); zeros require
    /// exact agreement, and counts/max combo are always checked separately
    derived_delta: (i64, i64, i64),
    mechanism: &'static str,
    record: &'static str,
}

const RATIFIED_DIVERGENCES: &[RatifiedDivergence] = &[
    RatifiedDivergence {
        stem: "L033---cosmobousou-p---denpa-shoujo",
        derived_delta: (0, 0, -19_580),
        mechanism: "intra-frame ordering: a head-miss deadline and a tail point 2ms apart land on one \
                replay frame and apply in walk order, not due-time order, costing one combo unit \
                over the closing run",
        record: "ratified 2026-08-12; .scratch/engine-parity-pass/issues/05 closing comment",
    },
    RatifiedDivergence {
        stem: "L203---44000---pumpmycrunkbeetz",
        derived_delta: (0, -1, 0),
        mechanism: "grade-placement residual: both engine and danser derive katu 15 against the \
                header's 16, with the other seven fields exact; the precise lost judgement \
                remains unresolved, so this accepts only the observed delta, not a general tolerance",
        record: "accepted 2026-09-05 bounded-pass decision; docs/engine-parity.md (L203)",
    },
];

/// spec parity rule 2: the .osr header's counts and max combo are the oracle.
/// corpus layout: fixtures/replays/local/<name>.osr with a sibling
/// <name>.osu (same stem). the directory is gitignored; an empty or missing
/// directory passes with a notice so ci stays green without personal data
#[test]
fn local_nomod_replays_self_verify() {
    let dir = fixture_util::fixtures_dir().join("replays/local");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("corpus: {dir:?} missing, skipping");
        return;
    };

    let mut checked = 0;
    // native plays that verified in every field the block can be an oracle
    // for, and carried a named excuse in the rest -- counted apart from
    // `checked` so the summary never calls an excused play exact
    let mut excused = 0;
    let mut ratified = 0;
    // every failing pair is reported before the assertion so a red run
    // shows the whole corpus picture, not the alphabetically first mismatch
    let mut failures: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("osr") {
            continue;
        }
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let osu_path = path.with_extension("osu");
        if !osu_path.exists() {
            eprintln!("corpus: {name}: no sibling .osu, skipping");
            continue;
        }

        let osr = match decode_osr(&std::fs::read(&path).unwrap()) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("corpus: {name}: not simulatable ({e}), skipping");
                continue;
            }
        };
        if osr.header.mods != 0 {
            eprintln!("corpus: {name}: modded (0x{:x}), skipping", osr.header.mods);
            continue;
        }

        let map = decode_beatmap_path(&osu_path).unwrap_or_else(|e| panic!("{name}: beatmap: {e}"));
        let processed = process_beatmap(&map).unwrap_or_else(|e| panic!("{name}: process: {e}"));
        let frames = convert_frames(&osr.actions, map.format_version);
        let configuration = resolve_play_configuration(&osr, false);

        // a lazer-written play is the native profile's oracle, on lazer's
        // own terms: its block's statistics map and rank, the header's max
        // combo and standardised total. it never reaches the stable
        // comparison below, whose oracle is stable's own header. every
        // native pair needs its ledger row first -- provenance is what keeps
        // historical lazer gameplay drift from being counted as an engine bug
        if configuration.profile == RulesProfile::Native {
            let row = match native_ledger_row(&dir, &name) {
                Err(complaint) => {
                    failures.push(complaint);
                    continue;
                }
                Ok(row) => {
                    eprintln!(
                        "corpus: {name}: native pair from {} ({}), against pin {}",
                        row.client, row.origin, row.pin
                    );
                    row
                }
            };
            match verify_native_pair(&name, &osr, &processed, &frames, map.hp_drain_rate, &row) {
                Ok(true) => checked += 1,
                Ok(false) => excused += 1,
                Err(complaint) => failures.push(complaint),
            }
            continue;
        }

        let timeline =
            simulate(&processed, &frames, &configuration).unwrap_or_else(|e| panic!("{name}: simulate: {e}"));

        let simulated = (
            timeline.totals.count_300,
            timeline.totals.count_100,
            timeline.totals.count_50,
            timeline.totals.count_miss,
            timeline.totals.max_combo,
        );
        let header = (
            u32::from(osr.header.count_300),
            u32::from(osr.header.count_100),
            u32::from(osr.header.count_50),
            u32::from(osr.header.count_miss),
            u32::from(osr.header.max_combo),
        );
        let ratification = RATIFIED_DIVERGENCES.iter().find(|r| r.stem == name);
        if simulated != header {
            // the ledger covers derived fields only; a ratified stem whose
            // counts diverge means the record no longer describes reality
            let stale = ratification
                .map(|r| {
                    format!(
                        " (a ratified derived-field divergence is on record -- review it: {})",
                        r.record
                    )
                })
                .unwrap_or_default();
            failures.push(format!(
                "{name}: simulated totals {simulated:?} diverge from the header's {header:?}{stale}"
            ));
            continue;
        }

        // the derived fields the export regenerates, against the same oracle.
        // this is the only oracle geki/katu have (the pinned lazer encoder
        // writes zeros for osu!), and the first observable check on achieved
        // scorev1 -- a mismatch that implicates simulation itself (e.g.
        // spinner bonus-spin counts) is a simulation finding to file, never
        // something to patch silently inside the score module
        let tally = section_tally(&processed, &timeline);
        let stars =
            peppy_stars(&ScoreContext::from_beatmap(&map)).unwrap_or_else(|e| panic!("{name}: stars: {e}"));
        let derived = (
            tally.count_geki,
            tally.count_katsu,
            total_score(&timeline, &processed, stars, NOMOD_SCORE_MULTIPLIER),
        );
        // the running walk over the very same play: the curve the HUD reads
        // must end where the header-oracled fold does. checked on every
        // corpus play including the ratified-divergence ones -- the invariant
        // is curve-versus-total, which a header divergence does not touch
        if let Err(complaint) = fixture_util::score_curve_ends_on_the_total(&timeline, &processed, stars) {
            failures.push(format!("{name}: {complaint}"));
            continue;
        }
        let header_derived = (
            u32::from(osr.header.count_geki),
            u32::from(osr.header.count_katsu),
            u64::from(osr.header.total_score),
        );
        match ratification {
            Some(r) => {
                let delta = (
                    i64::from(derived.0) - i64::from(header_derived.0),
                    i64::from(derived.1) - i64::from(header_derived.1),
                    derived.2 as i64 - header_derived.2 as i64,
                );
                if delta == r.derived_delta {
                    eprintln!(
                        "corpus: {name}: ratified divergence stands (geki/katu/score {delta:?}; {}; {})",
                        r.mechanism, r.record
                    );
                    ratified += 1;
                } else if delta == (0, 0, 0) {
                    failures.push(format!(
                        "{name}: the ratified derived divergence {:?} no longer reproduces -- the \
                         ledger entry is stale; review it: {}",
                        r.derived_delta, r.record
                    ));
                } else {
                    failures.push(format!(
                        "{name}: geki/katu/score delta {delta:?} differs from the ratified {:?} -- new \
                         behaviour is hiding behind the record; review it: {}",
                        r.derived_delta, r.record
                    ));
                }
                continue;
            }
            None if derived != header_derived => {
                failures.push(format!(
                    "{name}: derived geki/katu/score {derived:?} diverge from the header's {header_derived:?}"
                ));
                continue;
            }
            None => {}
        }
        checked += 1;
    }
    // a ledger entry whose pair is absent from THIS corpus validates
    // nothing this run -- said out loud rather than silently passing, but
    // never a failure: the corpus is per-machine personal data and another
    // machine legitimately lacks the stem
    let verified_stems: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.path().file_stem().map(|s| s.to_string_lossy().into_owned()))
        .collect();
    for entry in RATIFIED_DIVERGENCES {
        if !verified_stems.iter().any(|s| s == entry.stem) {
            eprintln!(
                "corpus NOTICE: ratified-divergence ledger entry {} has no pair in this corpus -- unverified this run",
                entry.stem
            );
        }
    }
    for failure in &failures {
        eprintln!("corpus FAIL: {failure}");
    }
    assert!(
        failures.is_empty(),
        "{} corpus replays diverge from their headers (list above)",
        failures.len()
    );
    eprintln!(
        "corpus: verified {checked} replays exact, {excused} native plays exact but for a named \
         excuse above, {ratified} on the ratified-divergence ledger"
    );
}

/// one native pair's provenance, from `fixtures/replays/local/native_ledger.json`
/// (documented in fixtures/README.md): which client wrote the play, whether
/// it is the original play or a re-run in the reference client, and the
/// engine pin the parity claim names. a pair without a row is refused, not
/// skipped: a native play with unknown provenance cannot be a parity claim
#[derive(serde::Deserialize)]
struct NativeLedgerRow {
    stem: String,
    client: String,
    /// `original` or `re-run`
    origin: String,
    pin: String,
    /// the client's own date as `YYYY-MM-DD` -- for a row dated by a
    /// changelog bracket, the bracket's UPPER bound, so "predates a lazer
    /// change" is only ever claimed when the whole bracket does. this is
    /// what decides whether the play may carry a grade claim at all
    /// (`HIT_WINDOW_MERGE`), so a row without it carries none
    client_date: Option<String>,
}

/// the day lazer's hit-window flooring merged: PR #33882 / `0f078ee550`,
/// "Apply flooring and half-millisecond-adjustments to hit windows"
/// (authored 2025-04-18, merged 2025-07-02), which narrowed every window
/// from `DifficultyRange(od, ..)` to `floor(DifficultyRange(od, ..)) - 0.5`.
/// this engine ports the pinned rule (`beatmap::difficulty`), so a play
/// written by an EARLIER client was graded under wider windows and will read
/// `great` low and `ok`/`meh` high by exactly the objects whose hit error
/// sits at `|offset| == floor(window)`. that is lazer's own change, not a
/// divergence of this port: verified by re-running such plays through the
/// pinned client itself, which reproduces this engine's grades exactly and
/// the file's not at all (`docs/engine-parity.md`)
const HIT_WINDOW_MERGE: &str = "2025-07-02";

/// the results whose count a `.osr` does not pin down to the object, because
/// they are decided by tracking or rotation sampled at the client's own
/// DISPLAY frames while `ReplayRecorder` throttles the replay's positional
/// frames to 60hz. this walk takes the limit of an arbitrarily fast display,
/// a real client ran at whatever rate it ran at, and the two land on
/// opposite sides of an element every so often. measured over this corpus
/// once the important-section port defect was removed, the whole residual is
/// at most `CADENCE_NOISE_FLOOR` elements on a play and falls both ways --
/// which is what makes it a noise floor rather than a bias to chase
const CADENCE_RESULTS: &[HitResult] = &[
    HitResult::SliderTailHit,
    HitResult::IgnoreMiss,
    HitResult::LargeTickHit,
    HitResult::LargeTickMiss,
    HitResult::SmallBonus,
    HitResult::LargeBonus,
];

/// the cadence results a slider TICK or REPEAT trades between. it scores one
/// or the other and never anything else (`native::slider`'s result map), so
/// this group conserves entirely on its own
const TICK_CADENCE_GROUP: &[HitResult] = &[HitResult::LargeTickHit, HitResult::LargeTickMiss];

/// the cadence results an element that can go UNREACHED trades between. a
/// slider tail is a `SliderTailHit` or an `IgnoreMiss`; a spinner's bonus tick
/// is its own bonus or an `IgnoreMiss` (`native`'s end-of-spinner miss). so
/// `IgnoreMiss` is the counterpart both share, which is what puts the three in
/// one group rather than two
const UNREACHED_CADENCE_GROUP: &[HitResult] =
    &[HitResult::SliderTailHit, HitResult::SmallBonus, HitResult::LargeBonus, HitResult::IgnoreMiss];

/// the observed magnitude of that residual, per play, and deliberately NOT a
/// round number with room in it: it is the largest divergence left in the
/// corpus, so anything bigger is new behaviour and comes back for review.
/// before the important-section fix one play stood at 14
const CADENCE_NOISE_FLOOR: i64 = 2;

/// what an explained statistics difference does, and does not, excuse
/// downstream. `max_combo`, the total and the rank are FUNCTIONS of the
/// statistics, so a difference in the counts they are folded from explains a
/// difference in them too -- but only as far as the differing RESULT CLASS
/// can reach, which is the whole point of splitting this out from one
/// boolean. a bonus the display cadence moved is worth points and nothing
/// else: `SmallBonus`, `LargeBonus` and the `IgnoreMiss` they trade against
/// neither affect combo nor affect accuracy, so on a play whose only
/// difference is theirs, `max_combo` and the rank stay PINNED rather than
/// going unchecked alongside the total. likewise a `great`-to-`ok` era
/// downgrade moves accuracy and the total, and can never move combo
#[derive(Debug, Default)]
struct ExplainedDivergence {
    /// one human note per explained class, printed per play
    notes: Vec<String>,
    /// the difference CROSSES combo classes, so `max_combo` may follow.
    /// affecting combo is not enough on its own: `great` and `ok` both
    /// increase it, so an object moving between them leaves the run intact
    combo: bool,
    /// a differing result scores, so the total may follow
    score: bool,
    /// a differing result affects accuracy, which is what the rank reads --
    /// `Miss`'s own demotion of S and X included, that result affecting
    /// accuracy too (`rank_from_accuracy`)
    accuracy: bool,
}

impl ExplainedDivergence {
    /// widen this reach by another CAUSE's. the era and the cadence explain
    /// different results and are folded separately, so that neither borrows
    /// the other's reach -- a play whose grades moved within `great`/`ok`
    /// and whose bonuses traded against an `IgnoreMiss` has two differences,
    /// neither of which can move combo, and pooling them would read as one
    /// that can
    fn widen(&mut self, other: &ExplainedDivergence) {
        self.combo |= other.combo;
        self.score |= other.score;
        self.accuracy |= other.accuracy;
    }
}

/// which side of combo a result falls on. a difference confined to ONE of
/// these cannot move `max_combo`: trading a `great` for an `ok` leaves the
/// run intact, and trading an `IgnoreMiss` for a bonus never touched it.
/// one that spans two -- a `great` for a `miss`, an `IgnoreMiss` for a
/// `SliderTailHit` -- can
#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum ComboClass {
    Increases,
    Breaks,
    Untouched,
}

/// how far a difference confined to `results` reaches into the fields folded
/// from the statistics, read off the result classes that actually differ
fn reach_of(results: &[HitResult], deltas: &std::collections::BTreeMap<String, i64>) -> ExplainedDivergence {
    let mut reach = ExplainedDivergence::default();
    let mut classes = std::collections::BTreeSet::new();
    for result in results.iter().copied() {
        if !deltas.contains_key(result.snake_name()) {
            continue;
        }
        classes.insert(if result.increases_combo() {
            ComboClass::Increases
        } else if result.breaks_combo() {
            ComboClass::Breaks
        } else {
            ComboClass::Untouched
        });
        reach.score |= result.is_scorable();
        reach.accuracy |= result.affects_accuracy();
    }
    reach.combo = classes.len() > 1;
    reach
}

/// the results the hit-window change moves, in the order it moves them: the
/// LADDER, best first. this ORDER is load-bearing, not presentation --
/// narrowing a window only ever pushes an object into a softer tier, and
/// walking these in sequence is the whole of the shape test in
/// `classify_native_statistics`
const GRADE_RESULTS: &[HitResult] = &[HitResult::Great, HitResult::Ok, HitResult::Meh, HitResult::Miss];

fn native_ledger_row(dir: &std::path::Path, stem: &str) -> Result<NativeLedgerRow, String> {
    let path = dir.join("native_ledger.json");
    let text = std::fs::read_to_string(&path).map_err(|e| {
        format!("{stem}: a lazer-native pair needs a row in {} (see fixtures/README.md): {e}", path.display())
    })?;
    let rows: Vec<NativeLedgerRow> =
        serde_json::from_str(&text).map_err(|e| format!("{stem}: the native ledger does not parse: {e}"))?;
    let row = rows
        .into_iter()
        .find(|row| row.stem == stem)
        .ok_or_else(|| format!("{stem}: no row in the native ledger names this pair (see fixtures/README.md)"))?;
    if row.origin != "original" && row.origin != "re-run" {
        return Err(format!(
            "{stem}: the native ledger's origin must be `original` or `re-run`, got {:?}",
            row.origin
        ));
    }
    Ok(row)
}

/// the native corpus oracle: the block lazer wrote beside the header. a
/// rank-F source failed, so lazer's score processor stopped counting at the
/// failing result; the comparison then runs up to the engine's own fail
/// point, and a disagreement past that rule is a parity finding, never
/// absorbed by widening the comparison. every other source compares whole.
///
/// `Ok(true)` is an EXACT verification and `Ok(false)` one the block could
/// not be a whole oracle for, its excused classes named on stderr -- two
/// answers the summary line counts apart, since calling an excused play
/// exact is the one way this test could overclaim quietly
fn verify_native_pair(
    name: &str,
    osr: &engine::formats::osr::OsrFile,
    processed: &engine::beatmap::ProcessedBeatmap,
    frames: &[engine::replay::frames::ReplayFrame],
    hp_drain_rate: f32,
    row: &NativeLedgerRow,
) -> Result<bool, String> {
    let Some(block) = osr.trailer.score_info() else {
        return Err(format!("{name}: a lazer-written play with no readable block has no oracle"));
    };
    let timeline = simulate_native(processed, frames).map_err(|e| format!("{name}: simulate natively: {e}"))?;
    let native = timeline.native.as_ref().expect("the native walk carries its outcome");
    let drain = native_drain(processed, hp_drain_rate);
    let health = native_health(processed, &timeline, hp_drain_rate, drain);

    let block_statistics: Vec<(String, i64)> = block.statistics.iter().map(|e| (e.result.clone(), e.count)).collect();
    let block_maximum: Vec<(String, i64)> = block
        .maximum_statistics
        .iter()
        .map(|e| (e.result.clone(), e.count))
        .collect();
    let named = |counts: &[(HitResult, u32)]| -> Vec<(String, i64)> {
        counts
            .iter()
            .map(|(r, c)| (r.snake_name().to_owned(), i64::from(*c)))
            .collect()
    };

    let (statistics, maximum, max_combo, total_score, rank) = match (block.rank, health.fail_event_index) {
        (Some(ScoreRank::F), Some(fail_event_index)) => {
            let truncated = outcome_up_to(processed, &timeline, fail_event_index)
                .expect("the native walk carries its applied results");
            eprintln!(
                "corpus: {name}: rank F source, compared up to the engine's fail point at {:.1}ms (event {fail_event_index})",
                health.fail_time.unwrap_or(f64::NAN)
            );
            (
                named(&truncated.statistics),
                named(&truncated.maximum_statistics),
                truncated.max_combo,
                truncated.total_score,
                ScoreRank::F,
            )
        }
        (Some(ScoreRank::F), None) => {
            return Err(format!(
                "{name}: the block records a fail (rank F) but the native health fold never reaches zero"
            ));
        }
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
        ),
    };

    let mut complaints = Vec::new();
    // the curve's last step against the WHOLE-timeline fold, never the
    // truncated one: the truncation is the comparison's rule for a rank-F
    // source, while the curve is what the panels read over the full play
    let curve_end = native.score_curve.last().map(|step| step.score);
    if curve_end != Some(u64::try_from(native.total_score).unwrap_or(0)) {
        complaints.push(format!(
            "the score curve ends at {curve_end:?} against the fold's total {}",
            native.total_score
        ));
    }
    // the block's key ORDER is its serializer's, and the two producers that
    // write one disagree: a client export and the server's own stored copy
    // spell the same map in different sequences. the oracle is the MAP, so
    // compare it as one. sorted rather than collected into a map so a
    // duplicate result name -- which the codec carries verbatim rather than
    // dropping -- still reads as a difference. document order is the CODEC's
    // round-trip contract (formats::score_info keeps it for exactly that),
    // never this comparison's
    let sorted = |rows: &[(String, i64)]| {
        let mut rows = rows.to_vec();
        rows.sort();
        rows
    };
    // the statistics map, split into the half a `.osr` pins down to the
    // object and the two halves it does not. an unexplained difference in
    // ANY field is still a failure; the two explained classes are reported
    // with their exact deltas instead, because failing on them would make
    // this test unpassable by any implementation, lazer's own included
    let mut explained = ExplainedDivergence::default();
    match classify_native_statistics(&statistics, &block_statistics, row) {
        // nothing is excused on a play that already fails: the derived
        // fields below are checked too, so the report names every symptom
        Err(complaint) => complaints.push(complaint),
        Ok(divergence) => explained = divergence,
    }
    if sorted(&maximum) != sorted(&block_maximum) {
        complaints.push(format!(
            "maximum statistics {:?} against the block's {:?}",
            sorted(&maximum),
            sorted(&block_maximum)
        ));
    }
    // max combo, the total and the rank are FUNCTIONS of the statistics, so
    // an explained statistics difference explains them too -- pinning them
    // exactly while excusing the counts they are folded from would fail the
    // same play twice for one cause. but each follows only the results that
    // can REACH it (`ExplainedDivergence`), so a play excused its bonuses is
    // still held to its combo and its rank, and one excused an era downgrade
    // is still held to its combo
    if max_combo != u32::from(osr.header.max_combo) && !explained.combo {
        complaints.push(format!("max combo {max_combo} against the header's {}", osr.header.max_combo));
    }
    if total_score != i64::from(osr.header.total_score) && !explained.score {
        complaints.push(format!("total score {total_score} against the header's {}", osr.header.total_score));
    }
    if let Some(without_mods) = block.total_score_without_mods {
        if total_score != without_mods && !explained.score {
            complaints.push(format!("total score {total_score} against the block's {without_mods} without mods"));
        }
    }
    if Some(rank) != block.rank && !explained.accuracy {
        complaints.push(format!("rank {rank:?} against the block's {:?}", block.rank));
    }
    if complaints.is_empty() {
        if explained.notes.is_empty() {
            eprintln!(
                "corpus: {name}: native play verified against its block ({} results; client {})",
                statistics.len(),
                block.client_version
            );
        } else {
            // reported, never silent: this is the whole of what the corpus
            // does not claim exactly, printed per play so a drift in it is
            // visible in the run rather than discovered later
            eprintln!(
                "corpus: {name}: native play verified except where the block cannot be an oracle -- {}",
                explained.notes.join("; ")
            );
        }
        Ok(explained.notes.is_empty())
    } else {
        Err(format!("{name}: {}", complaints.join("; ")))
    }
}

/// the statistics comparison's whole decision surface: the explained
/// divergences as human notes, or the complaint that fails the play.
///
/// the block's key ORDER is its serializer's, and the two producers that
/// write one disagree -- a client export and the server's own stored copy
/// spell the same map in different sequences -- so both sides fold into a
/// map keyed by result name. a name only one side carries still compares,
/// as a count the other is missing entirely
fn classify_native_statistics(
    statistics: &[(String, i64)],
    block: &[(String, i64)],
    row: &NativeLedgerRow,
) -> Result<ExplainedDivergence, String> {
    let mut deltas: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for (result, count) in statistics {
        *deltas.entry(result.clone()).or_default() += count;
    }
    for (result, count) in block {
        *deltas.entry(result.clone()).or_default() -= count;
    }
    deltas.retain(|_, delta| *delta != 0);
    if deltas.is_empty() {
        return Ok(ExplainedDivergence::default());
    }

    let named =
        |set: &[HitResult]| -> Vec<String> { set.iter().map(|r| r.snake_name().to_owned()).collect() };
    let grade_names = named(GRADE_RESULTS);
    let cadence_names = named(CADENCE_RESULTS);
    let unexplained: Vec<String> = deltas
        .keys()
        .filter(|name| !grade_names.contains(name) && !cadence_names.contains(name))
        .cloned()
        .collect();
    if !unexplained.is_empty() {
        return Err(format!(
            "statistics differ in {unexplained:?}, which neither the hit-window era nor the display \
             cadence explains: {deltas:?} (engine minus block)"
        ));
    }

    let mut explained = ExplainedDivergence::default();
    // the reach of this difference, read off the results that actually
    // differ rather than off the fact that SOMETHING did, and one cause at a
    // time so neither borrows the other's
    for cause in [GRADE_RESULTS, CADENCE_RESULTS] {
        let reach = reach_of(cause, &deltas);
        explained.widen(&reach);
    }

    let grade: std::collections::BTreeMap<&String, i64> =
        deltas.iter().filter(|(k, _)| grade_names.contains(k)).map(|(k, v)| (k, *v)).collect();
    if !grade.is_empty() {
        let Some(client_date) = row.client_date.as_deref() else {
            return Err(format!(
                "the grades differ ({grade:?}, engine minus block) and the ledger row carries no \
                 `client_date`, so there is no era to attribute it to -- date the client, or treat \
                 this as a finding"
            ));
        };
        if client_date > HIT_WINDOW_MERGE {
            return Err(format!(
                "the grades differ ({grade:?}, engine minus block) on a play from {client_date}, AFTER \
                 lazer's hit-window merge ({HIT_WINDOW_MERGE}) -- the era cannot explain this one"
            ));
        }
        // the change only ever NARROWS a window, so every object it moves
        // moves DOWN the ladder -- out of `great` into `ok`, out of `ok`
        // into `meh` -- and none moves up. walking the ladder best-first,
        // that is exactly: the running balance of what has left the tiers
        // above must never go positive (a tier may only be joined from a
        // stricter one, never from a softer one) and must close at zero,
        // since narrowing MOVES objects between tiers and creates none.
        // reading `great` alone would both reject a legitimate `ok`-to-`meh`
        // move, whose `great` never budges, and admit a shape like
        // `{great: -1, ok: 3, meh: -2}`, which needs two objects to have got
        // BETTER. a difference of any other shape is something else wearing
        // this one's clothes
        let mut balance = 0i64;
        let mut descends = true;
        for tier in GRADE_RESULTS {
            balance += grade.get(&tier.snake_name().to_owned()).copied().unwrap_or(0);
            descends &= balance <= 0;
        }
        if !descends || balance != 0 {
            let ladder = grade_names.join(" -> ");
            return Err(format!(
                "the grades differ ({grade:?}, engine minus block) in a shape the hit-window change \
                 cannot make: it only narrows windows, so every object it moves must move DOWN the \
                 `{ladder}` ladder, and none may be created or destroyed"
            ));
        }
        // every moved object arrives in exactly one tier, so the tiers that
        // GAINED count them once each. that is a LOWER BOUND and not a
        // census, which is why it is reported as one: an object falling
        // `ok` to `meh` beside another falling `meh` to `miss` cancels in
        // the middle and reads as the single `ok`-to-`miss` fall it is
        // indistinguishable from. the aggregate map is the whole of what a
        // block carries, so the smallest count consistent with it is the
        // honest one to print
        let moved: i64 = grade.values().filter(|delta| **delta > 0).sum();
        let plural = if moved == 1 { "object" } else { "objects" };
        explained.notes.push(format!(
            "at least {moved} {plural} graded harder than a {client_date} client's wider hit \
             windows (lazer {HIT_WINDOW_MERGE}, PR #33882)"
        ));
    }

    let cadence: std::collections::BTreeMap<&String, i64> =
        deltas.iter().filter(|(k, _)| cadence_names.contains(k)).map(|(k, v)| (k, *v)).collect();
    if !cadence.is_empty() {
        // every element scores exactly one of these whichever way it falls,
        // so a cadence difference is a reshuffle, never a gain or a loss --
        // and a reshuffle WITHIN the group its own element belongs to. the
        // display rate can turn a tracked tick into a missed one; it cannot
        // turn a tick into a TAIL, which is a different element altogether.
        // summing the groups together would let exactly that through, since
        // a `large_tick_hit: -1` cancels a `slider_tail_hit: +1` in the
        // total -- a misclassification wearing the noise floor's clothes
        for group in [TICK_CADENCE_GROUP, UNREACHED_CADENCE_GROUP] {
            let net: i64 =
                group.iter().map(|r| deltas.get(r.snake_name()).copied().unwrap_or(0)).sum();
            if net != 0 {
                let names = group.iter().map(|r| r.snake_name()).collect::<Vec<_>>().join(", ");
                return Err(format!(
                    "the cadence-decided results differ ({cadence:?}, engine minus block) by a net \
                     {net} across `{names}`, which no display rate can do -- each element scores \
                     exactly one result from its OWN group either way"
                ));
            }
        }
        let worst = cadence.values().map(|d| d.abs()).max().unwrap_or(0);
        if worst > CADENCE_NOISE_FLOOR {
            return Err(format!(
                "the cadence-decided results differ ({cadence:?}, engine minus block) by up to {worst}, \
                 past the {CADENCE_NOISE_FLOOR} this corpus has ever shown -- too big to be the \
                 sub-display-frame residual, so triage it rather than widening the floor"
            ));
        }
        explained
            .notes
            .push(format!("{cadence:?} decided by the display cadence the file does not record"));
    }
    Ok(explained)
}

/// the two conservation groups must between them be exactly the results the
/// classifier admits as cadence-decided. a result in `CADENCE_RESULTS` but in
/// neither group would be excused while conserving nothing, and one in a group
/// but not in `CADENCE_RESULTS` would be conserved while never being reached
#[test]
fn the_cadence_groups_partition_the_cadence_results() {
    let mut grouped: Vec<&str> =
        TICK_CADENCE_GROUP.iter().chain(UNREACHED_CADENCE_GROUP).map(|r| r.snake_name()).collect();
    let before = grouped.len();
    grouped.sort_unstable();
    grouped.dedup();
    assert_eq!(before, grouped.len(), "no result may sit in both groups");

    let mut admitted: Vec<&str> = CADENCE_RESULTS.iter().map(|r| r.snake_name()).collect();
    admitted.sort_unstable();
    assert_eq!(grouped, admitted, "the groups and the admitted set must be the same results");
}

/// the classifier's own boundaries, driven directly rather than through a
/// corpus that happens not to contain them: the shapes each cause CAN make,
/// the shapes it cannot, and how far each reaches into the fields folded
/// from the counts. the corpus proves the rule is satisfiable; this proves
/// it is a rule
#[test]
fn the_native_statistics_classifier_admits_exactly_what_the_two_causes_can_make() {
    let counts = |rows: &[(&str, i64)]| -> Vec<(String, i64)> {
        rows.iter().map(|(name, count)| ((*name).to_owned(), *count)).collect()
    };
    let dated = |date: Option<&str>| NativeLedgerRow {
        stem: "T000".to_owned(),
        client: "test".to_owned(),
        origin: "original".to_owned(),
        pin: "test".to_owned(),
        client_date: date.map(str::to_owned),
    };
    let before = dated(Some("2025-01-01"));
    let after = dated(Some("2026-01-01"));

    // an exact pair excuses nothing and reaches nothing
    let exact = classify_native_statistics(&counts(&[("great", 10)]), &counts(&[("great", 10)]), &before)
        .expect("an exact pair classifies");
    assert!(exact.notes.is_empty());
    assert!(!exact.combo && !exact.score && !exact.accuracy);

    // the era's own shape: one object falls out of `great` into `ok`. it
    // moves accuracy and the total, and CANNOT move combo -- both grades
    // increase it, so the run is the same length either way
    let downgrade = classify_native_statistics(
        &counts(&[("great", 9), ("ok", 1)]),
        &counts(&[("great", 10), ("ok", 0)]),
        &before,
    )
    .expect("a downgrade on a pre-merge client is the era's");
    assert_eq!(downgrade.notes.len(), 1);
    assert!(downgrade.notes[0].contains("1 object graded harder"), "{:?}", downgrade.notes);
    assert!(downgrade.score && downgrade.accuracy);
    assert!(!downgrade.combo, "`great` and `ok` both increase combo, so the run is untouched");

    // the same change one rung down the ladder, which never touches `great`
    // at all: narrowing the `ok` window does exactly this
    let lower = classify_native_statistics(
        &counts(&[("ok", 0), ("meh", 1)]),
        &counts(&[("ok", 1), ("meh", 0)]),
        &before,
    )
    .expect("an ok-to-meh move is the same narrowing one rung down");
    assert!(lower.notes[0].contains("1 object graded harder"), "{:?}", lower.notes);

    // two adjacent falls at once -- one `ok` to `meh`, one `meh` to `miss`
    // -- cancel in the middle and are indistinguishable from the single
    // `ok`-to-`miss` fall they aggregate to, so the count is reported as the
    // lower bound it is rather than as a census the block cannot support
    let cancelled = classify_native_statistics(
        &counts(&[("ok", 0), ("meh", 1), ("miss", 1)]),
        &counts(&[("ok", 1), ("meh", 1), ("miss", 0)]),
        &before,
    )
    .expect("two adjacent falls are still a narrowing");
    assert!(cancelled.notes[0].starts_with("at least 1 object"), "{:?}", cancelled.notes);

    // a fall all the way to `miss` DOES break the run, so combo follows
    let broken = classify_native_statistics(
        &counts(&[("great", 9), ("miss", 1)]),
        &counts(&[("great", 10), ("miss", 0)]),
        &before,
    )
    .expect("great-to-miss is still a narrowing");
    assert!(broken.combo, "a miss breaks the run, so `max_combo` may follow");

    // a shape needing two objects to have got BETTER. it balances to zero,
    // which is exactly why a sum over the softer grades admitted it
    let up = classify_native_statistics(
        &counts(&[("great", 0), ("ok", 3), ("meh", 0)]),
        &counts(&[("great", 1), ("ok", 0), ("meh", 2)]),
        &before,
    )
    .expect_err("no object may move UP the ladder");
    assert!(up.contains("ladder"), "{up}");

    // the era explains a pre-merge client and nothing else
    classify_native_statistics(
        &counts(&[("great", 9), ("ok", 1)]),
        &counts(&[("great", 10), ("ok", 0)]),
        &after,
    )
    .expect_err("a post-merge client has no era to blame");
    classify_native_statistics(
        &counts(&[("great", 9), ("ok", 1)]),
        &counts(&[("great", 10), ("ok", 0)]),
        &dated(None),
    )
    .expect_err("an undated client cannot be attributed to an era");

    // a bonus the cadence moved is worth POINTS and nothing else, so it may
    // excuse the total and neither the combo nor the rank
    let bonus = classify_native_statistics(
        &counts(&[("ignore_miss", 1), ("large_bonus", 0)]),
        &counts(&[("ignore_miss", 0), ("large_bonus", 1)]),
        &before,
    )
    .expect("a bonus traded against an ignore is the cadence's");
    assert!(bonus.score, "a bonus scores");
    assert!(!bonus.combo && !bonus.accuracy, "a bonus moves neither the run nor accuracy");

    // a slider tail reaches all three, being a scoring, combo-increasing,
    // accuracy-affecting result traded against one that is none of them
    let tail = classify_native_statistics(
        &counts(&[("ignore_miss", 0), ("slider_tail_hit", 1)]),
        &counts(&[("ignore_miss", 1), ("slider_tail_hit", 0)]),
        &before,
    )
    .expect("a tail traded against an ignore is the cadence's");
    assert!(tail.combo && tail.score && tail.accuracy);

    // the two causes are folded apart, so neither borrows the other's reach:
    // grades moving within `great`/`ok` and bonuses trading against an
    // `IgnoreMiss` are two differences, and combo survives both
    let both = classify_native_statistics(
        &counts(&[("great", 9), ("ok", 1), ("ignore_miss", 1), ("large_bonus", 0)]),
        &counts(&[("great", 10), ("ok", 0), ("ignore_miss", 0), ("large_bonus", 1)]),
        &before,
    )
    .expect("both causes at once still classify");
    assert_eq!(both.notes.len(), 2);
    assert!(!both.combo, "neither cause crosses a combo class, so pooling them must not either");

    // a cadence difference that does not net to zero is a gain or a loss,
    // which no display rate can produce
    classify_native_statistics(
        &counts(&[("slider_tail_hit", 1)]),
        &counts(&[("slider_tail_hit", 0)]),
        &before,
    )
    .expect_err("the cadence reshuffles elements, it never creates them");

    // nor one that nets to zero only by trading ACROSS groups: a tick may
    // become a missed tick, but it may never become a tail. the total is
    // zero here, so only the per-group balance catches it
    let across = classify_native_statistics(
        &counts(&[("large_tick_hit", 0), ("slider_tail_hit", 1)]),
        &counts(&[("large_tick_hit", 1), ("slider_tail_hit", 0)]),
        &before,
    )
    .expect_err("a tick may not turn into a tail");
    assert!(across.contains("OWN group"), "{across}");

    // a tick trading against a MISSED tick is the shape the cadence can make
    classify_native_statistics(
        &counts(&[("large_tick_hit", 0), ("large_tick_miss", 1)]),
        &counts(&[("large_tick_hit", 1), ("large_tick_miss", 0)]),
        &before,
    )
    .expect("a tick trades with a missed tick, which is its own group");

    // and one past the observed floor comes back for review
    let over = CADENCE_NOISE_FLOOR + 1;
    classify_native_statistics(
        &counts(&[("ignore_miss", over), ("slider_tail_hit", 0)]),
        &counts(&[("ignore_miss", 0), ("slider_tail_hit", over)]),
        &before,
    )
    .expect_err("past the noise floor is a finding, not a residual");

    // a result neither cause touches fails whatever its size
    classify_native_statistics(&counts(&[("small_tick_hit", 1)]), &counts(&[("small_tick_hit", 0)]), &before)
        .expect_err("an unexplained result class fails");
}

/// one fixture's expected drain-rate search products, as the python model in
/// `.scratch/stable-osr-writer/hp-harness/` derived them (its `results.md`
/// search table, final run). the model is a line-level port of the same
/// client routine, so these compare EXACTLY -- the multipliers are products
/// of the same literals applied in the same order, and the rate a chain of
/// the same two factors. a fixture that differs is a port finding to report
/// with both values, never a tolerance to widen
struct SearchExpectation {
    stem: &'static str,
    rate: f64,
    normal: f64,
    combo_end: f64,
    iterations: u32,
}

const SEARCH_EXPECTATIONS: &[SearchExpectation] = &[
    SearchExpectation { stem: "L002---akitsuki-fuuka-cv-lynn---fai", rate: 0.046_079_999_999_999_996, normal: 1.01, combo_end: 1.02, iterations: 3 },
    SearchExpectation { stem: "L020---aqours---miracle-wave-tv-siz", rate: 0.040_768_634_879_999_99, normal: 1.030_301, combo_end: 1.061_208, iterations: 6 },
    SearchExpectation { stem: "L022---ata---euphoria-gate-guardian", rate: 0.046_079_999_999_999_996, normal: 1.020_1, combo_end: 1.040_4, iterations: 3 },
    SearchExpectation { stem: "L027---eden---circles-circumference", rate: 0.022_100_121_693_970_375, normal: 1.0, combo_end: 1.0, iterations: 21 },
    SearchExpectation { stem: "L029---bish---futari-nara-tv-size-s", rate: 0.042_467_327_999_999_99, normal: 1.040_604_01, combo_end: 1.082_432_16, iterations: 5 },
    SearchExpectation { stem: "L033---cosmobousou-p---denpa-shoujo", rate: 0.033_241_631_799_575_04, normal: 1.0, combo_end: 1.0, iterations: 11 },
    SearchExpectation { stem: "L034---chico-with-honeyworks---colo", rate: 0.031_911_966_527_592_04, normal: 1.0, combo_end: 1.0, iterations: 12 },
    SearchExpectation { stem: "L048---peppy---offset-wizard---2022", rate: 0.003_667_152_062_798_086, normal: 1.172_578_644_923_698_6, combo_end: 1.372_785_705_090_612_5, iterations: 65 },
    SearchExpectation { stem: "L049---days-n-daze---misanthropic-d", rate: 0.022_100_121_693_970_375, normal: 1.0, combo_end: 1.0, iterations: 21 },
    SearchExpectation { stem: "L140---lisa---believe-in-ourselves", rate: 0.012_695_836_807_768_956, normal: 1.051_010_050_1, combo_end: 1.051_010_050_1, iterations: 32 },
    SearchExpectation { stem: "L200---kessoku-band-guitar-to-k", rate: 0.018_019_835_842_900_9, normal: 1.0, combo_end: 1.0, iterations: 26 },
    SearchExpectation { stem: "L201---chico-with-honeyworks-ko", rate: 0.044_236_799_999_999_99, normal: 1.030_301, combo_end: 1.061_208, iterations: 4 },
    SearchExpectation { stem: "L202---wolpis-kater---toki-no-ame", rate: 0.015_305_085_584_932_578, normal: 1.0, combo_end: 1.0, iterations: 30 },
    SearchExpectation { stem: "L203---44000---pumpmycrunkbeetz", rate: 0.033_241_631_799_575_04, normal: 1.0, combo_end: 1.0, iterations: 11 },
    SearchExpectation { stem: "L204---cro-magnons---totsugeki-rock", rate: 0.037_572_373_905_407_984, normal: 1.01, combo_end: 1.02, iterations: 8 },
    SearchExpectation { stem: "L205---44000---pumpmycrunkbeetz", rate: 0.033_241_631_799_575_04, normal: 1.0, combo_end: 1.0, iterations: 11 },
    SearchExpectation { stem: "L206---shinigiwa-satellite---nenten", rate: 0.044_236_799_999_999_99, normal: 1.030_301, combo_end: 1.061_208, iterations: 4 },
    SearchExpectation { stem: "L207---project-grimoire---aenbharr", rate: 0.023_980_166_768_631_05, normal: 1.0, combo_end: 1.0, iterations: 19 },
];

/// the drain-rate search over the same corpus: a port check against the
/// harness's own numbers, one level below the header curve (which is the
/// life bar's oracle). also cross-checks the search's map max combo -- the
/// value stable's `perfect` flag is decided from -- against
/// `max_achievable_combo`, which counts the same thing off lazer's nested
/// list; the two are derived from different lists and a disagreement is a
/// finding, not something to reconcile here
#[test]
fn local_corpus_drain_rate_search_matches_the_harness() {
    let dir = fixture_util::fixtures_dir().join("replays/local");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("corpus: {dir:?} missing, skipping");
        return;
    };

    let mut checked = 0;
    let mut failures: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("osu") {
            continue;
        }
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        if !path.with_extension("osr").exists() {
            continue;
        }
        seen.push(name.clone());

        let map = decode_beatmap_path(&path).unwrap_or_else(|e| panic!("{name}: beatmap: {e}"));
        let processed = process_beatmap(&map).unwrap_or_else(|e| panic!("{name}: process: {e}"));
        let search = drain_rate_search(&processed, &ScoreContext::from_beatmap(&map));

        if !search.converged {
            failures.push(format!(
                "{name}: the search did not converge in {} passes",
                search.iterations
            ));
            continue;
        }
        let achievable = max_achievable_combo(&processed);
        if search.max_combo != achievable {
            failures.push(format!(
                "{name}: the search counts max combo {} where max_achievable_combo counts {achievable} \
                 -- the two read different lists, so this is a finding to file, not a number to patch",
                search.max_combo
            ));
        }
        assert_eq!(
            search.hp_after_perfect_play.len(),
            processed.objects.len(),
            "{name}: the perfect-play vector covers every object"
        );

        let Some(expected) = SEARCH_EXPECTATIONS.iter().find(|e| e.stem == name) else {
            eprintln!("corpus: {name}: no recorded search expectation, checked for convergence only");
            continue;
        };
        let got = (search.rate, search.normal_multiplier, search.combo_end_multiplier, search.iterations);
        let want = (expected.rate, expected.normal, expected.combo_end, expected.iterations);
        if got != want {
            failures.push(format!(
                "{name}: search products {got:?} differ from the harness's {want:?}"
            ));
            continue;
        }
        checked += 1;
    }

    for entry in SEARCH_EXPECTATIONS {
        if !seen.iter().any(|s| s == entry.stem) {
            eprintln!(
                "corpus NOTICE: search expectation {} has no pair in this corpus -- unverified this run",
                entry.stem
            );
        }
    }
    for failure in &failures {
        eprintln!("corpus FAIL: {failure}");
    }
    assert!(failures.is_empty(), "{} corpus maps disagree (list above)", failures.len());
    eprintln!("corpus: {checked} drain-rate searches match the harness exactly");
}

/// a ratified life-bar sample divergence: one header sample this engine
/// reproduces at a different value, recorded exactly like the derived-field
/// ledger above and enforced in both directions -- a drifted simulated value
/// is new behaviour hiding behind an old record, and an entry that no longer
/// reproduces is a stale one
struct RatifiedSampleDivergence {
    stem: &'static str,
    /// the header sample's own recorded time, which is the key
    header_time: i64,
    header_value: &'static str,
    simulated_value: &'static str,
    mechanism: &'static str,
    record: &'static str,
}

const RATIFIED_SAMPLE_DIVERGENCES: &[RatifiedSampleDivergence] = &[RatifiedSampleDivergence {
    stem: "L203---44000---pumpmycrunkbeetz",
    header_time: 24_672,
    header_value: "0.71",
    simulated_value: "0.69",
    mechanism: "the same katu-versus-mu placement the derived-field ledger records for this stem: the \
            header awarded a katu over objects 93-98 that no counter rule derives, and the 4 HP \
            between a katu (10C) and a mu (6C) addition is 0.02 at two decimals. the HP model is \
            consistent with the header GIVEN that katu, so this is the same open grade-placement \
            residual seen through a second signal, not a health bug",
    record: "accepted 2026-09-05 bounded-pass decision; docs/engine-parity.md (L203); harness residual 2 \
            in .scratch/stable-osr-writer/hp-harness/results.md",
}];

/// the life bar half of the corpus oracle: every header sample compared
/// against the value of the NEAREST simulated sample by time.
///
/// never bytes and never times. the header's sample times are wall-clock
/// artifacts of a ~2 second real-time timer and cannot be derived from the
/// beatmap or the replay, so the only thing with meaning is the value, and
/// the curve has no value at an arbitrary time (each sample's divisor is its
/// own object's perfect-play HP). the time offset is reported and never
/// asserted: six slider aggregates across this corpus sit 6-14 ms after the
/// header's time because stable judged them one frame earlier -- an engine
/// end-time provenance question, not a health one -- and they still match on
/// value
#[test]
fn local_corpus_life_bar_samples_match_the_headers() {
    let dir = fixture_util::fixtures_dir().join("replays/local");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("corpus: {dir:?} missing, skipping");
        return;
    };

    let mut failures: Vec<String> = Vec::new();
    let mut ratified_hits: Vec<(&str, i64)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let (mut total_header, mut total_exact) = (0usize, 0usize);
    let (mut dt_zero, mut dt_max) = (0usize, 0f64);
    let (mut byte_identical, mut graphs_compared) = (0usize, 0usize);

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("osr") {
            continue;
        }
        let name = path.file_stem().unwrap().to_string_lossy().into_owned();
        let osu_path = path.with_extension("osu");
        if !osu_path.exists() {
            continue;
        }
        let Ok(osr) = decode_osr(&std::fs::read(&path).unwrap()) else {
            continue;
        };
        if osr.header.mods != 0 {
            continue;
        }
        let Some(graph) = osr.header.life_graph.as_deref().filter(|g| !g.is_empty()) else {
            // a lazer-written replay leaves it empty -- nothing to oracle
            eprintln!("corpus: {name}: no life bar graph in the header, skipping");
            continue;
        };
        seen.push(name.clone());

        let map = decode_beatmap_path(&osu_path).unwrap_or_else(|e| panic!("{name}: beatmap: {e}"));
        let processed = process_beatmap(&map).unwrap_or_else(|e| panic!("{name}: process: {e}"));
        let frames = convert_frames(&osr.actions, map.format_version);
        let configuration = resolve_play_configuration(&osr, false);
        let timeline =
            simulate(&processed, &frames, &configuration).unwrap_or_else(|e| panic!("{name}: simulate: {e}"));
        let curve = derive_health(&processed, &timeline, &ScoreContext::from_beatmap(&map));
        if !curve.search.converged {
            failures.push(format!("{name}: the drain-rate search did not converge"));
            continue;
        }
        if curve.samples.is_empty() {
            failures.push(format!("{name}: the fold produced no samples"));
            continue;
        }

        // the curve oracle: a life bar sample is a READING of the continuous
        // HP curve, never a second derivation. evaluating the curve at each
        // sample's own millisecond and dividing by that object's
        // perfect-play divisor must reproduce the sample through the
        // writer's own rounding -- if it does not, the HP bar and the
        // header's graph are describing different plays
        let sampling: Vec<&JudgementEvent> = timeline
            .events
            .iter()
            .filter(|e| {
                matches!(
                    e.kind,
                    JudgementKind::Circle(_)
                        | JudgementKind::SliderAggregate(_)
                        | JudgementKind::SpinnerFinal(_)
                )
            })
            .collect();
        if sampling.len() == curve.samples.len() {
            for (sample, event) in curve.samples.iter().zip(&sampling) {
                let Some(read) = curve.life_bar_value_at(f64::from(sample.time), event.object_index) else {
                    continue;
                };
                if format_graph_number(read) != format_graph_number(sample.value) {
                    failures.push(format!(
                        "{name}: the curve reads {} at t={} where the sample records {}",
                        format_graph_number(read),
                        sample.time,
                        format_graph_number(sample.value)
                    ));
                }
            }
        } else {
            failures.push(format!(
                "{name}: {} object-level judgements against {} life bar samples -- the curve cannot be \
                 paired with them",
                sampling.len(),
                curve.samples.len()
            ));
        }

        // the whole comparison procedure is engine code (`compare_life_bar_graph`):
        // the parse, the truncation at a failed header's first zero, the
        // nearest-sample-by-time rule with its first-wins tie, and the
        // writer's own formatting. this test owns only the ledger, the time
        // offset reporting and the figure
        let comparison = compare_life_bar_graph(graph, &curve.samples);
        if comparison.malformed > 0 {
            failures.push(format!(
                "{name}: {} header life bar pairs could not be read",
                comparison.malformed
            ));
        }
        if comparison.header_failed {
            eprintln!(
                "corpus: {name}: header ends at a fail; comparing its first {} samples only",
                comparison.total()
            );
        }

        for pair in &comparison.pairs {
            let (time, value) = (pair.header_time, pair.header_value);
            let dt = pair.offset().unwrap_or(f64::NAN);
            if dt == 0.0 {
                dt_zero += 1;
            }
            dt_max = dt_max.max(dt);

            let simulated = pair.nearest.as_ref().map_or("<none>", |n| n.value.as_str());
            if pair.matches() {
                if let Some(r) = RATIFIED_SAMPLE_DIVERGENCES
                    .iter()
                    .find(|r| r.stem == name && r.header_time == time)
                {
                    failures.push(format!(
                        "{name}: the ratified sample divergence at t={time} (header {}, simulated {}) no \
                         longer reproduces -- the ledger entry is stale; review it: {}",
                        r.header_value, r.simulated_value, r.record
                    ));
                }
                continue;
            }
            match RATIFIED_SAMPLE_DIVERGENCES
                .iter()
                .find(|r| r.stem == name && r.header_time == time)
            {
                Some(r) if r.header_value == value && r.simulated_value == simulated => {
                    ratified_hits.push((r.stem, r.header_time));
                }
                Some(r) => failures.push(format!(
                    "{name}: the sample at t={time} reads header {value} / simulated {simulated}, not the \
                     ratified header {} / simulated {} -- new behaviour is hiding behind the record; \
                     review it: {}",
                    r.header_value, r.simulated_value, r.record
                )),
                None => failures.push(format!(
                    "{name}: header sample t={time} reads {value}, simulated {simulated} (dt {dt})"
                )),
            }
        }
        let exact = comparison.matched;
        total_header += comparison.total();
        total_exact += exact;

        // INFORMATIONAL, never asserted: whether the whole regenerated
        // string equals the header's byte for byte. it cannot be a
        // requirement -- the header's sample times are wall-clock artifacts
        // of a real-time timer and are not derivable from the beatmap or
        // the replay -- so this only reports how close the thinning gate
        // lands. the fixtures that differ are the known slider-aggregate
        // frame residual, whose sample sits 6-14 ms from the header's
        let regenerated = life_bar_graph(&curve.samples);
        if regenerated == graph {
            byte_identical += 1;
        }
        graphs_compared += 1;
        eprintln!(
            "corpus: {name}: {exact}/{} header samples exact ({} simulated samples), regenerated string \
             {} the header's",
            comparison.total(),
            curve.samples.len(),
            if regenerated == graph { "equals" } else { "differs from" }
        );
    }

    for entry in RATIFIED_SAMPLE_DIVERGENCES {
        if !seen.iter().any(|s| s == entry.stem) {
            eprintln!(
                "corpus NOTICE: ratified sample divergence {} t={} has no pair in this corpus -- \
                 unverified this run",
                entry.stem, entry.header_time
            );
        } else if !ratified_hits.contains(&(entry.stem, entry.header_time)) {
            failures.push(format!(
                "{}: the ratified sample divergence at t={} never fired -- its header time is no longer \
                 a header sample, so the entry is stale; review it: {}",
                entry.stem, entry.header_time, entry.record
            ));
        }
    }
    for (stem, time) in &ratified_hits {
        let entry = RATIFIED_SAMPLE_DIVERGENCES
            .iter()
            .find(|r| r.stem == *stem && r.header_time == *time)
            .expect("hits come from the ledger");
        eprintln!(
            "corpus: {stem}: ratified sample divergence stands at t={time} (header {}, simulated {}; {}; {})",
            entry.header_value, entry.simulated_value, entry.mechanism, entry.record
        );
    }
    for failure in &failures {
        eprintln!("corpus FAIL: {failure}");
    }
    assert!(
        failures.is_empty(),
        "{} life bar sample comparisons diverge (list above)",
        failures.len()
    );
    eprintln!(
        "corpus: {total_exact}/{total_header} header life bar samples exact ({} ratified), |dt| zero on \
         {dt_zero}, max {dt_max}; {byte_identical}/{graphs_compared} regenerated strings byte-identical \
         to the header's (informational)",
        ratified_hits.len()
    );
}

/// committed stand-in for the corpus: a synthetic replay that full-combos the
/// slider-zoo fixture map (`beatmaps/slider-zoo-v14.osu`), with hand-derivable
/// totals. exercises decode -> process -> simulate end to end on every ci run
///
/// precondition check (plan defect a7): the fixture map's five sliders start
/// at 1000/4000/8000/12000/15000ms and the smallest end-to-start gap is
/// 13500 -> 15000 = 1500ms, dwarfing every window that could let one
/// object's auto-judgement interfere with an adjacent one -- the od7 meh
/// window (129.5ms, from `windows.meh` in the fixture dump), the tail
/// leniency window (36ms) and the note-lock shake leniency (3ms). the
/// originally-considered `stacking-v14.osu` fails this same check: its od8.3
/// meh window is 115.5ms (`difficulty_range(8.3, 200, 150, 100).floor() -
/// 0.5` = `150 - 10*(8.3-5)` truncated to 116, minus 0.5), while its circles
/// sit only 100ms apart (1000/1100/1200, 2400/2500, 3400/3500) --
/// `2 * 115.5 = 231 > 100`, so consecutive hit windows genuinely overlap
/// there. `spinners-combos-od10.osu` has spinners, which this test's frame
/// builder does not drive; `old-format-v4.osu`'s od6 meh window (139.5ms)
/// overlaps its own 100ms circle gaps the same way; `v7-tick-multiplier.osu`
/// has only one object, so "consecutive" is vacuous and it is not the map
/// this test's derivation was written against. slider-zoo-v14 is therefore
/// both the correctly-named and the only comfortably non-overlapping choice
#[test]
fn synthetic_full_combo_on_the_fixture_map() {
    let map = decode_beatmap_path(&fixture_util::fixtures_dir().join("beatmaps/slider-zoo-v14.osu")).unwrap();
    let processed = process_beatmap(&map).unwrap();

    // build frames that press exactly on every object's stacked position at
    // its start time (alternating buttons to sidestep the slider key
    // restriction), track every slider ball sampled at 10ms steps, and idle
    // otherwise. the map has no circles or spinners by construction -- every
    // object is a slider
    let frames = engine_test_helpers::full_combo_frames(&processed);
    let timeline = simulate(&processed, &frames, &PlayConfiguration::nomod(RulesProfile::Stable)).unwrap();

    let expected_basics = processed.objects.len() as u32;
    assert_eq!(timeline.totals.count_300, expected_basics, "everything greats");
    assert_eq!(timeline.totals.count_miss, 0);
    // a full combo of greats is full accuracy and lazer's X, the engine's
    // own answer for what the panel used to compute from the counts
    assert_eq!(timeline.totals.accuracy, 1.0);
    assert_eq!(timeline.totals.rank, engine::score::ScoreRank::X);

    // stable max combo: circles 1 each; sliders head + ticks + repeats + tail.
    // for this map (five sliders, no circles) the per-object nested counts
    // are 10, 2, 2, 11, 3 -- sum 28 (slider 1: head + 6 ticks + 2 repeats +
    // tail; sliders 2 and 3: head + tail only, span_count 1 and, for slider
    // 3, ticks disabled by the 8000,nan inherited timing point; slider 4:
    // head + 8 ticks + 1 repeat + tail; slider 5: head + 1 tick + tail)
    let expected_max_combo: u32 = processed
        .objects
        .iter()
        .map(|o| match &o.kind {
            engine::beatmap::ProcessedKind::Slider(s) => s.nested.len() as u32,
            _ => 1,
        })
        .sum();
    assert_eq!(timeline.totals.max_combo, expected_max_combo);

    // a full combo of nothing but greats makes every section geki, so the
    // committed path also exercises the corpus's derived-field assertions
    let tally = section_tally(&processed, &timeline);
    assert_eq!(
        (tally.count_geki, tally.count_katsu, tally.sections_without_burst),
        (tally.sections, 0, 0),
        "an all-great full combo is all geki"
    );

    // and the achieved total on this spinner-free full combo is lazer's
    // dumped theoretical maximum PLUS stable's tail-adjacent-tick surplus
    // (engine parity issue 15): stable values a judged slider point by how
    // many points are due at that moment, so a final tick at or past the
    // -36ms tail point scores 30 rather than 10 -- a term lazer's own
    // simulator does not model and stable headers demand. the surplus is
    // computed from the same valuation the fold uses and pinned to the one
    // slider on this map carrying the shape, so a fixture change that adds
    // or removes the shape fails loudly instead of shifting the total
    let surplus = fixture_util::stable_tick_surplus(&processed);
    assert_eq!(surplus, 20, "exactly one tail-adjacent tick on slider-zoo-v14");

    let dump: fixture_util::LegacyScoreAttributesDump =
        fixture_util::load_json("score/legacy_score_attributes.json");
    let attributes = dump
        .maps
        .iter()
        .find(|m| m.name == "slider-zoo-v14")
        .expect("the score dump family covers the fixture maps");
    let stars = peppy_stars(&ScoreContext::from_beatmap(&map)).unwrap();
    assert_eq!(
        total_score(&timeline, &processed, stars, NOMOD_SCORE_MULTIPLIER),
        attributes.accuracy_score + attributes.combo_score + surplus,
        "simulated full-combo total matches lazer's dumped attributes plus stable's surplus"
    );
    // and the running walk the HUD reads ends on that same total, over a
    // committed decode -> process -> simulate -> score_curve pass with no
    // local corpus needed
    fixture_util::score_curve_ends_on_the_total(&timeline, &processed, stars).unwrap();

    // the health curve on the same clean play: a full combo tracks the
    // perfect play the search simulated, so every recorded sample is the
    // ceiling. this is the committed check that decode -> process ->
    // simulate -> derive_health runs end to end with no local corpus
    let curve = derive_health(&processed, &timeline, &ScoreContext::from_beatmap(&map));
    assert!(curve.search.converged);
    assert_eq!(
        curve.samples.len(),
        processed.objects.len(),
        "one sample per object-level judgement, and this map is all sliders"
    );
    for sample in &curve.samples {
        assert_eq!(
            format_graph_number(sample.value),
            "1",
            "a full combo never falls below the perfect curve (sample at {})",
            sample.time
        );
    }

    // and the continuous curve under those samples, on the same committed
    // path: it starts full, every jump it carries sits at a judgement's own
    // millisecond, and it never reads below the perfect-play divisor where a
    // sample was taken -- which is the curve's half of "a full combo tracks
    // the perfect play"
    assert_eq!(curve.points.first().map(|p| p.fraction), Some(1.0), "HP starts full");
    assert!(
        curve.points.windows(2).all(|pair| pair[0].time <= pair[1].time),
        "the breakpoints are in time order"
    );
    for pair in curve.points.windows(2) {
        if pair[0].time == pair[1].time {
            assert!(
                timeline.events.iter().any(|e| e.time == pair[0].time),
                "a jump at {} belongs to no judgement",
                pair[0].time
            );
        }
    }
    // reading the curve at a sample's own millisecond reproduces that
    // sample: on this full combo every reading is the ceiling, so the curve
    // never falls under the perfect play the search simulated. the reading
    // is compared through the writer's rounding, which is the only precision
    // a life bar value has -- the raw ratio sits a hair under 1 on two of
    // these objects, because the fold drains to each judgement's own
    // millisecond while the perfect pass drains object to object
    for (index, sample) in curve.samples.iter().enumerate() {
        let read = curve
            .life_bar_value_at(f64::from(sample.time), index)
            .expect("every object on this map has a live divisor");
        assert_eq!(
            format_graph_number(read),
            format_graph_number(sample.value),
            "the curve and the sample for object {index} disagree"
        );
        assert_eq!(format_graph_number(read), "1");
    }
}

/// shared test-only frame builder for the synthetic full-combo test above
mod engine_test_helpers {
    use engine::beatmap::{ProcessedBeatmap, ProcessedKind};
    use engine::math::Vec2;
    use engine::replay::frames::{Buttons, ReplayFrame};

    /// walks `processed.objects` in order and builds a replay that hits
    /// everything: circles get an idle approach frame then a press on their
    /// stacked position; sliders get a press on the head followed by frames
    /// every 10ms tracing `stacked_position + curve_position_at(progress)`
    /// through `end_time`, holding one button the whole way, then a release
    /// 20ms later. buttons alternate left/right per object so the slider
    /// key-restriction (sliderinputmanager.cs:31-44) never has a chance to
    /// engage across adjacent objects. every time is rounded onto the whole
    /// millisecond a real replay frame is confined to
    pub fn full_combo_frames(processed: &ProcessedBeatmap) -> Vec<ReplayFrame> {
        let mut frames = Vec::new();
        for (i, obj) in processed.objects.iter().enumerate() {
            let button = if i % 2 == 0 {
                Buttons::LEFT_1
            } else {
                Buttons::RIGHT_1
            };
            match &obj.kind {
                ProcessedKind::Circle => {
                    frames.push(idle(obj.start_time - 200.0, obj.stacked_position));
                    frames.push(press(obj.start_time, obj.stacked_position, button));
                    frames.push(idle(obj.start_time + 10.0, obj.stacked_position));
                }
                ProcessedKind::Slider(s) => {
                    let mut t = obj.start_time;
                    while t < obj.end_time {
                        let progress = ((t - obj.start_time) / s.duration).clamp(0.0, 1.0);
                        let pos = obj.stacked_position + s.curve_position_at(progress);
                        frames.push(press(t.round(), pos, button));
                        t += 10.0;
                    }
                    let tail_pos = obj.stacked_position + s.curve_position_at(1.0);
                    frames.push(press(obj.end_time.round(), tail_pos, button));
                    frames.push(idle((obj.end_time + 20.0).round(), tail_pos));
                }
                ProcessedKind::Spinner(_) => {
                    unreachable!("the fixture map this helper is built for has no spinners")
                }
            }
        }
        frames
    }

    fn press(time: f64, pos: Vec2, button: u32) -> ReplayFrame {
        ReplayFrame {
            time,
            pos,
            buttons: Buttons::new(button),
        }
    }

    fn idle(time: f64, pos: Vec2) -> ReplayFrame {
        ReplayFrame {
            time,
            pos,
            buttons: Buttons::new(0),
        }
    }
}
