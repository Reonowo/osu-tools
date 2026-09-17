//! dump_native_timeline: the native counterpart to `diagnose_replay`, which
//! is a stable-profile instrument through and through (its section tally,
//! peppy stars and eight header comparisons are all stable's own views, and
//! on a lazer-written play they describe nothing).
//!
//! this dumps ONE lazer-native play's judgement timeline as json in the same
//! shape `tools/fixture-gen`'s replay re-run writes, so the engine's walk and
//! the pinned client's own gameplay can be diffed element by element. that
//! diff is the only thing that separates an engine bug from lazer's gameplay
//! having changed since the client that wrote the file: the file's score-info
//! block is one party, this is the second, and the re-run is the third.
//!
//! usage (from `src-tauri/`):
//!
//!   cargo run -p engine --release --example dump_native_timeline -- \
//!       <map.osu> <replay.osr> <out.json>
//!
//! like the sweep and the triage instrument this is an example, never a
//! test: ci never sees it, and it exits 0 with its dump as the output.

use std::path::PathBuf;

use engine::configuration::{resolve_play_configuration, RulesProfile};
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::osr::decode_osr;
use engine::replay::frames::convert_frames;
use engine::score::HitResult;
use engine::simulation::score::JudgementKind;
use engine::simulation::simulate_native;

fn main() {
    let mut args = std::env::args().skip(1);
    let map_path = args.next().map(PathBuf::from).unwrap_or_else(|| usage("no map given"));
    let replay_path = args.next().map(PathBuf::from).unwrap_or_else(|| usage("no replay given"));
    let out_path = args.next().map(PathBuf::from).unwrap_or_else(|| usage("no output path given"));

    let map = decode_beatmap_path(&map_path).expect("decode beatmap");
    let processed = engine::beatmap::process_beatmap(&map).expect("process beatmap");
    let osr = decode_osr(&std::fs::read(&replay_path).expect("read replay")).expect("decode replay");

    // the walk is chosen explicitly rather than through `simulate`: this
    // instrument has nothing to say about a stable play, and silently
    // dumping a stable timeline under a native-shaped key would be a worse
    // answer than refusing
    let configuration = resolve_play_configuration(&osr, false);
    if configuration.profile != RulesProfile::Native {
        eprintln!(
            "{}: a {:?}-profile play has no native timeline to dump; use diagnose_replay instead",
            replay_path.display(),
            configuration.profile
        );
        std::process::exit(2);
    }
    // the mods gate, which the profile check above cannot stand in for: the
    // profile is selected by the header version and NEVER by the mods
    // (`configuration`'s module doc), so a HardRock or Classic play is a
    // native one too -- and `simulate_native` takes the map and the frames
    // alone, so dumping one would quietly describe a NoMod play on an
    // unmodified map while the re-run it is diffed against applies the mods
    // the file names. that is a worse answer than refusing, on exactly the
    // grounds the profile check refuses a stable play. the resolver has
    // already decided this; read its answer rather than inventing a second
    if !configuration.is_authoritative() {
        eprintln!(
            "{}: the resolver will not simulate this play authoritatively ({:?}), so it has no \
             native timeline to dump",
            replay_path.display(),
            configuration.capabilities.simulate
        );
        std::process::exit(2);
    }

    let frames = convert_frames(&osr.actions, map.format_version);
    let timeline = simulate_native(&processed, &frames).expect("simulate natively");
    let native = timeline.native.as_ref().expect("the native walk carries its outcome");

    // every applied result in fold order, joined to the timeline event it
    // produced. walking `applied` rather than `events` is what keeps the
    // event-less results visible -- a spinner's unreached ticks arrive as one
    // record standing for `count` of them -- so the dump accounts for every
    // result behind the statistics map rather than only the ones that drew
    let mut rows = Vec::new();
    for applied in &native.applied {
        let event = applied.event_index.map(|i| &timeline.events[i]);
        let (object_index, kind, nested_index, combo_after) = match event {
            Some(event) => {
                let (kind, nested) = describe(&event.kind);
                (Some(event.object_index), kind, nested, Some(event.combo_after))
            }
            None => (None, "unreached", None, None),
        };
        rows.push(serde_json::json!({
            "object_index": object_index,
            "nested_index": nested_index,
            "kind": kind,
            "result": applied.result.snake_name(),
            "max_result": applied.max_result.snake_name(),
            "count": applied.count,
            "time": applied.time,
            "combo_after": combo_after,
        }));
    }

    let counts = |pairs: &[(HitResult, u32)]| -> serde_json::Value {
        serde_json::Value::Object(
            pairs
                .iter()
                .map(|(result, count)| (result.snake_name().to_owned(), serde_json::json!(count)))
                .collect(),
        )
    };

    let payload = serde_json::json!({
        "map": map_path.file_name().map(|n| n.to_string_lossy().into_owned()),
        "replay": replay_path.file_name().map(|n| n.to_string_lossy().into_owned()),
        "frame_count": frames.len(),
        "engine": {
            "statistics": counts(&native.statistics),
            "maximum_statistics": counts(&native.maximum_statistics),
            "max_combo": timeline.totals.max_combo,
            "total_score": native.total_score,
            "accuracy": timeline.totals.accuracy,
            "rank": format!("{:?}", timeline.totals.rank),
            "applied": rows,
        },
    });

    std::fs::write(&out_path, serde_json::to_vec_pretty(&payload).expect("serialize")).expect("write dump");
    println!(
        "native timeline: {} -> {} ({} applied results, max combo {}, total {})",
        replay_path.display(),
        out_path.display(),
        native.applied.len(),
        timeline.totals.max_combo,
        native.total_score
    );
}

/// the element a timeline kind stands for, spelled so the rows key the same
/// way the re-run's do: one name per element class, with the slider's own
/// nested ordinal where the kind carries it (a head and a tail are unique
/// per slider, so neither needs one to be identified)
fn describe(kind: &JudgementKind) -> (&'static str, Option<u32>) {
    match kind {
        JudgementKind::Circle(_) => ("circle", None),
        JudgementKind::SliderHead { .. } => ("slider_head", None),
        JudgementKind::SliderTick { nested_index, .. } => ("slider_tick", *nested_index),
        JudgementKind::SliderRepeat { nested_index, .. } => ("slider_repeat", *nested_index),
        JudgementKind::SliderTail { nested_index, .. } => ("slider_tail", *nested_index),
        JudgementKind::SliderEnd { .. } => ("slider_end", None),
        JudgementKind::SliderAggregate(_) => ("slider_aggregate", None),
        JudgementKind::SpinnerSpin => ("spinner_spin", None),
        JudgementKind::SpinnerBonus => ("spinner_bonus", None),
        JudgementKind::SpinnerFinal(_) => ("spinner_final", None),
    }
}

fn usage(complaint: &str) -> ! {
    eprintln!("dump_native_timeline: {complaint}");
    eprintln!("usage: dump_native_timeline <map.osu> <replay.osr> <out.json>");
    std::process::exit(2);
}
