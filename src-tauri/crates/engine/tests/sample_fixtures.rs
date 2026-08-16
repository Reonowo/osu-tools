//! hit sample RESOLUTION against lazer's own decoded beatmaps: which sound
//! each object and each nested object asks for, as a skin-independent
//! (bank, name, suffix, volume, layered) lookup plus the ordered lookup names
//! it resolves through.
//!
//! this family pins resolution and nothing else. which sample fires off which
//! judgement, and when, is this app's own composition with no lazer analogue
//! to dump; that half is covered by frontend tests over a synthetic judgement
//! timeline. nobody should read "hitsounds are fixture-covered" as covering
//! the scheduler.

mod fixture_util;

use engine::beatmap::process_beatmap;
use engine::formats::beatmap::decode_beatmap_path;
use engine::formats::samples::HitSample;
use engine::render_plan::{build_render_plan, RenderKind, RenderNestedKind, RenderSample};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct SampleMapDump {
    objects: Vec<ObjectDump>,
}

#[derive(Debug, Deserialize)]
struct ObjectDump {
    kind: String,
    start_time: f64,
    samples: Vec<SampleDump>,
    node_samples: Option<Vec<Vec<SampleDump>>>,
    nested: Option<Vec<NestedDump>>,
}

#[derive(Debug, Deserialize)]
struct NestedDump {
    kind: String,
    span_index: i32,
    time: f64,
    samples: Vec<SampleDump>,
}

/// lazer's `HitSampleInfo` fields verbatim. `suffix` is a string there (it is
/// pasted straight into a filename), so it stays one here and is parsed on
/// comparison rather than being reinterpreted at load
#[derive(Debug, Deserialize, PartialEq)]
struct SampleDump {
    bank: String,
    name: String,
    suffix: Option<String>,
    volume: i32,
    is_layered: bool,
    filename: Option<String>,
    lookup_names: Vec<String>,
}

const MAPS: &[&str] = &[
    "samples-banks-v14",
    "samples-nodes-v14",
    "samples-sampleset-none-v14",
];

/// the `(map, object index)` sliders whose OWN samples resolve differently in
/// the wrapped decoder than in lazer's, because they cross a sample point --
/// the documented rosu-map divergence, recorded in TODO.md and in
/// `formats::beatmap::convert_samples`.
///
/// deliberately a closed list rather than "every slider": the divergence needs
/// a sample point INSIDE the slider, so every other slider agrees exactly and
/// stays pinned. the test asserts this list EXACTLY -- a slider that starts
/// diverging is a finding rather than a fixture to bless, and one that stops
/// means the divergence closed and the exemption should go with it
struct DivergentSlider {
    map: &'static str,
    index: usize,
    /// what the engine resolves this slider's own samples to, as
    /// `(bank, suffix, volume)` per sample -- the three fields the divergence
    /// can move. pinned to the CURRENT values so the exemption cannot quietly
    /// absorb a third answer: everything else about these samples is still
    /// asserted equal to lazer's dump
    resolved: &'static [(&'static str, Option<&'static str>, i32)],
}

const DIVERGENT_SLIDERS: &[DivergentSlider] = &[
    // @3000, 140 long: runs past the 3200 sample point, so its hitnormal and
    // its finish both take that point's drum/40 instead of the normal/100 in
    // force where the slider starts
    DivergentSlider {
        map: "samples-nodes-v14",
        index: 1,
        resolved: &[("drum", None, 40), ("drum", None, 40)],
    },
    // @3100: the same crossing, and the one the fixture was written for -- its
    // head keeps normal while its tail takes drum
    DivergentSlider {
        map: "samples-nodes-v14",
        index: 2,
        resolved: &[("drum", None, 40)],
    },
    // @5000, 560 long: crosses the 6000 sample point. the slider the divergence
    // test below pins by name, where the same soft/90 shows up on its ticks
    DivergentSlider {
        map: "samples-nodes-v14",
        index: 4,
        resolved: &[("soft", None, 90)],
    },
];

