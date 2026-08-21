//! `.osk` import: a skin the user downloaded but never installed becomes
//! usable.
//!
//! An `.osk` is a zip, so the archive primitive is [`crate::osz::open_osz`]
//! unchanged -- its file-length cap, its member-count cap, and its fail-closed
//! unsafe-name check (one traversal or absolute name rejects the whole archive)
//! all apply here. This app opens untrusted files, and importing a skin from
//! the internet must not be a risk.
//!
//! # Deliberate divergence: the destination is permanent, not a cache lease
//!
//! The beatmap archive path extracts into `cache_root` under a **lease**
//! ([`crate::cache::CacheLease`]), which is deleted the moment its scene is
//! replaced and whose orphans are collected at startup. Import does **not** use
//! that machinery, and a reader who knows the beatmap path will reasonably
//! assume it does. The reason is that a skin selection outlives the session: it
//! persists into the settings file as a locator, and orphan collection would
//! eventually delete the very directory that locator points at, turning a
//! deliberate choice into a mysterious fallback to the default. So an imported
//! skin lands in an app-owned directory that nothing collects.
//!
//! # Import is the only path that copies
//!
//! Stable and folder skins are referenced in place. An archive has nowhere else
//! to be read from, which is what makes this the exception rather than the
//! rule: copying a folder skin would duplicate disk for no gain and
//! desynchronise from a skin the user edits in place.

use std::path::Path;

use engine::formats::skin_ini::decode_skin_ini;

use crate::error::IpcError;
use crate::limits;
use crate::media::SAMPLE_EXTENSIONS;
use crate::osz::open_osz;
use crate::skin::{SkinLocator, TEXTURE_EXTENSIONS};

/// import an `.osk` into `skins_root`, returning the locator the selection
/// persists as.
///
/// importing the same skin name again REPLACES the previous copy rather than
/// accumulating another, so a user who re-downloads a skin does not end up with
/// `Skin`, `Skin (1)`, `Skin (2)` in their picker
pub fn import_osk(archive_path: &Path, skins_root: &Path) -> Result<SkinLocator, IpcError> {
    import_osk_with_budgets(archive_path, skins_root, &ImportBudgets::default())
}

/// the caps, as a parameter so the boundary tests can drive them with tiny
/// archives -- the same shape every other capped entry point in this crate uses
#[derive(Debug, Clone)]
pub struct ImportBudgets {
    pub max_files: usize,
    pub max_bytes: u64,
    pub max_file_bytes: u64,
    /// deepest member nesting the import accepts -- the walk-side
    /// `MAX_SKIN_DIR_DEPTH`, checked against member names before extraction
    pub max_depth: usize,
    /// most directories the import may create -- the walk-side `MAX_SKIN_DIRS`,
    /// counted from the kept member names before extraction. depth alone does
    /// not bound the work: `max_files` members at `max_depth` name far more
    /// directories than the walk will later agree to visit, and without this
    /// the import creates every one of them only for `validate_skin_dir` to
    /// refuse the result and delete them again
    pub max_dirs: usize,
}

impl Default for ImportBudgets {
    fn default() -> ImportBudgets {
        ImportBudgets {
            max_files: limits::MAX_SKIN_FILES,
            max_bytes: limits::MAX_SKIN_BYTES,
            max_file_bytes: limits::MAX_SKIN_FILE_BYTES,
            max_depth: limits::MAX_SKIN_DIR_DEPTH,
            max_dirs: limits::MAX_SKIN_DIRS,
        }
    }
}

