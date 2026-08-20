import { invoke } from "@tauri-apps/api/core";
import type {
	AudioSettings,
	EditDelta,
	EditingSettings,
	EditOp,
	EffectSettings,
	ExportResult,
	GameplaySettings,
	IpcError,
	KeybindOverrides,
	LoadedScene,
	OverlaySettings,
	Settings,
	SkinEntry,
	SkinLocator,
	SkinManifest,
	TimelineSettings
} from "./scene-types";

const IPC_ERROR_KINDS = new Set([
	"replayParse",
	"beatmapParse",
	"beatmapNotFound",
	"beatmapMismatch",
	"osuDbNotFound",
	"unsupportedMode",
	"resourceLimit",
	"io",
	"internal",
	"invalidEdit",
	"staleSession",
	"notEditable",
	"fileExists",
	"exportOverflow"
]);

export function isIpcError(e: unknown): e is IpcError {
	return (
		typeof e === "object" &&
		e !== null &&
		"kind" in e &&
		typeof (e as { kind: unknown }).kind === "string" &&
		IPC_ERROR_KINDS.has((e as { kind: string }).kind)
	);
}

/** the one open. only the path travels: the beatmap association rust stores
 * for this `.osr` is rust's copy to read and refresh, and sending it back would
 * be a second copy to keep in sync (docs/adr/0005) */
export function invokeLoadReplay(osrPath: string): Promise<LoadedScene> {
	return invoke<LoadedScene>("load_replay", { osrPath });
}

export function invokeLoadReplayWithBeatmap(
	osrPath: string,
	beatmapPath: string,
	allowMismatch: boolean
): Promise<LoadedScene> {
	return invoke<LoadedScene>("load_replay_with_beatmap", { osrPath, beatmapPath, allowMismatch });
}

export function invokeGetSettings(): Promise<Settings> {
	return invoke<Settings>("get_settings");
}

export function invokeSetOsuStablePath(path: string | null): Promise<Settings> {
	return invoke<Settings>("set_osu_stable_path", { path });
}

export function invokeSetViewerPrefs(
	volume: number,
	audio: AudioSettings,
	gameplay: GameplaySettings,
	overlays: OverlaySettings,
	editing: EditingSettings,
	effects: EffectSettings,
	timeline: TimelineSettings,
	keybinds: KeybindOverrides
): Promise<Settings> {
	return invoke<Settings>("set_viewer_prefs", {
		volume,
		audio,
		gameplay,
		overlays,
		editing,
		effects,
		timeline,
		keybinds
	});
}

export function invokeClearRecents(): Promise<Settings> {
	return invoke<Settings>("clear_recents");
}

/** every skin the app knows about: the bundled row, the detected stable
 * install's, then the imported ones. a refused skin is IN this list, carrying
 * its reason -- omitting it would leave the user hunting for a skin they can
 * see on disk */
export function invokeListSkins(): Promise<SkinEntry[]> {
	return invoke<SkinEntry[]>("list_skins");
}

/** the persisted selection, resolved. a locator that no longer points at a
 * skin comes back as the bundled default with `fellBack` set: a miss, not an
 * error, on the same terms as a stale beatmap association */
export function invokeGetSkin(): Promise<SkinManifest> {
	return invoke<SkinManifest>("get_skin");
}

export function invokeSetSkin(locator: SkinLocator): Promise<SkinManifest> {
	return invoke<SkinManifest>("set_skin", { locator });
}

export function invokeImportSkin(path: string): Promise<SkinManifest> {
	return invoke<SkinManifest>("import_skin", { path });
}

export function invokeApplyEdit(epoch: number, baseRevision: number, ops: EditOp[], label: string): Promise<EditDelta> {
	return invoke<EditDelta>("apply_edit", { epoch, baseRevision, ops, label });
}

export function invokeUndo(epoch: number): Promise<EditDelta> {
	return invoke<EditDelta>("undo", { epoch });
}

export function invokeRedo(epoch: number): Promise<EditDelta> {
	return invoke<EditDelta>("redo", { epoch });
}

export function invokeRevertAll(epoch: number): Promise<EditDelta> {
	return invoke<EditDelta>("revert_all", { epoch });
}

export function invokeResync(epoch: number): Promise<EditDelta> {
	return invoke<EditDelta>("resync", { epoch });
}

export function invokeExportReplay(epoch: number, destPath: string, overwrite: boolean): Promise<ExportResult> {
	return invoke<ExportResult>("export_replay", { epoch, destPath, overwrite });
}
