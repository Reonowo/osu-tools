# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

## Engine crate and fixtures

`src-tauri/crates/engine` is a pure-Rust crate with zero Tauri dependencies: `.osu`
beatmap and `.osr` replay codecs, plus a full `SliderPath`/`PathApproximator` port of
lazer's slider geometry. Run `cargo doc -p engine --open` from `src-tauri` for the
crate's own docs, including the parity bar, the no-panic guarantee, and the
module-to-lazer-source citation list.

### Prerequisites

- Rust (stable toolchain); the Cargo workspace lives in `src-tauri`
- .NET SDK, pinned to `8.0.100` via `global.json` (`rollForward: latestFeature`, so any
  8.0 SDK from the latest installed feature band works -- `8.0.4xx` is what is installed
  here -- while `9.x` does not) -- only needed to regenerate fixtures, not to build or
  test the engine crate
- bun (pinned via `package.json`'s `packageManager` field) -- for the frontend; never
  npm/yarn/npx

### Running the engine tests

From `src-tauri`:

```bash
cargo test -p engine            # debug
cargo test -p engine --release  # release -- catches anything a debug_assert! would hide
```

### Regenerating fixtures

`fixtures/` holds golden output dumped straight from a pinned lazer checkout by
`tools/fixture-gen`, a small C# program that references lazer's own `osu.Game` project
directly (via the `OsuCheckout` MSBuild property in `tools/fixture-gen/fixture-gen.csproj`,
default `C:\Users\admin\Desktop\osu_ref\osu!lazer source` -- override with
`dotnet run --project tools/fixture-gen -p:OsuCheckout=<path> -- --out fixtures` if your
checkout lives elsewhere), so lazer's own code computes every expected value rather than
a hand-derived one.

Regenerate from the repo root:

```bash
dotnet run --project tools/fixture-gen -- --out fixtures
```

Only regenerate when a reference pin bumps (`fixtures/meta.json` records the exact
`osu_pin`/`framework_pin` in use) or a task adds new cases, and commit the resulting
fixture diff together with the change that caused it.

Two things worth knowing before you regenerate, covered in full in `fixtures/README.md`:

- **Regeneration only works on x86/x64 with a pre-.NET-9 runtime.** Two fixtures
  (`path/approximator_circular_arc.json`, `path/slider_path.json`) depend on a
  non-saturating `(int)` cast of a non-finite double that .NET 9 changed and that never
  applied on Arm64. `fixture-gen` probes for this at startup and fails fast with a clear
  diagnostic on the wrong runtime instead of silently producing a corrupted fixture.
- **`fixtures/path/slider_path.json` intentionally contains the JSON literals
  `"Infinity"` and `"NaN"`** in `segment_ends_progress`. Lazer's `SliderPath.GetSegmentEnds`
  genuinely produces non-finite progress values for zero-length paths, and the fixture
  records that rather than avoiding it; readers must accept a JSON string in that float
  position.

See `fixtures/README.md` for the full fixture format, tolerance policy, and the local
(gitignored) `.osr` corpus used by the optional round-trip test.
