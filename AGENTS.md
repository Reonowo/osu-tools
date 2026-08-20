This file provides guidance to agents when working with code in this repository.

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

**`src-tauri/crates/engine`** — pure Rust, zero Tauri dependencies. `.osu`/`.osr`/`skin.ini` codecs (`formats`), beatmap post-processing (`beatmap`), slider geometry ports (`path`), replay frame conversion + document/undo (`replay`), judgement simulation (`simulation`), the mod pipeline seam (`mods`, NoMod only so far), and `render_plan`, which assembles the package the frontend consumes. The doc comment in its `lib.rs` is the authoritative module-to-lazer-source map; every ported module cites the lazer file it ports, and deliberate divergences are documented at the code site and in `TODO.md`. No-panic guarantee: every public entry point taking untrusted input returns `Result<_, EngineError>` in every build profile; `limits.rs` holds the resource caps, each with its own boundary test.

**`src-tauri/src`** — the Tauri app crate: IPC commands (`commands.rs`), the load pipeline (`load.rs`), osu! stable install detection and `osu!.db` beatmap lookup (`stable.rs`), the `.osz` extraction cache with orphan GC (`osz.rs`, `cache.rs`), asset-protocol media scoping plus the beatmap's own sample and image file maps (`media.rs`), persisted settings (`settings.rs`), skin discovery and the skin manifest (`skin.rs`), `.osk` import (`osk.rs`), and the `LoadedScene` wire type (`scene.rs`). Sixteen commands: ten for loading, settings and skins — `load_replay`, `load_replay_with_beatmap`, `get_settings`, `set_osu_stable_path`, `set_viewer_prefs`, `clear_recents`, `list_skins`, `get_skin`, `set_skin`, `import_skin` — plus six over the replay document: `apply_edit`, `undo`, `redo`, `revert_all`, `resync`, `export_replay`. `load_replay` is the one open, resolving through the beatmap association stored for that `.osr` (saved file → saved folder → stable lookup), including a recorded mismatch consent, whichever route asked for it (`docs/adr/0005`).