pub fn import_osk_with_budgets(
    archive_path: &Path,
    skins_root: &Path,
    budgets: &ImportBudgets,
) -> Result<SkinLocator, IpcError> {
    let mut archive = open_osz(archive_path)?;

    // members worth keeping, with their relative paths preserved: skin.ini
    // prefix keys (`HitCirclePrefix: Assets/default/default`) name files at
    // depth, so a nested member is part of the skin rather than the author's
    // stray organisation. one leading component is still stripped when EVERY
    // member shares it, because a re-zipped archive wrapping the skin in its
    // own folder is common and that folder is not part of any prefix
    let names: Vec<String> = archive.names().iter().map(|name| name.replace('\\', "/")).collect();
    let prefix = common_root_prefix(&names);

    let mut wanted: Vec<(usize, String)> = Vec::new();
    // every directory the extraction below would create, deduplicated -- the
    // breadth the depth cap does not bound
    let mut dirs: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut any_at_root = false;
    for (index, name) in names.iter().enumerate() {
        let relative = match &prefix {
            Some(prefix) => name.strip_prefix(prefix.as_str()).unwrap_or(name),
            None => name.as_str(),
        };
        if relative.is_empty() || relative.ends_with('/') {
            continue;
        }
        // the resource-fork tree and finder metadata are the archiver's, not
        // the skinner's. before nested members were kept, `__MACOSX/` fell out
        // with everything else at depth; now it must be named
        if is_packaging_artefact(relative) {
            continue;
        }
        // EVERY path component must be one plain name. `split('/')` alone is
        // not enough: a windows drive-relative component like `c:evil.png`
        // holds no separator, yet `staging.join(it)` DISCARDS the staging root
        // and writes to the current directory of that drive. the archive-level
        // check refuses such a name too, so this is the second of two
        let components: Vec<&str> = relative.split('/').collect();
        if components
            .iter()
            .any(|component| !is_single_plain_name(component))
        {
            continue;
        }
        let depth = components.len() - 1;
        if is_inside_dot_directory(relative) {
            continue;
        }
        let lowered = relative.to_ascii_lowercase();
        let Some((_, extension)) = lowered.rsplit_once('.') else {
            continue;
        };
        // a lazer-authored `.osk` ships its heads-up-display layout as
        // `<container>.json`. this app has no such surface, so the layout is
        // ignored -- which is exactly what "accepted and resolved purely by
        // asset presence" means, and is why no third era appears
        let keep = lowered == "skin.ini"
            || TEXTURE_EXTENSIONS.contains(&extension)
            || SAMPLE_EXTENSIONS.contains(&extension);
        if !keep {
            continue;
        }
        if wanted.len() >= budgets.max_files {
            return Err(limit(
                "MAX_SKIN_FILES",
                budgets.max_files as u64,
                wanted.len() as u64 + 1,
            ));
        }
        // the two walk-side directory caps, charged against the member names
        // before anything is written -- a refusal here and a refusal from
        // `validate_skin_dir` below must be the same verdict, and this one
        // costs no extraction.
        //
        // charged AFTER the extension filter, because the staged tree only ever
        // holds what that filter kept: a source folder, a readme or a bundled
        // tool nested past the cap contributes no directory to the staging and
        // so is refused by neither side. checking before the filter would fail
        // an otherwise fine skin over a file it was never going to extract
        if depth > budgets.max_depth {
            return Err(limit(
                "MAX_SKIN_DIR_DEPTH",
                budgets.max_depth as u64,
                depth as u64,
            ));
        }
        // every ancestor directory the write would create, counted the way the
        // walk counts them: one per directory, deduplicated across members. the
        // staged names are the LOWERCASED ones, so these prefixes are exactly
        // the directories that will exist
        for (boundary, _) in lowered.match_indices('/') {
            let ancestor = &lowered[..boundary];
            if dirs.contains(ancestor) {
                continue;
            }
            dirs.insert(ancestor.to_string());
            if dirs.len() > budgets.max_dirs {
                return Err(limit("MAX_SKIN_DIRS", budgets.max_dirs as u64, dirs.len() as u64));
            }
        }
        any_at_root |= depth == 0;
        wanted.push((index, lowered));
    }

    // an archive that yields no ROOT-LEVEL skin file is REFUSED rather than
    // imported. nested files are only reachable through a root `skin.ini`'s
    // prefix keys, so a skin with nothing at its root resolves nothing -- and
    // the swap below retires the existing copy of the same name before it
    // renames the new one in, so proceeding here would destroy a working skin
    // and replace it with a directory that resolves nothing while reporting
    // success. reachable without malice: a re-packed archive nesting its files
    // two levels deep has no member left at the root after the single strip
    if !any_at_root {
        return Err(IpcError::BeatmapParse {
            message: "osk: the archive holds no skin files at its root".to_string(),
        });
    }

    // the destination name comes from the skin's OWN declared name, so
    // re-importing a renamed archive still replaces the same skin. read it
    // before anything is written -- there is nothing to clean up if the
    // archive turns out to be unusable
    let declared_name = wanted
        .iter()
        .find(|(_, name)| name == "skin.ini")
        .map(|(index, _)| *index)
        .and_then(|index| {
            archive
                .read_member_capped(index, engine::limits::MAX_SKIN_INI_BYTES)
                .ok()
                .flatten()
        })
        .and_then(|bytes| decode_skin_ini(&bytes).ok())
        .map(|ini| ini.name)
        .unwrap_or_default();

    let fallback = archive_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Imported Skin".to_string());
    let directory_name = safe_directory_name(&declared_name, &fallback);

    let destination = skins_root.join(&directory_name);
    // belt and braces over `safe_directory_name`: the destination is about to
    // be removed and rewritten, so it must provably sit directly under the
    // app-owned root before anything is deleted
    if destination.parent() != Some(skins_root) {
        return Err(IpcError::Internal {
            message: format!("refusing to import to {}", destination.display()),
        });
    }

    // extract into a staging directory first, then swap. a half-written skin
    // must never become the destination: the import replaces an existing copy,
    // and a failure part-way through would otherwise leave the user with
    // neither the old skin nor the new one
    let staging = skins_root.join(format!(".importing-{directory_name}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)?;

    let outcome = extract_members(&mut archive, &wanted, &staging, budgets);
    if let Err(error) = outcome {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }

    // every LOAD-side cap, checked against the staged copy while the
    // destination is still untouched. the import budgets bound the archive but
    // not the texture count, the animation frames, the sample bytes or the
    // `skin.ini` size -- so without this an archive that passes the import and
    // fails the load would replace the user's existing skin and only THEN be
    // refused, which is the opposite of refusing it whole
    if let Err(error) = crate::skin::validate_skin_dir(&staging) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }

    // retire the existing copy by RENAME rather than deleting it in place.
    // `remove_dir_all` deletes what it can and stops at the first entry it
    // cannot -- one locked or read-only file and the destination is left
    // half-gutted, the rename below then fails because it is not empty, and the
    // staging copy is discarded: precisely the "neither the old skin nor the
    // new one" state this whole dance exists to prevent
    let retired = skins_root.join(format!(".retiring-{directory_name}"));
    let _ = std::fs::remove_dir_all(&retired);
    let retired_existing = match std::fs::rename(&destination, &retired) {
        Ok(()) => true,
        // nothing to replace: a first import rather than a re-import
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error.into());
        }
    };
    if let Err(error) = std::fs::rename(&staging, &destination) {
        let _ = std::fs::remove_dir_all(&staging);
        // put the old skin back: a failed import leaves the user with exactly
        // what they had, which is the guarantee the staging directory promises
        if retired_existing {
            let _ = std::fs::rename(&retired, &destination);
        }
        return Err(error.into());
    }
    let _ = std::fs::remove_dir_all(&retired);

    Ok(SkinLocator::Imported {
        path: destination.to_string_lossy().into_owned(),
    })
}

