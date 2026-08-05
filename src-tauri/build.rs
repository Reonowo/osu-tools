fn main() {
    // tauri-build's zero-config `build()` embeds its own bundled
    // comctl32-v6 manifest (windows-app-manifest.xml) via
    // `rustc-link-arg-bins`, which cargo scopes to `bin` targets only. that
    // leaves cargo test's lib unit-test harness (built from `#[cfg(test)]
    // mod tests` blocks, not a `[[test]]` integration target) with no
    // manifest at all: without common-controls-v6 activated, the loader
    // can't resolve muda's (tauri's native-menu dependency) TaskDialogIndirect
    // import against the legacy, non-v6 system comctl32.dll, and the test
    // harness crashes at process load before any test runs.
    //
    // `new_without_app_manifest()` turns tauri-build's own manifest off so
    // `embed_common_controls_v6_manifest()` below can be the single source
    // of truth for it, reaching bins *and* the test harness uniformly --
    // avoiding the alternative of running both, which duplicates the
    // RT_MANIFEST resource and fails the link with CVT1100 (verified: this
    // is not a hypothetical, it reproduced exactly that error before this
    // attributes change was added)
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest()),
    )
    .expect("tauri_build::try_build failed");

    // cfg(windows) would describe the build host here (build scripts run on
    // the host), silently skipping the manifest when a windows target is
    // cross-compiled; the target env var is what actually matters
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        embed_common_controls_v6_manifest();
    }
}

// reaching the test harness requires the fully unscoped
// `compile_for_everything` (-> plain `rustc-link-arg`): the seemingly-obvious
// `compile_for_tests` (-> `rustc-link-arg-tests`) is not it, since that scope
// only covers `[[test]]` integration-test targets under tests/, which this
// crate has none of -- cargo hard-errors ("does not have a test target")
// rather than silently skipping it. per embed-resource's own docs,
// `compile_for_everything` is the only variant that also covers
// `#[test]`/doctests, and it necessarily reaches the `bin` target too; see
// the comment in main() above for why that no longer conflicts with
// anything. resources/common-controls-v6.manifest is byte-for-byte the same
// dependency block tauri-build would otherwise have embedded on its own
fn embed_common_controls_v6_manifest() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("no CARGO_MANIFEST_DIR");
    let manifest_path = std::path::Path::new(&manifest_dir).join("resources").join("common-controls-v6.manifest");
    // forward slashes sidestep rc.exe's backslash-escaping rules entirely
    let manifest_path = manifest_path.display().to_string().replace('\\', "/");

    let out_dir = std::env::var("OUT_DIR").expect("no OUT_DIR");
    let rc_path = std::path::Path::new(&out_dir).join("common_controls_v6.rc");
    // resource id 1 is CREATEPROCESS_MANIFEST_RESOURCE_ID, type 24 is RT_MANIFEST;
    // written as raw numerics so the .rc needs no windows header includes
    std::fs::write(&rc_path, format!("1 24 \"{manifest_path}\"\n"))
        .expect("failed to write the manifest .rc");

    embed_resource::compile_for_everything(&rc_path, embed_resource::NONE)
        .manifest_required()
        .expect("failed to embed the comctl32-v6 manifest");
}