**`src/`** — React + Pixi frontend. `lib/scene-types.ts` is the only frontend declaration of the `LoadedScene` JSON contract; its field names are frozen by the Rust serialization tests. Flow: `lib/ipc.ts` invokes a load command → the zustand store (`state/store.ts`) installs the scene and computes derived data (`lib/derive.ts`) → `playback/clock.ts`'s `PlaybackClock` owns continuous time (rAF-driven, drift-corrected against the audio element) while the store holds discrete state only → `renderer/GameplayRenderer.ts` drives Pixi drawables (`renderer/drawables/`, Argon skin style) whose per-object animation timelines are precomputed by pure `*-tracks.ts` modules. `playback/frame-cursor.ts` layers an exact frame selection over the clock's time, stepping by index so a duplicate-time run stays steppable; `playback/space-pan.ts` is the scrap of state deciding whether a space release was a play/pause tap or the end of a viewport pan drag — the toggle is split across the two events (the press pauses, so a held key cannot keep playing; only the play half waits for the release, and a hold that turned out to be a drag restores what the press interrupted). Audio is one WebAudio graph (`playback/audio-graph.ts`) with the music element routed in through a `MediaElementAudioSourceNode`, so master/music/hitsound compose as one gain tree; the clock owns time only, and applies the user's audio offset as lazer's `OffsetCorrectionClock` does (rate-adjusted, seeks still in raw beatmap time). Hit samples fire off _judgements_, never beatmap times: the engine resolves skin-independent lookups into the render plan, `playback/hitsound-plan.ts` folds the live judgement timeline into a time-ordered plan (rebuilt on every landed edit, which is why the combo-break "first break" marker is derived rather than remembered; the slider _end_ sound is the one piece that does not sound off its own judgement, because the tail judgement sits at the legacy last tick 36ms early — it sounds off the slider's aggregate, gated on the tail having been hit, exactly as lazer moved the same samples onto the slider), `playback/lookup-chain.ts` + `sample-sources.ts` are the ordered sources that answer a lookup — beatmap, user skin (`skinSampleSource`), bundled default in `public/samples/Gameplay/`, where an _empty_ answer stops the chain and a _decline_ passes it on — and `playback/hitsound-scheduler.ts` hands the result to the audio clock a lookahead window at a time. `playback/keybinds.ts` is the complete keybind inventory _and_ the whole model over it — one row per action, the fold of the user's sparse override map onto the defaults, the capture reader, the steal, and the pure resolver behind the tool keys; check it before binding a key, since its test fails when any effective table binds one key twice. The store holds the folded result as `effectiveKeybinds`, which is what every consumer reads: `playback/use-playback-shortcuts.ts` registers the `global` half through the one focus/scene guard (`playback/shortcut-guards.ts`), `components/viewport/use-edit-tools.ts` the `gesture` half, `playback/use-help-shortcut.ts` and `playback/use-open-shortcut.ts` the two bindings that are not scene-gated (`F1` and `Ctrl+O`, registered in `App` because the others mount only with a scene), and the tool palette its tooltips. Only `cancel` is locked; overrides persist opaquely in `settings.rs` (`docs/adr/0002-keybindings-store-key-and-code.md` records why a binding stores both a printed character and a physical code). Procedural art bakes at a quantised density bucket (`renderer/playfield.ts`'s `DENSITY_BUCKETS`), which `renderer/textures.ts` keys its cache and eviction by, so a zoom rebakes rather than magnifies. The chrome is a docked four-row shell (`components/shell/`): top bar, viewport + side panel + tab rail, the two-tier timeline (`components/timeline/`, both tiers sharing one `Playhead.tsx` marker over the device-pixel snapping in `lib/timeline-view.ts`), and the status bar. The overview strip's below-great marks are navigable through `lib/judgement-nav.ts` — the whole decision surface behind severity jump (the landing time, the per-grade lists, the ordering, the never-wrap answer and the count), built once per scene by `deriveScene` and read identically by the transport's six buttons and the number keys, so neither re-derives any of it. The top bar's `OpenMenu.tsx` is the only in-session route to another replay — a labelled popover holding _browse…_ and the recents minus the loaded one (`lib/open-menu.ts`), rendering the same `components/RecentEntry.tsx` row the start screen does. Every open goes through the store's single `openReplay`, which is where the unsaved-edits discard prompt (`components/DiscardDialog.tsx`) guards — once, at the request; `openWithBeatmap` and `confirmMismatch` are continuations and never re-ask. `src/skin/` is the skin layer, and it is deliberately shaped like the sample half it sits beside: `texture-sources.ts` adds a texture kind to the same `playback/lookup-chain.ts` (beatmap → user skin → the era's bundled default) rather than a second precedence rule, `legacy/floor-manifest.ts` is the vendored classic default set (`docs/adr/0006`, `NOTICE`) that a legacy skin falls through to — never to Argon, since eras must not mix on screen — `combo-colours.ts` is where a null palette on the wire is filled (the engine emits the beatmap's declared colours or nothing and substitutes none), `picker.ts` is the picker's whole decision surface, and `argon/constants.ts` and `legacy/constants.ts` hold each era's own taste, split from the ruleset values in `engine/game-constants.ts` that no skin can change. `pieces.ts` is the seam the whole visual half turns on: **one pure function answers, for every element the playfield draws, what the active skin draws for it** — a texture, the era's procedural piece, or nothing — which is the generalisation of the three-valued answer the judgement piece already used, and is what makes "what does this skin draw for a slider ball" decidable without a canvas. Two rules hold throughout it and both are load-bearing: a preference set to off means **no lookup is made at all** (the skin is never asked whether the user wants to see something, only what it looks like), and an **empty answer ends the chain** (a skin's blank asset is how a skinner removes an element, and a fallthrough written on autopilot resurrects exactly that). Drawables stay era-invariant and the piece inside them swaps, which is lazer's own boundary: an object's lifetime, its appear and vanish windows and its precomputed timelines are timing and are shared, while the piece is a procedural gradient stack or composited textures. The one element that is procedural in BOTH eras is the slider body, whose ramp is the era's (`legacy/slider-body.ts`, `engine/slider-lut.ts`) drawn through the one existing path-lookup-table and shader route. Skin textures live in their own cache (`renderer/skin-textures.ts`), keyed on the skin and evicted when the skin changes rather than when the zoom does — deliberately NOT the density-bucket cache in `renderer/textures.ts`, which exists to rebake procedural art and would re-decode real files on every zoom step; `renderer/skin-sprite.ts` is what draws one, and owns the `@2x` resolution factor and the frame selection. The active skin's manifest is held on the store _beside_ the scene, never on it, because a skin is app-wide and swaps without a scene reload — the swap is atomic (the whole manifest resolves, every texture it named loads, then one publication through `PlayerView`'s `installSkin`), which is why no frame can show a half-swapped playfield and why the playhead is never touched.

Panels live in `components/panels/`; the editing panels' controls are gated per scene by `editor/gate.ts`, disabled with a stated reason for a replay the document layer will not mutate (a lazer-written or unsimulated one) rather than disabled outright.

## Parity and testing conventions

- **Golden fixtures**: `fixtures/` is dumped by lazer's own code via `tools/fixture-gen` (a C# project that references a pinned lazer checkout), so expected values are never hand-derived. `fixtures/meta.json` records the exact pins and per-field tolerances. Frontend parity tests read the same tree via `src/test/fixtures.ts`.
- **Engine parity tiers**: fixture-level golden tests, plus a count-level oracle — a gitignored personal corpus at `fixtures/replays/local/` (NoMod stable `.osr` + sibling `.osu`, same stem) whose simulated counts must equal the `.osr` header's exactly — plus a committed synthetic full-combo test so CI exercises decode → process → simulate end to end without the corpus.
- **Frontend testability pattern**: pure logic takes injected dependencies (the store takes an `IpcDeps` object, the clock takes `now()`), which is what lets `bun test src` run headless. New frontend logic should follow this split: pure module + thin integration shell. Pixi's actual render path and anything under `bun run tauri dev` are not covered — those need a human pass with a real replay.

## Conventions

- Commit messages are scope-prefixed lowercase: `viewer/settings: replace the display length slider with a number field`, `engine/formats: ...`.
- rustfmt `max_width = 110`.
- `fixtures/path/slider_path.json` intentionally contains the JSON string literals `"Infinity"` and `"NaN"` in float positions; readers must accept them.

## Agent skills

These three files are gitignored local scaffolding, as are the `.scratch/`, `CONTEXT.md`, and `docs/adr/` paths they describe — never stage or commit them.

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name, recorded as a `Status:` line per issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