fn engine_sample(sample: &HitSample) -> SampleDump {
    SampleDump {
        bank: sample.bank.as_str().to_string(),
        // lazer models a file sample as a normal-bank `hitnormal` carrying a
        // filename, which is exactly what the engine's `File` name is
        name: sample.name.as_str().unwrap_or("hitnormal").to_string(),
        suffix: sample.suffix.map(|n| n.to_string()),
        volume: sample.volume,
        is_layered: sample.is_layered,
        filename: match &sample.name {
            engine::formats::samples::SampleName::File(f) => Some(f.clone()),
            _ => None,
        },
        lookup_names: sample.lookup_names(),
    }
}

/// the render plan carries the same lookup in its wire shape; rebuilding the
/// dump row from it is what proves the plan did not drop or reshape a field on
/// the way out
fn plan_sample(sample: &RenderSample) -> SampleDump {
    SampleDump {
        bank: sample.bank.to_string(),
        name: sample.name.to_string(),
        suffix: sample.suffix.map(|n| n.to_string()),
        volume: sample.volume,
        is_layered: sample.layered,
        filename: sample.filename.clone(),
        lookup_names: HitSample {
            bank: match sample.bank {
                "normal" => engine::formats::samples::SampleBank::Normal,
                "soft" => engine::formats::samples::SampleBank::Soft,
                "drum" => engine::formats::samples::SampleBank::Drum,
                _ => engine::formats::samples::SampleBank::None,
            },
            name: match &sample.filename {
                Some(f) => engine::formats::samples::SampleName::File(f.clone()),
                None => match sample.name {
                    "hitwhistle" => engine::formats::samples::SampleName::Whistle,
                    "hitfinish" => engine::formats::samples::SampleName::Finish,
                    "hitclap" => engine::formats::samples::SampleName::Clap,
                    "slidertick" => engine::formats::samples::SampleName::SliderTick,
                    _ => engine::formats::samples::SampleName::Normal,
                },
            },
            suffix: sample.suffix,
            volume: sample.volume,
            is_layered: sample.layered,
        }
        .lookup_names(),
    }
}

#[test]
fn decoded_hit_samples_match_lazer_dumps() {
    let mut diverged: Vec<(&str, usize)> = Vec::new();
    for name in MAPS {
        let dump: SampleMapDump = fixture_util::load_json(&format!("samples/{name}.json"));
        let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{name}.osu")))
            .unwrap_or_else(|e| panic!("{name}: decode failed: {e}"));
        assert_eq!(map.hit_objects.len(), dump.objects.len(), "{name}: object count");

        for (i, (object, expected)) in map.hit_objects.iter().zip(&dump.objects).enumerate() {
            let ctx = format!("{name}[{i}] @{}", expected.start_time);
            assert_eq!(object.start_time, expected.start_time, "{ctx}: start time");

            let got: Vec<SampleDump> = object.samples.iter().map(engine_sample).collect();
            if expected.kind == "slider" && got != expected.samples {
                // the ONE place the wrapped decoder disagrees with lazer.
                // `LegacyBeatmapDecoder.applySamples` resolves an IHasRepeats
                // object's own samples at `start + LENIENCY + 1`; rosu-map
                // resolves every object's at `end + LENIENCY`, so a slider
                // that CROSSES a sample point picks up the wrong one. it is
                // not correctable downstream (SamplePoint::apply erases the
                // "was this specified?" bit as it fills), so it is recorded
                // rather than asserted -- see the divergence test below, which
                // pins exactly what it costs.
                //
                // the exemption is keyed on the DIVERGENCE, not on the kind: a
                // slider that crosses no sample point resolves identically in
                // both decoders and must still be pinned, or a wholesale
                // regression in slider sample resolution would pass here
                // unnoticed. what actually diverged is collected and compared
                // against the closed list below.
                //
                // and membership alone is not enough: a known-divergent slider
                // returning empty samples, or a different NAME, would still be
                // "diverged" and would still pass. so the SHAPE of the
                // divergence is pinned here too -- it is the same sample list
                // resolved at a different time, so only bank, suffix and volume
                // may move. names, layering and any filename must match lazer
                // exactly, which is what keeps a real regression from hiding
                // inside an exemption
                assert_eq!(
                    got.len(),
                    expected.samples.len(),
                    "{ctx}: a known divergence changed the sample COUNT"
                );
                for (g, e) in got.iter().zip(&expected.samples) {
                    assert_eq!(
                        (&g.name, g.is_layered, &g.filename),
                        (&e.name, e.is_layered, &e.filename),
                        "{ctx}: a known divergence moved more than bank/suffix/volume"
                    );
                }
                // and the moved fields are pinned to their CURRENT values, not
                // merely allowed to move: an exempted slider whose bank or
                // volume drifted to some third value would otherwise still be
                // "diverged" and still pass
                let entry = DIVERGENT_SLIDERS
                    .iter()
                    .find(|d| d.map == *name && d.index == i)
                    .unwrap_or_else(|| panic!("{ctx}: diverged outside the known set: {got:?}"));
                let resolved: Vec<(&str, Option<&str>, i32)> = got
                    .iter()
                    .map(|g| (g.bank.as_str(), g.suffix.as_deref(), g.volume))
                    .collect();
                assert_eq!(
                    resolved, entry.resolved,
                    "{ctx}: a known divergence resolved to different bank/suffix/volume"
                );
                diverged.push((name, i));
                continue;
            }
            assert_eq!(got, expected.samples, "{ctx}: object samples");
        }
    }
    // exactly the known set, in both directions: a new entry means slider
    // sample resolution moved, and a missing one means the rosu-map divergence
    // closed and this exemption should be deleted rather than carried
    let known: Vec<(&str, usize)> = DIVERGENT_SLIDERS.iter().map(|d| (d.map, d.index)).collect();
    assert_eq!(
        diverged, known,
        "the set of sliders diverging from the lazer dumps changed"
    );
}

