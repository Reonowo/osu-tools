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
- `replays/local/` is gitignored: drop personal `.osr` files there for the
  optional local round-trip corpus tests.

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
  SDK's *version* (8.x) but not architecture, so this fixture additionally
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
