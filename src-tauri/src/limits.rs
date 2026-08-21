//! app-layer resource caps, following the engine::limits pattern: every cap
//! is a named constant with a boundary test, surfaced across ipc as the
//! typed ResourceLimit error. engine-side caps (file sizes, object counts,
//! lzma, frames, simulation work) live in engine::limits; the archive caps
//! below cover the handling the spec's error-handling section assigns to
//! this layer ("archive entry count/expanded size"), and the last one bounds
//! the directory scan a recents reopen falls back to
//!
//! | constant | value | what it guards | boundary test |
//! |---|---|---|---|
//! | [`MAX_OSZ_ENTRIES`] | 10,000 | member count of an .osz archive, checked in osz::open_osz before any entry is read -- real mapsets hold at most a few hundred files | `osz::tests::entry_count_cap_boundary` |
//! | [`MAX_OSZ_EXTRACTED_BYTES`] | 512 MiB | total bytes actually written while extracting required members (matched .osu + referenced media), charged chunk by chunk as they are copied so a lying zip size header cannot help -- declared sizes are never trusted. required media is one audio file and one background image; real sets sit two orders of magnitude below | `osz::tests::extracted_bytes_cap_boundary` (parameterized budget, mirroring engine's capped entry points) |
//! | [`MAX_OSZ_SCAN_BYTES`] | 512 MiB | total decompressed bytes across all .osu candidates read while scanning an archive for an md5 match (osz::find_osu_by_md5) -- without an aggregate budget, an archive of many maximum-size members could force per-candidate decompression far past any single-file cap on the way to not-found; each read is additionally clamped to the budget's remainder so real decompression cannot outrun the cap by more than one byte | `osz::tests::scan_budget_boundary` (parameterized budget, mirroring engine's capped entry points) |
//! | [`MAX_OSZ_FILE_BYTES`] | 1 GiB | byte length of the .osz file itself, checked before anything is read -- the central-directory metadata zip retains while opening (entry names, extra fields, comments) is carved out of the file's own bytes, so this bounds open-time memory even for archives crafted to maximize retained metadata. the largest real mapsets (marathon video sets) sit well under half of it | `osz::tests::file_size_cap_boundary` (parameterized length, mirroring engine's capped entry points) |
//! | [`MAX_RECENT_DIR_OSU_FILES`] | 64 | .osu files hashed while a recents reopen scans the folder its association remembers (load::scan_dir_for_beatmap) for a difficulty renamed in place. each read is separately bounded by engine::limits::MAX_OSU_FILE_BYTES, so the count also bounds the scan's bytes; real mapset folders hold at most a few dozen difficulties. this scan is a shortcut, not a load path of its own, so exhausting the cap gives up in favour of the osu! stable lookup rather than failing the load | `load::tests::recent_dir_scan_file_cap_boundary` (parameterized count, mirroring engine's capped entry points) |
//! | [`MAX_EDIT_LABEL_BYTES`] | 256 | byte length of the undo/redo label a `commands::apply_edit` call carries -- an editor-driven string, never file-derived, so this stays a small fixed cap rather than a byte-cap that scales with anything else | `commands::tests::label_length_cap_boundary` |
//! | [`MAX_BEATMAP_TEXTURES`] | 10,000 | element-named image files one beatmap folder may contribute to the texture chain, counted in `media::resolve_texture_files` as names are collected -- the byte cap alone cannot bound the walk, since a folder of element-named zero-byte files charges nothing while growing both maps and the scene crossing ipc. matches [`MAX_SKIN_TEXTURES`]: the beatmap's art is the other texture source and should not be refused on a different scale. the `.osz` extractor counts its texture members against the same cap before writing any | `media::tests::beatmap_texture_count_cap_boundary` (folder side) and `osz::tests::texture_count_cap_boundary` (archive side) |
//! | [`MAX_SKIN_FILES`] | 20,000 | texture and sample files one skin directory may hold, counted in `skin::scan_skin_dir` -- it bounds both the manifest crossing ipc and the map the frontend resolves lookups through | `skin::tests::skin_file_count_cap_boundary` |
//! | [`MAX_SKIN_BYTES`] | 512 MiB | total bytes of those files. mirrors [`MAX_OSZ_EXTRACTED_BYTES`] deliberately: a skin is the other untrusted asset bundle this app reads, and the two should not be refused on different scales | `skin::tests::skin_total_byte_cap_boundary` |
//! | [`MAX_SKIN_FILE_BYTES`] | 64 MiB | byte length of any single skin asset, checked from the directory entry's metadata before the file is opened | `skin::tests::skin_per_file_byte_cap_boundary` |
//! | [`MAX_SKIN_TEXTURES`] | 10,000 | textures alone, charged separately from the file count because textures are the half that reaches the GPU and a skin of nothing but sprites would otherwise sit inside the file cap while exhausting texture memory | `skin::tests::skin_texture_count_cap_boundary` |
//! | [`MAX_SKIN_ANIMATION_FRAMES`] | 1,000 | frames in ONE animation set -- `<element>-<n>`, or `<element><n>` for the separator-less families such as the slider ball's `sliderb0`..`sliderb9` -- charged per set rather than in total: the hazard is a single element declaring an enormous sequence that a drawable would try to hold at once, not a skin holding many short animations | `skin::tests::skin_animation_frame_cap_boundary` |
//! | [`MAX_SKIN_DIR_DEPTH`] | 8 | how deep a skin's own subdirectories may nest below its root. the walk recurses because skin.ini prefix keys (`HitCirclePrefix: Assets/default/default`) name files at depth and both stable and lazer resolve them, but a skin is untrusted third-party input and the walk must be bounded; real prefixes sit one or two levels down. the `.osk` import checks the same cap against the member names it KEEPS, before extracting anything -- a member the extension filter drops never reaches the staged tree, so neither side refuses it | `skin::tests::skin_dir_depth_cap_boundary` (walk side), `osk::tests::a_member_nested_past_the_depth_cap_refuses_the_import` and `osk::tests::a_non_skin_file_nested_past_the_depth_cap_is_ignored_rather_than_refused` (archive side) |
//! | [`MAX_SKIN_DIRS`] | 2,000 | subdirectories one skin walk may visit in total. the depth cap bounds nesting but not breadth: a folder of many thousand empty directories charges no file cap while making the scan arbitrarily slow, and a skin never legitimately holds more than a handful of asset folders. the `.osk` import charges the same cap against the directories its kept members would create, before extracting anything: `MAX_SKIN_FILES` members at `MAX_SKIN_DIR_DEPTH` name far more directories than the walk would agree to visit, and without it every one is created only for the load-side walk to refuse the result | `skin::tests::skin_dir_count_cap_boundary` (walk side) and `osk::tests::osk_dir_count_cap_boundary` (archive side) |
//!
//! a skin's `skin.ini` is bounded by `engine::limits::MAX_SKIN_INI_BYTES`
//! (checked against the file's declared length before the read, then again
//! inside the codec) and its sample half is charged against
//! `engine::limits::MAX_SAMPLE_BYTES`, which already documents itself as
//! spanning the beatmap's own files *and any skin's* -- so a skin and a mapset
//! cannot each spend the whole audio budget.
//!
//! per-candidate .osu reads inside the archive reuse
//! engine::limits::MAX_OSU_FILE_BYTES: a member larger than that could never
//! decode, so it is skipped as a non-candidate rather than failing the load
//! (its decompressed bytes still count against the scan budget above)