fn extract_members(
    archive: &mut crate::osz::OszArchive,
    wanted: &[(usize, String)],
    staging: &Path,
    budgets: &ImportBudgets,
) -> Result<(), IpcError> {
    let mut written: u64 = 0;
    for (index, name) in wanted {
        let Some(bytes) = archive.read_member_capped(*index, budgets.max_file_bytes)? else {
            // the capped read stops at cap + 1 rather than expanding the member,
            // so the exact size is unknown and deliberately not guessed: the
            // reported `actual` is the smallest value that is over the cap,
            // which is what "we stopped counting here" honestly means
            return Err(limit(
                "MAX_SKIN_FILE_BYTES",
                budgets.max_file_bytes,
                budgets.max_file_bytes + 1,
            ));
        };
        written = written.saturating_add(bytes.len() as u64);
        if written > budgets.max_bytes {
            return Err(limit("MAX_SKIN_BYTES", budgets.max_bytes, written));
        }
        // every component of every kept name was proven to be one plain name
        // -- no parent, no root, no drive prefix -- so the join can only
        // descend. checked for real rather than debug-asserted: this is
        // third-party input and the write below is the one that matters
        let out_path = staging.join(name);
        if !out_path.starts_with(staging) {
            return Err(IpcError::Internal {
                message: format!("osk: kept name escaped staging: {name:?}"),
            });
        }
        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(out_path, &bytes)?;
    }
    Ok(())
}

/// exactly one plain file-name component.
///
/// the separator check upstream is necessary but not sufficient on windows: a
/// drive-relative name such as `c:evil.png` holds no separator, and because
/// `PathBuf::push` re-parses what it is given and drops the buffer when it
/// finds a prefix, `staging.join("c:evil.png")` evaluates to `c:evil.png` --
/// outside the app-owned root entirely. rebuilding through `components()` is
/// what makes "a plain name" mean it
fn is_single_plain_name(name: &str) -> bool {
    let mut components = std::path::Path::new(name).components();
    let Some(std::path::Component::Normal(only)) = components.next() else {
        return false;
    };
    if components.next().is_some() {
        return false;
    }
    // a `Normal` component can still carry a drive prefix once re-parsed alone
    let bytes = only.to_string_lossy().into_owned().into_bytes();
    !(bytes.first().is_some_and(u8::is_ascii_alphabetic) && bytes.get(1) == Some(&b':'))
}

/// names an archiver added rather than the skinner: macos' resource-fork
/// sidecar tree and the finder's own metadata file. neither can be a skin file,
/// and both otherwise read as a second root
fn is_packaging_artefact(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    lowered.starts_with("__macosx/")
        || lowered == ".ds_store"
        || lowered.ends_with("/.ds_store")
        || lowered.starts_with("._")
        || lowered.contains("/._")
}

/// whether any DIRECTORY component of a member is a dot-directory.
///
/// the load-side walk skips such a directory whole (`.git` is common in
/// distributed skins), so the import treats its members as not the skin's:
/// neither extracted, nor charged against the directory caps, nor counted as a
/// root. without that the two sides disagree -- an archive carrying a deep
/// `.cache/` would be refused over a tree the walk was going to ignore, and
/// every file under it would be staged as dead weight.
///
/// the FILE name is deliberately not checked, because the walk does not check
/// it either; `._` sidecars are named by [`is_packaging_artefact`] instead.
///
/// a bare `.` is NOT a dot-directory: it names no directory at all, and
/// `osz::safe_relative_path` drops it as the no-op it is, so an archive written
/// by a tool that joins member names on "." must keep loading
fn is_inside_dot_directory(name: &str) -> bool {
    name.rsplit_once('/').is_some_and(|(directories, _)| {
        directories
            .split('/')
            .any(|part| part.starts_with('.') && part != "." && part != "..")
    })
}

