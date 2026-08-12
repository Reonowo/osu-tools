# Golden fixtures

Dumped from the pinned lazer sources by `tools/fixture-gen` (C#, references the
lazer checkout so lazer itself computes every expected value).

- Regenerate: `dotnet run --project tools/fixture-gen -- --out fixtures`
- Regenerate ONLY when a reference pin bumps or a task adds cases; commit the
  fixture diff together with the change that caused it.
- `meta.json` records the pins and the per-field comparison tolerances used by
  the Rust and frontend test suites. Integers/enums compare exact. It also
  carries a `notes` array for fixture-specific caveats like the one below,
  regenerated alongside the fixtures so it can't go stale.
- `meta.json`'s `checkout_head` is the HEAD of the checkout that MSBuild
  actually resolved the `osu.Game` `ProjectReference` against, baked into the
  assembly at build time. Point both at a different tree with
  `-p:OsuCheckout=<path>`; that single switch moves the reference and the
  recorded head together, so they cannot disagree. (`OSU_CHECKOUT` is a legacy
  fallback, consulted only when that baked value is absent.)
- `checkout_working_tree` alongside it reads `clean`, `dirty`, or `unknown`. A
  matching `checkout_head` alone does **not** mean the pinned sources are what
  compiled: an edited reference tree builds modified code while HEAD still reads
  the pin. Fixtures generated from a `dirty` tree are not attributable to their
  recorded commit and should be regenerated from a clean one before being
  committed. Regeneration warns on stderr when this happens.
- `replays/local/` is gitignored -- see "Replay corpus" below for its layout
  and what it feeds.
- `replays/synthetic_v14.osr` and `replays/synthetic_v4.osr` are intentionally
  byte-identical: both carry the same replay payload, and only the beatmap
  format version passed to `convert_frames` at decode time (14 vs 4) makes
  their expected frame times differ (`frame_conversion_v14.json` vs
  `frame_conversion_v4.json`).

## Replay corpus

`replays/local/` is gitignored: it holds an optional, personal corpus for
`src-tauri/crates/engine/tests/replay_corpus.rs`'s `local_nomod_replays_self_verify`
test, which is the spec's §Parity 2 oracle. Layout: drop a real `.osr` file and
its matching `.osu` beatmap side by side, sharing the same stem --
`<name>.osr` + `<name>.osu`. The test decodes both, simulates the replay
against the processed beatmap, and asserts that the simulated `{300, 100, 50,
miss, max combo}` totals -- plus the derived geki/katu counts and total score
(engine `score` module) -- equal the `.osr` header's own values exactly,
because for a real NoMod stable replay those numbers are already known and
correct, so any divergence is a bug in this crate's simulation or derivation,
not in the replay. The header is also the _only_ oracle for geki/katu: the
pinned lazer encoder writes zeros for osu!, so only stable-set replays carry
real values (lazer-set scores are useless here). Replays whose `.osr` header mods are non-zero are skipped (mod
simulation is a TODO.md item, not yet a v1 concern); a `.osr` with no sibling
`.osu`, or that fails to decode, is skipped with a stderr notice rather than
failing the test. An empty or entirely missing `replays/local/` directory
also passes (with a notice), so CI stays green on machines that never
populate it -- this repo does not, and should not, ship anyone's personal
replays. `tests/replay_corpus.rs` also carries a second, committed test
(`synthetic_full_combo_on_the_fixture_map`) that full-combos
`beatmaps/slider-zoo-v14.osu` with a hand-built replay and hand-derived
expected totals, so the pipeline is exercised end to end on every CI run
even with an empty local corpus.

## Score dumps

`score/` pins the derived-field regeneration (engine `score` module) with
values lazer's own runtime computed (`tools/fixture-gen/ScoreDumps.cs`):

