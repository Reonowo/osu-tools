//! pure gameplay-math engine for the osu! replay editor: `.osu` beatmap and
//! `.osr` replay codecs, plus a full `SliderPath`/`PathApproximator` port.
//! ports lazer behaviour quirk-for-quirk rather than reimplementing it from
//! the file-format spec; every module that ports a lazer source file cites
//! it. zero tauri dependencies -- this crate knows nothing about the app
//! that embeds it and can be built, tested, and reused entirely on its own.
//!
//! # no-panic guarantee
//!
//! every public entry point that takes external, untrusted input -- `.osu`
//! bytes, `.osr` bytes, or hand-built [`path::SliderPath`]/`PathControlPoint`
//! values -- returns [`Result`] instead of panicking, in every build profile
//! including `--release`. malformed, truncated, adversarial, and numerically
//! pathological input (nan/infinite coordinates, oversized slider point
//! counts, oversized replay frame counts, control-point magnitudes whose
//! bezier subdivision never converges, truncated files at every possible
//! byte offset) all surface as a typed [`EngineError`] rather than a panic.
//! this is exercised directly by corpus tests such as
//! `formats::beatmap::tests::malformed_inputs_never_panic` and
//! `formats::osr::tests::truncation_at_every_offset_never_panics`, and it is
//! why every resource cap in [`limits`] carries its own boundary test rather
//! than being trusted by inspection. the guarantee has been violated twice in
//! this crate's history: once by a `debug_assert!` that enforced a degree
//! invariant only in debug builds and let an actual index-out-of-bounds
//! panic through in `--release` (see
//! `path::approximator::tests::b_spline_degree_zero_is_rejected`'s comment),
//! and once by an unbounded subdivision loop that could exhaust memory and
//! abort the process outright -- worse than a panic, since an abort cannot be
//! caught at all (see [`limits::MAX_BEZIER_SUBDIVISION_DEPTH`]). that is why
//! verification always runs the full suite under `--release` as well as under
//! the default debug profile, not just one or the other.
//!
//! # parity bar
//!
//! every port in this crate is checked against golden fixtures under
//! `fixtures/` that lazer itself generated -- `tools/fixture-gen` links
//! against a pinned lazer checkout so lazer's own code computes every
//! expected value, never a hand-derived one. fixture comparisons are
//! bit-exact: the 2026-08-12 tolerance audit zeroed every per-field
//! tolerance recorded in `fixtures/meta.json` after fixing the one genuine
//! divergence (the slider duration chain's double rounding) at its source,
//! so integers, enums, times, and floats all compare exact and any drift
//! is a regression.
//! `fixtures/meta.json` also records the exact commit pins (`osu_pin`,
//! `framework_pin`) the fixtures were generated against. the policy is:
//! regenerate fixtures only when a reference pin bumps or a task adds new
//! cases, and commit the resulting fixture diff together with whatever
//! change caused it -- expectations are never hand-edited. `fixtures/README.md`
//! covers the regeneration command and, notably, an architecture/runtime
//! pin two of the fixtures additionally depend on.
//!
//! # module -> lazer source map
//!
//! | module | lazer source |
//! |---|---|
//! | [`path::approximator`] | `osu.framework/utils/pathapproximator.cs` (tag 2026.731.0) |
//! | [`path::arc`] | `osu.framework/utils/circulararcproperties.cs` (tag 2026.731.0) |
//! | [`path::slider_path`] | `osu.game/rulesets/objects/sliderpath.cs` (pin 83b8a64), including the osu!stable expected-distance quirks it reproduces |
//! | [`math`] | osuTK `Vector2` (osu-framework's vector nuget dependency), `osu.framework/utils/precision.cs`, and .net's `System.Array.BinarySearch` |
//! | [`formats::osr`] | byte framing follows `LegacyScoreDecoder.cs`/`LegacyScoreEncoder.cs`; decompression tolerance is checked against `SharpCompress.Compressors.LZMA.LzmaStream`'s actual runtime behaviour, which is looser than lazer's own encoder output |
//! | [`formats::samples`] | `osu.game/audio/hitsampleinfo.cs` (lookup names, the bank/name/suffix identity a skin resolves on) plus `osu.game/rulesets/objects/legacy/converthitobjectparser.cs`'s `LegacyHitSampleInfo`/`FileHitSampleInfo`. this is lazer's `ISampleInfo` -> `ISkin.GetSample` seam: the engine resolves a sample and stops, and whichever source answers the lookup names owns the file |
//! | [`formats::skin_ini`] | `osu.game/skinning/legacyskindecoder.cs` and the `osu.game/beatmaps/formats/legacydecoder.cs` line loop it derives from, plus `osu.game/skinning/skin.cs:108-113` for the absent-file default and `osu.game/skinning/legacyskin.cs:329-373` for what a configuration lookup answers. pinned by `fixtures/skin/`, dumped through a real `LegacySkin` so the absent-file and undeclared-`Version` defaults stay distinct |
//! | [`formats::beatmap`] | not a port of a lazer source file -- it wraps the third-party `rosu-map` crate for the actual `.osu` parse and only converts the result into engine-owned types. its pre-parse slider-size guard is checked against `rosu-map`'s own internal line/section/point-parsing behaviour (see [`limits`]) rather than against lazer, since `rosu-map` is the parser being guarded here |
//! | [`beatmap`]`::*` | assembly order follows `workingbeatmap.cs:291-351` (convert -> combo pre-process -> per-object defaults -> stacking); per-submodule citations: `osubeatmapprocessor.cs` (combo enforcement, stacking), `slidereventgenerator.cs` (slider nested events), `ibeatmapdifficultyinfo.cs`/`legacyrulesetextensions.cs:46-59`/`osuhitobject.cs`/`osuhitwindows.cs` (cs/ar/od derivations, hit windows), `controlpointinfo.cs`/`timingcontrolpoint.cs`/`slider.cs:158-170`/`osubeatmapconverter.cs:47-51` (timing/velocity/tick distance) |
//! | [`replay`]`::*` | `legacyscoredecoder.cs:268-352` (frame conversion: cumulative times, stable's first-frame fixups, intro-frame removal); `framedreplayinputhandler.cs`/`osuframedreplayinputhandler.cs`/`interpolation.cs:351-361` (cursor interpolation, frame-accurate replay of `MousePositionAbsoluteInput`); `replay::document`'s undo/redo and export rules come from this crate's own spec, not a lazer port |
//! | [`simulation`]`::*` | `legacyhitpolicy.cs` (classic note lock); `drawablehitcircle.cs`/`drawablesliderhead.cs`/`drawableslider.cs:293-315` (classic circle/slider-head/aggregate judgement); `sliderinputmanager.cs` (tracking state machine, key restriction, `postprocessheadjudgement`); `spinnerrotationtracker.cs`/`spinnerspinhistory.cs`/`drawablespinner.cs` (spinner rotation, ticks, final result); `hitresult.cs`/`osulegacyscoresimulator.cs` (combo/count semantics, with the one deliberate divergence noted below) |
//! | [`mods`] | `osu.game/beatmaps/legacy/legacymods.cs` (flag values, mirroring the stable bitfield stored in `.osr` headers). the `ModPipeline` seam itself (`adjust_difficulty -> transform_geometry -> rate`) is new scaffolding rather than a lazer port; v1 ships [`mods::NoMod`] only, catalogued further in `TODO.md` |
//! | [`render_plan`] | not a port: assembles the frontend package from `beatmap`/`path` outputs. its two cited constants are the argon combo palette (`argonskin.cs:51-71`), kept only as the lazer citation now that this layer emits the beatmap's own colours or `None` and the frontend's `skin/combo-colours.ts` fills a null -- the `legacybeatmapskin.cs:40` rule it used to justify a fallback for now resolves to "else the skin" and the playfield base size (`osuplayfield.cs:47`) |
//! | [`score`] | derived-field regeneration for export: `legacyrulesetextensions.cs:61-94` (peppy stars, ported on a 96-bit decimal), `legacyscoreutils.cs:90-102` (drain length), `osulegacyscoresimulator.cs` (scorev1 base values and combo bonus), `legacyscoreencoder.cs:105-114` (replay hash, perfect rule). geki/katu is a deliberate divergence from the pinned encoder (which writes zeros for osu!), oracled by the NoMod corpus |
//!
//! [`limits`] documents every resource cap this crate enforces at a format
//! boundary: what each one guards and where its boundary test lives.
//!
//! # simulation parity
//!
//! judgement parity has two tiers below the fixture-level golden tests above.
//! count-level: `tests/replay_corpus.rs`'s `local_nomod_replays_self_verify`
//! is the spec's §parity 2 oracle -- for every replay dropped into the
//! gitignored personal corpus at `fixtures/replays/local/` (a real NoMod
//! stable `.osr` plus its sibling `.osu`, same stem), the simulated `{300,
//! 100, 50, miss, max combo}` must equal the `.osr` header's own counts
//! exactly; an empty or missing corpus passes with a notice so ci stays
//! green without anyone's personal replays ever being committed. alongside
//! it, a committed synthetic test (`synthetic_full_combo_on_the_fixture_map`)
//! full-combos `fixtures/beatmaps/slider-zoo-v14.osu` with a hand-built
//! replay and hand-derived expected totals, so decode -> process -> simulate
//! runs end to end on every ci run even with no local corpus at all.
//!
//! beneath the count-level oracle, three lazer-dump fixture families back
//! `beatmap`, `replay` and `formats::samples` directly with values lazer
//! itself computed: the `.osu`-decoded `fixtures/beatmap/*.json` dumps
//! (stacking, scale, preempt, windows, nested slider objects, per-slider ball
//! samples), the replay dumps (`fixtures/replays/cursor_interpolation.json`,
//! `fixtures/replays/frame_conversion_*.json`) covering cursor interpolation
//! and frame conversion, and `fixtures/samples/*.json`, which pins hit sample
//! RESOLUTION -- which sound each object and nested object asks for -- read
//! after lazer's own `applySamples` and `Slider.UpdateNestedSamples`. that
//! last family covers resolution and nothing else: which sample fires off
//! which judgement, and when, is the app's own composition with no lazer
//! analogue to dump, and lives in frontend tests instead.
//!
//! this crate has exactly two deliberate scoring divergences from lazer,
//! both places where the stable `.osr` header oracle contradicts lazer's own
//! model. one: the classic slider tail increments combo (stable semantics),
//! evidenced by `OsuLegacyScoreSimulator.cs:92-96` and the
//! `LegacyComboIncrease` padding at `LegacyScoreDecoder.cs:245-254` --
//! lazer's own lazer-native tail result does not touch combo. documented at
//! [`simulation::score`]. two: a slider point's scorev1 value comes from how
//! many points are due at its judging moment, never from the point's own
//! kind (danser `slider.go:330-335`, the stable shape) -- a final tick at or
//! past the -36ms tail point scores 30 where lazer's simulator counts 10,
//! which is a flat, map-constant term stable headers demand (engine parity
//! issue 15). documented at [`score::stable_slider_point_values`].

pub mod beatmap;
pub mod error;
pub mod formats;
pub mod limits;
pub mod math;
pub mod mods;
pub mod path;
pub mod render_plan;
pub mod replay;
pub mod score;
pub mod simulation;

pub use error::{EngineError, Result};