#[test]
fn slider_node_samples_match_lazer_dumps() {
    for name in MAPS {
        let dump: SampleMapDump = fixture_util::load_json(&format!("samples/{name}.json"));
        let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{name}.osu")))
            .unwrap_or_else(|e| panic!("{name}: decode failed: {e}"));

        for (i, (object, expected)) in map.hit_objects.iter().zip(&dump.objects).enumerate() {
            let Some(expected_nodes) = &expected.node_samples else {
                continue;
            };
            let engine::formats::beatmap::HitObjectKind::Slider(slider) = &object.kind else {
                panic!("{name}[{i}]: lazer dumped nodes for a non-slider");
            };
            let got: Vec<Vec<SampleDump>> = slider
                .node_samples
                .iter()
                .map(|node| node.iter().map(engine_sample).collect())
                .collect();
            assert_eq!(&got, expected_nodes, "{name}[{i}] @{}: node samples", expected.start_time);
        }
    }
}

#[test]
fn the_render_plan_distributes_nodes_the_way_lazer_does() {
    for name in MAPS {
        let dump: SampleMapDump = fixture_util::load_json(&format!("samples/{name}.json"));
        let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{name}.osu")))
            .unwrap_or_else(|e| panic!("{name}: decode failed: {e}"));
        let processed = process_beatmap(&map).unwrap_or_else(|e| panic!("{name}: process failed: {e}"));
        let plan = build_render_plan(&map, &processed);

        for (i, (object, expected)) in plan.objects.iter().zip(&dump.objects).enumerate() {
            let ctx = format!("{name}[{i}] @{}", expected.start_time);
            let Some(expected_nested) = &expected.nested else {
                // a circle or spinner sounds its own samples directly
                let got: Vec<SampleDump> = object.samples.iter().map(plan_sample).collect();
                assert_eq!(got, expected.samples, "{ctx}: plan object samples");
                continue;
            };
            let RenderKind::Slider(slider) = &object.kind else {
                panic!("{ctx}: lazer dumped a slider, the plan did not");
            };
            assert!(
                object.samples.is_empty(),
                "{ctx}: a slider never sounds as a unit -- its pieces do"
            );

            let expect_for = |kind: &str, span_index: i32| -> &Vec<SampleDump> {
                &expected_nested
                    .iter()
                    .find(|n| n.kind == kind && n.span_index == span_index)
                    .unwrap_or_else(|| panic!("{ctx}: no lazer {kind} at span {span_index}"))
                    .samples
            };

            for nested in &slider.nested {
                let got: Vec<SampleDump> = nested.samples.iter().map(plan_sample).collect();
                match nested.kind {
                    RenderNestedKind::Head => {
                        assert_eq!(&got, expect_for("head", 0), "{ctx}: head samples")
                    }
                    RenderNestedKind::Repeat => assert_eq!(
                        &got,
                        expect_for("repeat", nested.span_index),
                        "{ctx}: repeat {} samples",
                        nested.span_index
                    ),
                    // lazer leaves SliderTailCircle.Samples empty and plays the
                    // tail node off the slider itself at the right time
                    // (slider.cs:285-289) -- `tailSamples` in the dump. this
                    // viewer schedules it off the tail's own judgement instead,
                    // so the samples ride on the tail piece; the SOUND is the
                    // same node either way, which is what this compares
                    RenderNestedKind::Tail => assert_eq!(
                        &got,
                        expect_for("tailSamples", nested.span_index),
                        "{ctx}: tail samples"
                    ),
                    RenderNestedKind::Tick => {
                        let expected_tick = expected_nested
                            .iter()
                            .find(|n| n.kind == "tick" && n.time == nested.time)
                            .unwrap_or_else(|| panic!("{ctx}: no lazer tick at {}", nested.time));
                        // ticks derive from the slider's own samples, which is
                        // the one thing the wrapped decoder resolves at a
                        // different time than lazer; the divergence test below
                        // owns that case, so a slider that crosses a sample
                        // point is skipped here rather than silently tolerated
                        if got != expected_tick.samples {
                            assert!(
                                *name == "samples-nodes-v14" && object.start_time == 5000.0,
                                "{ctx}: unexpected tick divergence at {}: got {got:?}, lazer {:?}",
                                nested.time,
                                expected_tick.samples
                            );
                        }
                    }
                }
            }
        }
    }
}

