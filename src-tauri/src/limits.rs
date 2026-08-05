//! app-layer resource caps, following the engine::limits pattern: every cap
//! is a named constant with a boundary test, surfaced across ipc as the
//! typed ResourceLimit error. engine-side caps (file sizes, object counts,
//! lzma, frames, simulation work) live in engine::limits; these two cover
//! the archive handling the spec's error-handling section assigns to this
//! layer ("archive entry count/expanded size")
//!
//! | constant | value | what it guards | boundary test |
//! |---|---|---|---|
//! | [`MAX_OSZ_ENTRIES`] | 10,000 | member count of an .osz archive, checked in osz::open_osz before any entry is read -- real mapsets hold at most a few hundred files | `osz::tests::entry_count_cap_boundary` |
//! | [`MAX_OSZ_EXTRACTED_BYTES`] | 512 MiB | total bytes actually written while extracting required members (matched .osu + referenced media), charged chunk by chunk as they are copied so a lying zip size header cannot help -- declared sizes are never trusted. required media is one audio file and one background image; real sets sit two orders of magnitude below | `osz::tests::extracted_bytes_cap_boundary` (parameterized budget, mirroring engine's capped entry points) |
//! | [`MAX_OSZ_SCAN_BYTES`] | 512 MiB | total decompressed bytes across all .osu candidates read while scanning an archive for an md5 match (osz::find_osu_by_md5) -- without an aggregate budget, an archive of many maximum-size members could force per-candidate decompression far past any single-file cap on the way to not-found; each read is additionally clamped to the budget's remainder so real decompression cannot outrun the cap by more than one byte | `osz::tests::scan_budget_boundary` (parameterized budget, mirroring engine's capped entry points) |
//! | [`MAX_OSZ_FILE_BYTES`] | 1 GiB | byte length of the .osz file itself, checked before anything is read -- the central-directory metadata zip retains while opening (entry names, extra fields, comments) is carved out of the file's own bytes, so this bounds open-time memory even for archives crafted to maximize retained metadata. the largest real mapsets (marathon video sets) sit well under half of it | `osz::tests::file_size_cap_boundary` (parameterized length, mirroring engine's capped entry points) |
//!
//! per-candidate .osu reads inside the archive reuse
//! engine::limits::MAX_OSU_FILE_BYTES: a member larger than that could never
//! decode, so it is skipped as a non-candidate rather than failing the load
//! (its decompressed bytes still count against the scan budget above)

pub const MAX_OSZ_ENTRIES: usize = 10_000;
pub const MAX_OSZ_EXTRACTED_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_OSZ_SCAN_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_OSZ_FILE_BYTES: u64 = 1024 * 1024 * 1024;