pub const MAX_OSZ_ENTRIES: usize = 10_000;
pub const MAX_OSZ_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_OSZ_SCAN_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_OSZ_FILE_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_RECENT_DIR_OSU_FILES: usize = 64;

/// longest history label apply_edit accepts, in bytes
pub const MAX_EDIT_LABEL_BYTES: usize = 256;

/// how many element-named image files one beatmap folder may contribute to
/// the texture lookup chain. counted beside the byte cap because zero-byte
/// files are invisible to it; matches [`MAX_SKIN_TEXTURES`] deliberately --
/// the beatmap's art is the other texture source this app reads, and the two
/// should not be refused on different scales
pub const MAX_BEATMAP_TEXTURES: usize = 10_000;

/// how many texture and sample files one skin directory may hold. real skins
/// sit in the low hundreds; the heaviest animated ones reach a few thousand.
/// this bounds the manifest the frontend receives and the map it resolves
/// lookups through
pub const MAX_SKIN_FILES: usize = 20_000;

/// total bytes of texture and sample files one skin may hold. a 4K-texture
/// skin with full animations reaches the low hundreds of megabytes; beyond
/// this it is not a skin this app can usefully draw
pub const MAX_SKIN_BYTES: u64 = 512 * 1024 * 1024;

/// byte length of any single skin asset. an individual osu! sprite is
/// kilobytes; a 4K `@2x` spinner background is a few megabytes
pub const MAX_SKIN_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// how many textures one skin may hold, separately from the file count,
/// because textures are the half that reaches the GPU
pub const MAX_SKIN_TEXTURES: usize = 10_000;

/// frames in a single animation set, counted per set. a set is `<element>-<n>`
/// or `<element><n>`: the separator is not always a hyphen, and the slider
/// ball -- the element this cap's hazard note names -- is one of the families
/// that has none. the
/// hazard is one element declaring an enormous frame sequence, not a skin
/// holding many short animations, so the budget is per set. real animated
/// elements run to a few dozen frames
pub const MAX_SKIN_ANIMATION_FRAMES: usize = 1_000;

/// how deep a skin's subdirectories may nest below its root. the walk follows
/// subfolders because skin.ini prefix keys name files at depth, but a skin is
/// untrusted input and the walk must be bounded; real prefixes sit one or two
/// levels down
pub const MAX_SKIN_DIR_DEPTH: usize = 8;

/// how many subdirectories one skin walk may visit in total. bounds the
/// breadth the depth cap cannot: empty directories charge no file cap while
/// making the scan arbitrarily slow
pub const MAX_SKIN_DIRS: usize = 2_000;