/// the known divergence, pinned so it cannot widen unnoticed and cannot be
/// mistaken for a bug when someone reads the tick assertion above.
///
/// `LegacyBeatmapDecoder.applySamples` resolves a slider's own samples at
/// `start + CONTROL_POINT_LENIENCY + 1`; rosu-map -- the decoder this crate
/// wraps -- resolves every object's at `end + CONTROL_POINT_LENIENCY`. those
/// samples feed exactly one thing, the tick sample (`slider.cs:263`), so the
/// whole cost is a tick sounding with the bank and volume in force at the
/// slider's END rather than its START, and only on a slider a sample point
/// falls inside. it is not correctable downstream: `SamplePoint::apply` fills
/// unset fields and erases the "was this specified?" bit as it goes, so the
/// pre-application sample cannot be recovered from what rosu-map returns
#[test]
fn a_slider_crossing_a_sample_point_ticks_with_the_end_bank_not_the_start_bank() {
    let name = "samples-nodes-v14";
    let dump: SampleMapDump = fixture_util::load_json(&format!("samples/{name}.json"));
    let map = decode_beatmap_path(&fixture_util::fixtures_dir().join(format!("beatmaps/{name}.osu"))).unwrap();
    let processed = process_beatmap(&map).unwrap();
    let plan = build_render_plan(&map, &processed);

    let crossing = plan
        .objects
        .iter()
        .find(|o| o.start_time == 5000.0)
        .expect("the crossing slider");
    let RenderKind::Slider(slider) = &crossing.kind else {
        panic!("expected a slider")
    };
    let ticks: Vec<_> = slider
        .nested
        .iter()
        .filter(|n| n.kind == RenderNestedKind::Tick)
        .collect();
    assert!(!ticks.is_empty(), "the crossing slider must tick");

    // lazer: the 5000 point (drum, volume 40). here: the 6000 point (soft,
    // volume 90), because the slider ends at 7000
    let lazer_tick = dump
        .objects
        .iter()
        .find(|o| o.start_time == 5000.0)
        .and_then(|o| o.nested.as_ref())
        .and_then(|nested| nested.iter().find(|n| n.kind == "tick"))
        .expect("lazer dumped a tick for the crossing slider");
    assert_eq!(lazer_tick.samples[0].bank, "drum");
    assert_eq!(lazer_tick.samples[0].volume, 40);

    for tick in ticks {
        assert_eq!(tick.samples.len(), 1);
        assert_eq!(tick.samples[0].bank, "soft", "the divergence, as recorded");
        assert_eq!(tick.samples[0].volume, 90);
        // the NAME is unaffected: the tick is still a slidertick on whatever
        // bank was resolved, so the divergence costs a bank and a volume and
        // never a missing sound
        assert_eq!(tick.samples[0].name, "slidertick");
    }
}