/// the single leading directory component every member shares, or `None`.
///
/// `None` when the archive is flat, when its members share no root, or when a
/// member sits at the archive root beside a folder -- the last case being an
/// archive whose structure is ambiguous, where stripping nothing is the answer
/// that cannot lose a file
fn common_root_prefix(names: &[String]) -> Option<String> {
    // a packaging artefact is not a second root. macos zips carry `__MACOSX/`
    // beside the real folder, and treating that as an ambiguous two-root
    // archive would strip nothing -- which then skips every member, since they
    // are all still one level down, and refuses a plainly complete skin
    let skin_members: Vec<&String> = names
        .iter()
        .filter(|name| !is_packaging_artefact(name))
        .collect();

    // the wrapper first, whatever it is named: when every member shares one
    // root, that root IS the wrapper, and whether it happens to be dot-prefixed
    // is not this function's business -- a skin zipped from a hidden folder
    // strips down to a perfectly ordinary skin, and the staged tree holds no
    // dot-directory at all
    if let Some(prefix) = single_root(skin_members.iter().copied()) {
        return Some(prefix);
    }
    // only once the members DISAGREE is a dot-directory an intruder rather than
    // the wrapper, and only then is it worth discounting: it is skipped whole
    // during selection, as the load-side walk skips it, so an archiver's
    // `.cache/` beside the skin's own folder must not be the second root that
    // stops that folder from being stripped -- exactly as `__MACOSX/` must not
    single_root(
        skin_members
            .into_iter()
            .filter(|name| !is_inside_dot_directory(name)),
    )
}

/// the one leading component every given name shares, or `None` when they
/// disagree, when there are none, or when any of them sits at the archive root
fn single_root<'a>(names: impl Iterator<Item = &'a String>) -> Option<String> {
    let mut prefix: Option<String> = None;
    for name in names {
        // a member with no separator sits at the archive root. that is either a
        // flat archive (nothing to strip) or one whose structure is ambiguous,
        // and in both cases stripping nothing is the answer that cannot lose a
        // file -- so the whole scan gives up here rather than per member
        let (root, _) = name.split_once('/')?;
        let candidate = format!("{root}/");
        match &prefix {
            Some(existing) if *existing != candidate => return None,
            Some(_) => {}
            None => prefix = Some(candidate),
        }
    }
    prefix
}

