import { invoke } from "@tauri-apps/api/core";
import type { EditingSettings, EffectSettings, IpcError, LoadedScene, OverlaySettings, Settings } from "./scene-types";

const IPC_ERROR_KINDS = new Set([
	"replayParse",
	"beatmapParse",
	"beatmapNotFound",
	"beatmapMismatch",
	"osuDbNotFound",
	"unsupportedMode",
	"resourceLimit",
	"io",
	"internal"
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

/** reopens a recents entry through the beatmap association rust stored with
 * it. only the path travels: the association is rust's copy to read and
 * refresh, and sending it back would be a second copy to keep in sync */
export function invokeLoadRecentReplay(osrPath: string): Promise<LoadedScene> {
	return invoke<LoadedScene>("load_recent_replay", { osrPath });
}

export function invokeGetSettings(): Promise<Settings> {
	return invoke<Settings>("get_settings");
}

export function invokeSetOsuStablePath(path: string | null): Promise<Settings> {
	return invoke<Settings>("set_osu_stable_path", { path });
}

export function invokeSetViewerPrefs(
	volume: number,
	overlays: OverlaySettings,
	editing: EditingSettings,
	effects: EffectSettings
): Promise<Settings> {
	return invoke<Settings>("set_viewer_prefs", { volume, overlays, editing, effects });
}

export function invokeClearRecents(): Promise<Settings> {
	return invoke<Settings>("clear_recents");
}