- `score/peppy_stars.json` -- `CalculateDifficultyPeppyStars` over adversarial
  difficulty triples (messy-float 15-significant-digit rounding, banker's-tie
  sums in both directions, the ratio clamp at both ends, the `drainLength == 0`
  sentinel, stable's negative-drain corner) plus the five fixture beatmaps
  with their object counts and drain lengths dumped separately, so a drain
  mismatch localises apart from the decimal arithmetic. Consumed by
  `tests/score_fixtures.rs`.
- `score/legacy_score_attributes.json` -- the osu! ruleset's legacy score
  simulator (reached via `OsuRuleset.CreateLegacyScoreSimulator()`; the
  simulator itself is internal) over the fixture maps. Its `MaxCombo` pins
  the achievable-combo counter, and on spinner-free maps `AccuracyScore +
ComboScore` is the exact achieved total of a synthetic full combo.
- `score/replay_hash.json` -- input pairs for the pinned encoder's replay
  hash (`md5("lazer-{username}-{date}")`), with the invariant-formatted date
  string dumped separately from the hash so a formatting mismatch localises.

All score values are integers or exact strings and compare exact.

## Named floating point literals

`path/slider_path.json` contains `"Infinity"` and `"NaN"` **string** literals in
`segment_ends_progress`. `SliderPath.GetSegmentEnds` (SliderPath.cs:267) divides
each segment-end distance by `Distance` with no zero guard, so any path whose
expected distance collapses it to zero length (`expected-zero`) or that is
zero-length to begin with (`zero-length-all-identical`) genuinely produces
non-finite progress values in lazer. They are recorded rather than avoided,
because consumers of `GetSegmentEnds` have to cope with them. `fixture-gen`
serialises them with `JsonNumberHandling.AllowNamedFloatingPointLiterals`;
readers must accept a JSON string in a float position for that field.

`beatmap/*.json` also contain named floating point literals, for the same
reason. `slider-zoo-v14.json`'s third slider sits under the
`8000,NaN,4,2,1,60,0,0` inherited timing point, which disables tick generation
(`Slider.cs:169`) and makes lazer's `TickDistance` genuinely `+Infinity` for
that slider — its dump's `tick_distance` field is therefore the JSON string
`"Infinity"`. Readers must accept that and compare it by classification
(`is_infinite`), the same as `segment_ends_progress` above; the Rust side does
this with a scalar sibling of `slider_path_fixtures.rs`'s
`deserialize_lenient_f64_list` (see `beatmap_fixtures.rs`'s
`deserialize_lenient_f64`). Every fixture not named in this section
(`approximator_bspline.json`, `approximator_catmull.json`,
`approximator_circular_arc.json`, `replays/float_format.json`) is still
written with strict number handling, so an accidental non-finite value in one
of those would still throw at generation time.

## Architecture/runtime-pinned fixtures: `path/approximator_circular_arc.json`, `path/slider_path.json`

The `arc-huge-radius-zero-acos` case is reproducible **only on x86/x64 with a
pre-.NET-9 runtime**. Its three points are nearly collinear, giving a huge
circumradius (~5e8); that drives `1 - tolerance / radius` to exactly `1.0f`,
so `Math.Acos(1.0) == 0` and `PathApproximator.CircularArcToPiecewiseLinear`'s
point-count division explodes to `+Infinity`. That `+Infinity` then goes
through an unchecked `(int)` cast:

- **Pre-.NET-9, x86/x64**: a non-finite double truncates to `int.MinValue`
  (the raw `cvttsd2si` "integer indefinite" sentinel). `Math.Max(2, ...)`
  clamps that back up to `2`, which is what the pinned fixture records.
- **.NET 9+ (any architecture), or Arm64 on any .NET version**: the
  conversion is/was already saturating, so the same `+Infinity` yields
  `int.MaxValue` (~2.1 billion) instead. `PathApproximator` then tries to
  allocate a `List<Vector2>` with that capacity and the process dies with
  `OutOfMemoryException: Array dimensions exceeded supported range` —
  correct behaviour for that runtime, but a baffling failure mode with no
  obvious connection to this specific case unless you already know about it.

    Reference: ["Floating point-to-integer conversions are saturating"](https://learn.microsoft.com/en-us/dotnet/core/compatibility/jit/9.0/fp-to-integer),
    a documented .NET 9 Preview 4 JIT breaking change. `global.json` pins the
    SDK's _version_ (8.x) but not architecture, so this fixture additionally
    assumes an x86/x64 host — `dotnet run --project tools/fixture-gen` on an
    Arm64 machine (e.g. Apple Silicon) will hit the saturating path even with
    the pinned SDK.

    `tools/fixture-gen` probes for this at startup (an actual runtime division,
    not a compile-time constant, so it can't be folded away) and exits with a
    clear diagnostic instead of generating a corrupted fixture or crashing with
    an unrelated-looking `OutOfMemoryException`.

`SliderPath.cs:355` duplicates the same point-count expression to decide whether
a `PerfectCurve` segment gets a circular arc or degrades to a B-spline, so
`path/slider_path.json` inherits the same runtime pin. Its
`perfect-huge-radius-takes-arc` case (circumradius ~4.7e6) records the arc
branch — 3 vertices. On a saturating runtime that case would take the B-spline
branch and record ~129 vertices instead, silently changing the shape of a
slider a mapper can actually place.

## easing.json

All 36 `Easing` enum members sampled through
`osu.Framework.Graphics.Transforms.DefaultEasingFunction.ApplyEasing` at
`t = i/32, i ∈ [0, 32]`. Consumed by the frontend easing port's parity test
(`src/engine/easing.test.ts`); pure double math on both sides, compared at
1e-9. Regenerated with every other fixture.

## render_plan/

**Rust-generated, not lazer goldens.** One dump of
`engine::render_plan::build_render_plan` per `beatmaps/*.osu` — the exact
production geometry `LoadedScene.renderPlan` carries over IPC. The frontend's
slider progress→position parity test (`src/engine/slider-path.test.ts`)
evaluates this geometry and compares against **lazer's** `ball_samples` in
`beatmap/*.json`, so lazer remains the oracle; the geometry itself is under
the engine's own lazer-fixture parity (plans 1–2). Regenerate with
`cargo run -p engine --example dump_render_plan` (from `src-tauri/`) whenever
the render-plan serialization or the fixture beatmaps change.