/// a directory name derived from a skin's declared name, safe to join onto the
/// app-owned root.
///
/// every separator, parent component and control character is stripped rather
/// than escaped: the result is only ever a display convenience -- the locator
/// carries the real path -- so a name that sanitises down to nothing simply
/// falls back to the archive's own file stem
fn safe_directory_name(declared: &str, fallback: &str) -> String {
    let cleaned: String = declared
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(character, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                && *character != '\u{fffd}'
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if !cleaned.is_empty() {
        return truncate_name(cleaned);
    }
    let fallback: String = fallback
        .chars()
        .filter(|character| {
            !character.is_control()
                && !matches!(character, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
        .collect();
    let fallback = fallback.trim().trim_matches('.').trim();
    if fallback.is_empty() {
        "Imported Skin".to_string()
    } else {
        truncate_name(fallback)
    }
}

/// windows' own component limit is 255; staying well inside it leaves room for
/// the `.importing-` staging prefix this module prepends
const MAX_DIRECTORY_NAME_CHARS: usize = 120;

fn truncate_name(name: &str) -> String {
    name.chars().take(MAX_DIRECTORY_NAME_CHARS).collect()
}

fn limit(cap: &str, limit: u64, actual: u64) -> IpcError {
    IpcError::ResourceLimit {
        cap: cap.to_string(),
        limit,
        actual,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skin::{load_skin, SkinSource};
    use crate::testutil::write_osz;
    use std::path::PathBuf;

    fn temp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("osk-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn imported_dir(locator: &SkinLocator) -> PathBuf {
        match locator {
            SkinLocator::Imported { path } => PathBuf::from(path),
            other => panic!("expected an imported locator, got {other:?}"),
        }
    }

    #[test]
    fn an_osk_imports_into_the_app_owned_directory_and_becomes_loadable() {
        let root = temp("import");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("downloaded.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Downloaded\nAuthor: Nobody\nVersion: 2.5\n"),
                ("cursor.png", b"x"),
                ("normal-hitnormal.wav", b"xx"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let dir = imported_dir(&locator);
        assert_eq!(dir.parent().unwrap(), skins);
        assert_eq!(dir.file_name().unwrap(), "Downloaded");

        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.source, SkinSource::Imported);
        assert_eq!(manifest.name, "Downloaded");
        assert_eq!(manifest.config.version, 2.5);
        assert_eq!(
            manifest.files.keys().collect::<Vec<_>>(),
            vec!["cursor.png", "normal-hitnormal.wav"]
        );
    }

    #[test]
    fn a_drive_relative_member_name_cannot_escape_the_staging_directory() {
        // `staging.join("c:evil.png")` is `c:evil.png`, not a path under
        // staging: `PathBuf::push` re-parses what it is handed and drops the
        // buffer when it finds a prefix. the name holds no separator, so the
        // separator check alone lets it through -- and a wrapping folder hides
        // it from a check that only looks at the start of the whole name
        let root = temp("driveesc");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("evil.osk");
        write_osz(
            &osk,
            &[
                ("wrapper/skin.ini", b"[General]
Name: Evil
"),
                ("wrapper/c:evil.png", b"pwned"),
            ],
        );

        // refused whole at the archive boundary rather than partially imported
        let result = import_osk(&osk, &skins);
        assert!(result.is_err(), "a drive-relative member is refused, got {result:?}");
        assert!(
            !std::path::Path::new("c:evil.png").exists(),
            "nothing was written outside the app-owned root"
        );
    }

    #[test]
    fn a_dot_slash_prefixed_archive_still_imports() {
        // a leading `./` is a no-op component, not an escape -- rust keeps it
        // where it drops a mid-path one. tools that join member names on "."
        // write archives like this, and they used to load
        let root = temp("dotslash");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("dotted.osk");
        write_osz(
            &osk,
            &[
                ("./skin.ini", b"[General]
Name: Dotted
"),
                ("./cursor.png", b"x"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("a dot-slash archive is safe and imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.name, "Dotted");
        assert!(manifest.files.contains_key("cursor.png"));
    }

    #[test]
    fn a_plain_name_check_admits_ordinary_files_and_refuses_drive_prefixes() {
        assert!(is_single_plain_name("cursor.png"));
        assert!(is_single_plain_name("normal-hitnormal.wav"));
        assert!(is_single_plain_name("sliderb0@2x.png"));
        assert!(!is_single_plain_name("c:evil.png"));
        assert!(!is_single_plain_name("C:evil.png"));
        assert!(!is_single_plain_name("sub/cursor.png"));
        assert!(!is_single_plain_name(".."));
        assert!(!is_single_plain_name(""));
    }

    #[test]
    fn a_wrapping_folder_is_stripped_so_the_skin_stays_flat() {
        let root = temp("wrapped");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("wrapped.osk");
        write_osz(
            &osk,
            &[
                ("My Skin/skin.ini", b"[General]\nName: Wrapped\n"),
                ("My Skin/cursor.png", b"x"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.files.keys().collect::<Vec<_>>(), vec!["cursor.png"]);
        assert_eq!(manifest.name, "Wrapped");
    }

    #[test]
    fn a_nested_member_imports_with_its_relative_path() {
        // the skin.ini prefix shape: digit glyphs in a subfolder, resolvable
        // only if the import preserves the path the prefix names
        let root = temp("nested-members");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("nested.osk");
        write_osz(
            &osk,
            &[
                (
                    "skin.ini",
                    b"[Fonts]\nHitCirclePrefix: Assets/Default/default\n" as &[u8],
                ),
                ("Assets/Default/default-0.png", b"x"),
                ("cursor.png", b"y"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert!(
            manifest.files.contains_key("assets/default/default-0.png"),
            "got keys {:?}",
            manifest.files.keys().collect::<Vec<_>>()
        );
    }

    #[test]
    fn a_wrapping_folder_strip_leaves_nested_paths_intact_below_it() {
        let root = temp("wrapped-nested");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("wrapped-nested.osk");
        write_osz(
            &osk,
            &[
                ("My Skin/skin.ini", b"[General]\nName: Wrapped\n" as &[u8]),
                ("My Skin/Assets/x.png", b"x"),
                ("My Skin/cursor.png", b"y"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(
            manifest.files.keys().collect::<Vec<_>>(),
            vec!["assets/x.png", "cursor.png"]
        );
    }

    #[test]
    fn a_member_nested_past_the_depth_cap_refuses_the_import() {
        let root = temp("deep-members");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("deep.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Deep\n" as &[u8]),
                ("a/b/x.png", b"x"),
            ],
        );

        let budgets = ImportBudgets {
            max_depth: 1,
            ..ImportBudgets::default()
        };
        let error = import_osk_with_budgets(&osk, &skins, &budgets).expect_err("refused");
        assert!(
            matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_DIR_DEPTH"),
            "got {error:?}"
        );
        // refused during member selection, before staging exists -- nothing to
        // clean up and nothing written
        assert!(std::fs::read_dir(&skins).unwrap().next().is_none());
    }

    #[test]
    fn a_non_skin_file_nested_past_the_depth_cap_is_ignored_rather_than_refused() {
        // the depth cap is charged after the extension filter, because the
        // staged tree only holds what that filter kept: a source tree or a
        // bundled tool buried in the archive contributes no directory to the
        // staging, so `validate_skin_dir` would not refuse it either. the two
        // verdicts have to agree
        let root = temp("deep-non-skin");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("deep-non-skin.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Sourced\n" as &[u8]),
                ("cursor.png", b"x"),
                ("src/art/layers/psd/backup/notes.txt", b"not a skin file"),
            ],
        );

        let budgets = ImportBudgets {
            max_depth: 1,
            ..ImportBudgets::default()
        };
        let locator = import_osk_with_budgets(&osk, &skins, &budgets).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.name, "Sourced");
        assert_eq!(manifest.files.keys().collect::<Vec<_>>(), vec!["cursor.png"]);
    }

    #[test]
    fn a_dot_directory_is_skipped_whole_as_the_walk_skips_it() {
        // the walk ignores a dot-directory entirely, so the import must not
        // stage its files NOR charge them against the directory caps -- a deep
        // `.cache/` would otherwise refuse an archive over a tree the skin
        // never resolves through
        let root = temp("dot-dir");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("dotted-dir.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Dotless\n" as &[u8]),
                ("cursor.png", b"x"),
                (".cache/a/b/c/d/icon.png", b"not the skin's"),
            ],
        );

        let budgets = ImportBudgets {
            max_depth: 1,
            max_dirs: 1,
            ..ImportBudgets::default()
        };
        let locator = import_osk_with_budgets(&osk, &skins, &budgets).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.name, "Dotless");
        assert_eq!(manifest.files.keys().collect::<Vec<_>>(), vec!["cursor.png"]);
    }

    #[test]
    fn a_dot_prefixed_wrapping_folder_is_stripped_like_any_other() {
        // the wrapper is whatever EVERY member shares, dot-prefixed or not:
        // discounting it as an intruder would leave the archive with no root
        // shared by anything, drop every member as nested inside a
        // dot-directory, and refuse a skin that strips down to an ordinary one
        let root = temp("dot-wrapper");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("dot-wrapper.osk");
        write_osz(
            &osk,
            &[
                (".HiddenSkin/skin.ini", b"[General]\nName: Hidden\n" as &[u8]),
                (".HiddenSkin/cursor.png", b"x"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.name, "Hidden");
        assert_eq!(manifest.files.keys().collect::<Vec<_>>(), vec!["cursor.png"]);
    }

    #[test]
    fn a_dot_directory_is_not_the_second_root_that_stops_the_strip() {
        // the packaging-artefact case, reached through a dot-directory: an
        // archiver's `.cache/` beside the skin's own wrapping folder must not
        // read as an ambiguous two-root archive, or nothing is stripped, the
        // real skin stays one level down, and a plainly complete skin is
        // refused for holding no file at its root
        let root = temp("dot-dir-root");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("dotted-root.osk");
        write_osz(
            &osk,
            &[
                ("My Skin/skin.ini", b"[General]\nName: Wrapped\n" as &[u8]),
                ("My Skin/cursor.png", b"y"),
                (".cache/junk.png", b"not the skin's"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.name, "Wrapped");
        assert_eq!(manifest.files.keys().collect::<Vec<_>>(), vec!["cursor.png"]);
    }

    #[test]
    fn osk_dir_count_cap_boundary() {
        // depth alone does not bound the extraction work: members well inside
        // the depth and file caps can still name far more directories than the
        // walk will agree to visit, and every one of them would be created
        // before `validate_skin_dir` refused the result and deleted it again
        let root = temp("osk-cap-dirs");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("broad.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Broad\n" as &[u8]),
                ("a/x.png", b"x"),
                ("b/y.png", b"y"),
                ("c/z.png", b"z"),
            ],
        );

        let within = ImportBudgets {
            max_dirs: 3,
            ..ImportBudgets::default()
        };
        assert!(import_osk_with_budgets(&osk, &skins, &within).is_ok());

        let past = ImportBudgets {
            max_dirs: 2,
            ..ImportBudgets::default()
        };
        let error = import_osk_with_budgets(&osk, &skins, &past).expect_err("past the cap");
        assert!(
            matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_DIRS"),
            "got {error:?}"
        );
    }

    #[test]
    fn nested_members_sharing_a_folder_charge_that_folder_once() {
        // deduplicated across members, the way the walk counts: one directory,
        // however many files sit in it
        let root = temp("osk-shared-dir");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("shared.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Shared\n" as &[u8]),
                ("assets/default-0.png", b"x"),
                ("assets/default-1.png", b"y"),
                ("assets/default-2.png", b"z"),
            ],
        );

        let budgets = ImportBudgets {
            max_dirs: 1,
            ..ImportBudgets::default()
        };
        assert!(import_osk_with_budgets(&osk, &skins, &budgets).is_ok());
    }

    #[test]
    fn an_ambiguous_archive_structure_strips_nothing_rather_than_guessing() {
        // a member at the archive root beside a folder: stripping the folder
        // would be a guess, and the answer that cannot lose a file is to strip
        // nothing. the nested member keeps its own path rather than being
        // flattened into the root, where it could have collided with a file
        // already there
        let root = temp("ambiguous");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("ambiguous.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Ambiguous\n"),
                ("cursor.png", b"x"),
                ("extras/spare-cursor.png", b"y"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.name, "Ambiguous");
        assert_eq!(
            manifest.files.keys().collect::<Vec<_>>(),
            vec!["cursor.png", "extras/spare-cursor.png"]
        );
    }

    #[test]
    fn a_macos_zipped_skin_still_finds_its_root() {
        // `__MACOSX/` is the archiver's, not the skinner's. counting it as a
        // second root would strip nothing, which then skips every member (they
        // are all one level down) and refuses a plainly complete skin
        let root = temp("macos");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("mac.osk");
        write_osz(
            &osk,
            &[
                ("__MACOSX/._skin.ini", b"resource fork" as &[u8]),
                ("__MACOSX/cursor.png", b"not the skin's cursor"),
                ("MySkin/skin.ini", b"[General]
Name: MySkin
"),
                ("MySkin/cursor.png", b"x"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("the real root is found");
        let manifest = load_skin(&locator).expect("loads");
        assert_eq!(manifest.name, "MySkin");
        assert!(manifest.files.contains_key("cursor.png"));
        // and the sidecar did not come along -- not as a root file, and now
        // that nested members import, not as a `__macosx/` subfolder either
        assert!(!manifest.files.keys().any(|name| name.starts_with("._")));
        assert!(!manifest.files.keys().any(|name| name.starts_with("__macosx/")));
    }

    #[test]
    fn two_unrelated_roots_strip_nothing_either() {
        let root = temp("two-roots");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("two-roots.osk");
        write_osz(&osk, &[("a/cursor.png", b"x"), ("b/hitcircle.png", b"y")]);

        // nothing shared a root, so nothing was stripped and no member sits at
        // the archive root -- and nested files are only reachable through a
        // root skin.ini's prefix keys, so this is a refusal rather than an
        // import that resolves nothing: the swap would otherwise destroy a
        // working skin of the same name and report success
        let error = import_osk(&osk, &skins).expect_err("an archive with no root member is refused");
        assert!(
            matches!(&error, IpcError::BeatmapParse { message } if message.contains("no skin files")),
            "got {error:?}"
        );
    }

    #[test]
    fn an_archive_breaching_a_load_cap_leaves_the_existing_skin_alone() {
        // the import budgets bound the ARCHIVE; the load budgets bound what the
        // skin then costs to use. an archive that passes the first and fails the
        // second must not have replaced anything by the time it is refused
        let root = temp("load-cap");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();

        let first = root.join("first.osk");
        write_osz(
            &first,
            &[
                ("skin.ini", b"[General]
Name: Same
"),
                ("cursor.png", b"original"),
            ],
        );
        import_osk(&first, &skins).expect("the first import lands");

        // an animation set past MAX_SKIN_ANIMATION_FRAMES: fine by the archive
        // budgets (tiny, few files) and refused by the load budgets
        let mut members: Vec<(String, Vec<u8>)> =
            vec![("skin.ini".to_string(), b"[General]
Name: Same
".to_vec())];
        for frame in 0..=crate::limits::MAX_SKIN_ANIMATION_FRAMES {
            members.push((format!("followpoint-{frame}.png"), b"x".to_vec()));
        }
        let borrowed: Vec<(&str, &[u8])> = members
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
            .collect();
        let second = root.join("second.osk");
        write_osz(&second, &borrowed);

        let error = import_osk(&second, &skins).expect_err("refused on a load cap");
        assert!(
            matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_ANIMATION_FRAMES"),
            "got {error:?}"
        );

        // and the skin the user already had is untouched
        let kept = skins.join("Same");
        assert_eq!(std::fs::read(kept.join("cursor.png")).unwrap(), b"original");
        // no staging or retiring directory left behind either
        assert!(!skins.join(".importing-Same").exists());
        assert!(!skins.join(".retiring-Same").exists());
    }

    #[test]
    fn re_importing_the_same_skin_replaces_rather_than_accumulates() {
        let root = temp("reimport");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();

        let first = root.join("v1.osk");
        write_osz(
            &first,
            &[("skin.ini", b"[General]\nName: Same\n"), ("cursor.png", b"old")],
        );
        let second = root.join("v2.osk");
        write_osz(
            &second,
            &[
                ("skin.ini", b"[General]\nName: Same\n"),
                ("cursor.png", b"new"),
                ("hitcircle.png", b"added"),
            ],
        );

        let a = import_osk(&first, &skins).expect("imports");
        let b = import_osk(&second, &skins).expect("re-imports");
        assert_eq!(a, b, "the same skin name resolves to the same locator");

        let dirs: Vec<_> = std::fs::read_dir(&skins)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(dirs, vec!["Same".to_string()], "no accumulation");

        let manifest = load_skin(&b).expect("loads");
        assert_eq!(manifest.files.len(), 2, "the new copy's files, not the old one's");
        assert_eq!(
            std::fs::read(imported_dir(&b).join("cursor.png")).unwrap(),
            b"new".to_vec()
        );
    }

    #[test]
    fn a_lazer_osk_imports_with_its_layout_ignored() {
        let root = temp("lazer-osk");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("lazer.osk");
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Lazer Export\nVersion: latest\n"),
                ("MainHUDComponents.json", b"{\"version\":1}"),
                ("SongSelect.json", b"{}"),
                ("cursor@2x.png", b"x"),
            ],
        );

        let locator = import_osk(&osk, &skins).expect("imports");
        let manifest = load_skin(&locator).expect("loads");
        // the heads-up-display layout is not kept; the legacy-named asset is
        assert_eq!(manifest.files.keys().collect::<Vec<_>>(), vec!["cursor@2x.png"]);
        assert!(manifest.config.is_latest_version);
    }

    #[test]
    fn a_traversal_attempt_is_refused_by_the_archive_boundary() {
        let root = temp("traversal");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("evil.osk");
        write_osz(&osk, &[("../escaped.png", b"x"), ("cursor.png", b"y")]);

        assert!(import_osk(&osk, &skins).is_err());
        assert!(!root.join("escaped.png").exists());
    }

    #[test]
    fn an_absolute_member_name_is_refused_too() {
        let root = temp("absolute");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("absolute.osk");
        write_osz(&osk, &[("/etc/passwd.png", b"x")]);

        assert!(import_osk(&osk, &skins).is_err());
    }

    #[test]
    fn an_oversized_member_refuses_the_import_and_leaves_nothing_behind() {
        let root = temp("oversized");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("big.osk");
        write_osz(
            &osk,
            &[("skin.ini", b"[General]\nName: Big\n"), ("cursor.png", &[0u8; 64])],
        );

        let budgets = ImportBudgets {
            max_file_bytes: 16,
            ..ImportBudgets::default()
        };
        let error = import_osk_with_budgets(&osk, &skins, &budgets).expect_err("refused");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_FILE_BYTES"));
        // neither the destination nor the staging directory survives a refusal
        assert!(std::fs::read_dir(&skins).unwrap().next().is_none());
    }

    #[test]
    fn a_zip_bomb_is_refused_by_the_total_byte_budget() {
        let root = temp("bomb");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("bomb.osk");
        // highly compressible members: small on disk, large expanded, which is
        // exactly the shape a declared-size check would miss
        let payload = vec![0u8; 4096];
        write_osz(
            &osk,
            &[
                ("skin.ini", b"[General]\nName: Bomb\n"),
                ("a.png", &payload),
                ("b.png", &payload),
                ("c.png", &payload),
            ],
        );

        let budgets = ImportBudgets {
            max_bytes: 5_000,
            ..ImportBudgets::default()
        };
        let error = import_osk_with_budgets(&osk, &skins, &budgets).expect_err("refused");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_BYTES"));
        assert!(std::fs::read_dir(&skins).unwrap().next().is_none());
    }

    #[test]
    fn a_member_count_bomb_is_refused_before_anything_is_written() {
        let root = temp("many-members");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("many.osk");
        let entries: Vec<(String, Vec<u8>)> = (0..10)
            .map(|index| (format!("sprite{index}.png"), b"x".to_vec()))
            .collect();
        let borrowed: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(name, bytes)| (name.as_str(), bytes.as_slice()))
            .collect();
        write_osz(&osk, &borrowed);

        let budgets = ImportBudgets {
            max_files: 4,
            ..ImportBudgets::default()
        };
        let error = import_osk_with_budgets(&osk, &skins, &budgets).expect_err("refused");
        assert!(matches!(&error, IpcError::ResourceLimit { cap, .. } if cap == "MAX_SKIN_FILES"));
        assert!(std::fs::read_dir(&skins).unwrap().next().is_none());
    }

    #[test]
    fn an_unnamed_or_hostile_skin_name_lands_on_a_safe_directory() {
        assert_eq!(safe_directory_name("Normal Skin", "archive"), "Normal Skin");
        assert_eq!(safe_directory_name("", "archive"), "archive");
        assert_eq!(safe_directory_name("..", "archive"), "archive");
        assert_eq!(safe_directory_name("../../etc", "archive"), "etc");
        assert_eq!(safe_directory_name("a/b\\c", "archive"), "abc");
        assert_eq!(safe_directory_name("   ", "archive"), "archive");
        assert_eq!(safe_directory_name("\u{fffd}\u{fffd}", "archive"), "archive");
        assert_eq!(safe_directory_name("", ""), "Imported Skin");
        assert_eq!(safe_directory_name(&"x".repeat(400), "archive").chars().count(), 120);
    }

    #[test]
    fn an_unnamed_archive_falls_back_to_its_own_file_stem() {
        let root = temp("unnamed-archive");
        let skins = root.join("skins");
        std::fs::create_dir_all(&skins).unwrap();
        let osk = root.join("- Seoul v9 -.osk");
        write_osz(&osk, &[("cursor.png", b"x")]);

        let locator = import_osk(&osk, &skins).expect("imports");
        assert_eq!(imported_dir(&locator).file_name().unwrap(), "- Seoul v9 -");
    }
}
