# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

An osu! (std-only) replay viewer/editor: a Tauri 2 desktop app with a React 19 + Pixi 8 frontend and a pure-Rust gameplay engine that ports osu!lazer behaviour quirk-for-quirk. The design spec is `docs/superpowers/specs/2026-08-01-osu-replay-viewer-design.md`; implementation plans live in `docs/superpowers/plans/`. `TODO.md` tracks every deferred feature and decision with enough context to pick up cold — update it in the same commit as whatever defers an item. Beatmaps are read-only in this app, permanently (this is why slider geometry is computed once per load in Rust); replay editing is the planned mutation surface.

## Commands

The package manager is bun (version pinned via `package.json`'s `packageManager`) — never npm/yarn/npx.

Frontend (repo root):

```bash
bun install
bun run tauri dev              # build + launch the desktop shell with hot reload
bun test src                   # all frontend tests (headless; no Tauri/WebGL needed)
bun test src/engine/easing.test.ts   # single test file
bun test src -t "<name>"       # filter by test name
bun run build                  # tsc typecheck + vite production build
```

Engine and app crate (from `src-tauri/`):

```bash
cargo test -p engine           # engine tests, debug profile
cargo test -p engine --release # ALSO run this when touching the engine -- catches what a debug_assert! would hide
cargo test --workspace         # every crate: the app crate's command tests (tauri mock runtime) plus engine
cargo doc -p engine --open     # the engine crate's own docs: parity bar, no-panic guarantee, module-to-lazer source map
```

Fixture regeneration (only on a reference-pin bump or when a task adds new cases; never hand-edit fixtures; commit the fixture diff together with the change that caused it):

```bash
dotnet run --project tools/fixture-gen -- --out fixtures   # repo root; lazer-derived dumps
cargo run -p engine --example dump_render_plan             # from src-tauri; render-plan dumps
```

Both are deterministic — rerunning with no source changes must leave `git status` clean. fixture-gen needs the .NET 8 SDK (`global.json`), an x86/x64 pre-.NET-9 runtime, and a pinned lazer checkout (`OsuCheckout` MSBuild property); see `fixtures/README.md`. The .NET SDK is only needed for regeneration, not to build or test anything.

## Architecture

Three layers with a strict dependency direction: engine → Tauri app crate → frontend.

**`src-tauri/crates/engine`** — pure Rust, zero Tauri dependencies. `.osu`/`.osr` codecs (`formats`), beatmap post-processing (`beatmap`), slider geometry ports (`path`), replay frame conversion + document/undo (`replay`), judgement simulation (`simulation`), the mod pipeline seam (`mods`, NoMod only so far), and `render_plan`, which assembles the package the frontend consumes. The doc comment in its `lib.rs` is the authoritative module-to-lazer-source map; every ported module cites the lazer file it ports, and deliberate divergences are documented at the code site and in `TODO.md`. No-panic guarantee: every public entry point taking untrusted input returns `Result<_, EngineError>` in every build profile; `limits.rs` holds the resource caps, each with its own boundary test.

**`src-tauri/src`** — the Tauri app crate: IPC commands (`commands.rs`), the load pipeline (`load.rs`), osu! stable install detection and `osu!.db` beatmap lookup (`stable.rs`), the `.osz` extraction cache with orphan GC (`osz.rs`, `cache.rs`), asset-protocol media scoping (`media.rs`), persisted settings (`settings.rs`), and the `LoadedScene` wire type (`scene.rs`). Six commands: `load_replay`, `load_replay_with_beatmap`, `get_settings`, `set_osu_stable_path`, `set_viewer_prefs`, `clear_recents`.

**`src/`** — React + Pixi frontend. `lib/scene-types.ts` is the only frontend declaration of the `LoadedScene` JSON contract; its field names are frozen by the Rust serialization tests. Flow: `lib/ipc.ts` invokes a load command → the zustand store (`state/store.ts`) installs the scene and computes derived data (`lib/derive.ts`) → `playback/clock.ts`'s `PlaybackClock` owns continuous time (rAF-driven, drift-corrected against the audio element) while the store holds discrete state only → `renderer/GameplayRenderer.ts` drives Pixi drawables (`renderer/drawables/`, Argon skin style) whose per-object animation timelines are precomputed by pure `*-tracks.ts` modules. The chrome is a docked four-row shell (`components/shell/`): top bar, viewport + side panel + tab rail, the two-tier timeline (`components/timeline/`), and the status bar. Panels live in `components/panels/`; the editing panels render their real geometry with every control disabled until the replay-document IPC commands exist.

## Parity and testing conventions

- **Golden fixtures**: `fixtures/` is dumped by lazer's own code via `tools/fixture-gen` (a C# project that references a pinned lazer checkout), so expected values are never hand-derived. `fixtures/meta.json` records the exact pins and per-field tolerances. Frontend parity tests read the same tree via `src/test/fixtures.ts`.
- **Engine parity tiers**: fixture-level golden tests, plus a count-level oracle — a gitignored personal corpus at `fixtures/replays/local/` (NoMod stable `.osr` + sibling `.osu`, same stem) whose simulated counts must equal the `.osr` header's exactly — plus a committed synthetic full-combo test so CI exercises decode → process → simulate end to end without the corpus.
- **Frontend testability pattern**: pure logic takes injected dependencies (the store takes an `IpcDeps` object, the clock takes `now()`), which is what lets `bun test src` run headless. New frontend logic should follow this split: pure module + thin integration shell. Pixi's actual render path and anything under `bun run tauri dev` are not covered — those need a human pass with a real replay.

## Conventions

- Commit messages are scope-prefixed lowercase: `viewer/settings: replace the display length slider with a number field`, `engine/formats: ...`.
- rustfmt `max_width = 110`.
- `fixtures/path/slider_path.json` intentionally contains the JSON string literals `"Infinity"` and `"NaN"` in float positions; readers must accept them.
