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
//! expected value, never a hand-derived one. fixture comparisons use the
//! per-field tolerances recorded in `fixtures/meta.json` (position 1e-4,
//! distance 1e-3, ratio 1e-6); integers and enums compare exact.
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
//! | [`formats::beatmap`] | not a port of a lazer source file -- it wraps the third-party `rosu-map` crate for the actual `.osu` parse and only converts the result into engine-owned types. its pre-parse slider-size guard is checked against `rosu-map`'s own internal line/section/point-parsing behaviour (see [`limits`]) rather than against lazer, since `rosu-map` is the parser being guarded here |
//!
//! [`limits`] documents every resource cap this crate enforces at a format
//! boundary: what each one guards and where its boundary test lives.

pub mod error;
pub mod formats;
pub mod limits;
pub mod math;
pub mod path;

pub use error::{EngineError, Result};
