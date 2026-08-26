// pure logic for the video export flow: the export menu's contents, the
// availability gate, the default file name and save-dialog prefill, the
// progress display strings, and the generic blob accessors the renderer
// section reads and writes settings through. the VideoExportDialog component
// is the thin shell over these

import type {
	LoadedScene,
	RendererOptionsMap,
	SkinLocator,
	VideoProgressEvent,
	VideoSkinPolicy,
	VideoStage
} from "./scene-types";
import { EDITED_MARKER, lastPathSeparator } from "./export-flow";

/** the conventional per-backend blob key the install flow caches the encoder
 * probe's winner under (mirrors video::PROBED_ENCODER_KEY). generic -- "this
 * backend's probed encoder" -- while the VALUE only means something to the
 * backend that probed it; the renderer-specific keys live in
 * lib/danser-section.ts instead */
export const PROBED_ENCODER_KEY = "probedEncoder";

/** the two entries the top bar's export menu offers; the video entry carries
 * its gate's refusal so the menu can disable with the reason in place */
export interface ExportMenuEntry {
	id: "replay" | "video";
	label: string;
	disabledReason: string | null;
}

export type VideoExportGate = { available: true } | { available: false; reason: string };

/** video export is offered for every loaded replay -- lazer-written,
 * unsimulated and modded included (the renderer applies mods itself) --
 * except a consented-mismatch scene: the staged beatmap's hash is not the
 * one the replay carries, and an external renderer resolves beatmaps by
 * exactly that hash. TODO.md records the deferred md5-rewrite alternative */
export function videoExportGate(scene: LoadedScene): VideoExportGate {
	if (scene.simulation.status === "notSimulated" && scene.simulation.reason === "beatmapMismatch") {
		return { available: false, reason: "video export needs a matching beatmap" };
	}
	return { available: true };
}

export function exportMenuEntries(scene: LoadedScene): ExportMenuEntry[] {
	const gate = videoExportGate(scene);
	return [
		{ id: "replay", label: "export replay…", disabledReason: null },
		{ id: "video", label: "export video…", disabledReason: gate.available ? null : gate.reason }
	];
}

/** windows-reserved filename characters replaced with underscores, the same
 * substitution osu! itself makes when it names a score file */
export function sanitizeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}

/** the synthesized default: `<player> - <artist> - <title> [<diff>].mp4`,
 * gaining the edited marker exactly when the document is dirty -- the marker
 * TEXT is the replay dialog's, the condition deliberately not (that dialog
 * appends it unconditionally so its prefill never shadows the source `.osr`;
 * a synthesized video name has nothing to shadow) */
export function defaultVideoFileName(scene: Pick<LoadedScene, "beatmap" | "replay">, dirty: boolean): string {
	const player = scene.replay.playerName ?? "unknown";
	const { artist, title, version } = scene.beatmap;
	const stem = sanitizeFileName(`${player} - ${artist} - ${title} [${version}]`);
	return `${stem}${dirty ? EDITED_MARKER : ""}.mp4`;
}

/** the save dialog's prefill: the default name inside the last video dir
 * when one is remembered, the bare name (the picker's own default dir)
 * otherwise */
export function defaultVideoSavePath(fileName: string, lastVideoDir: string | null): string {
	if (lastVideoDir === null || lastVideoDir === "") return fileName;
	const trimmed = lastVideoDir.replace(/[\\/]+$/, "");
	return `${trimmed}\\${fileName}`;
}

/** the directory half of a picked destination, for remembering as
 * lastVideoDir; null when the path has no directory part */
export function directoryOfPath(path: string): string | null {
	const sepIndex = lastPathSeparator(path);
	if (sepIndex <= 0) return null;
	return path.slice(0, sepIndex);
}

/** the file-name half, for labelling an affordance after the file it opens */
export function fileNameOfPath(path: string): string {
	return path.slice(lastPathSeparator(path) + 1);
}

/** the folder name of a folder-based skin locator, or null for the bundled
 * one (which has no on-disk folder an external renderer could load) */
function skinFolderName(skin: SkinLocator): string | null {
	if (skin.kind === "bundled") return null;
	const name = fileNameOfPath(skin.path.replace(/[\\/]+$/, ""));
	return name === "" ? null : name;
}

/** the dialog's which-skin statement, mirroring the backend's mapping (spec
 * Q6): a folder-based active skin renders by name, the bundled skin cannot
 * follow (no folder exists for it) and falls to the renderer's default, as
 * does the explicit rendererDefault policy */
export function videoSkinStatement(policy: VideoSkinPolicy, skin: SkinLocator, rendererName: string): string {
	if (policy === "rendererDefault") {
		return `the video will use ${rendererName}'s default skin`;
	}
	const name = skinFolderName(skin);
	if (name === null) {
		return `the bundled skin has no folder an external renderer can load, so the video will use ${rendererName}'s default skin`;
	}
	return `the video will use the "${name}" skin`;
}

/** the stage line the progress surface shows */
export function stageLabel(stage: VideoStage): string {
	switch (stage) {
		case "staging":
			return "staging beatmap files";
		case "rendering":
			return "rendering";
		case "moving":
			return "moving the video into place";
		case "installing":
			return "downloading and installing";
	}
}

/** the compact percent/speed/eta line during rendering, pieces joined only
 * when the event carried them */
export function renderProgressLine(event: VideoProgressEvent): string {
	const parts: string[] = [];
	if (event.percent !== undefined) parts.push(`${Math.round(event.percent)}%`);
	if (event.speed !== undefined) parts.push(event.speed);
	if (event.eta !== undefined) parts.push(`ETA ${event.eta}`);
	return parts.join(" · ");
}

/** the consent dialog's size line: the backend reports exact bytes, the
 * dialog says "~31 MB" */
export function formatDownloadSize(bytes: number): string {
	return `~${Math.round(bytes / 1_000_000)} MB`;
}

/** reads one value inside a backend's blob by path; undefined anywhere along
 * the way answers undefined */
export function blobValue(options: RendererOptionsMap, backendId: string, path: readonly string[]): unknown {
	let node: unknown = options[backendId];
	for (const key of path) {
		if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

export function blobBool(
	options: RendererOptionsMap,
	backendId: string,
	path: readonly string[],
	fallback: boolean
): boolean {
	const value = blobValue(options, backendId, path);
	return typeof value === "boolean" ? value : fallback;
}

export function blobNumber(
	options: RendererOptionsMap,
	backendId: string,
	path: readonly string[],
	fallback: number
): number {
	const value = blobValue(options, backendId, path);
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function blobString(
	options: RendererOptionsMap,
	backendId: string,
	path: readonly string[],
	fallback: string
): string {
	const value = blobValue(options, backendId, path);
	return typeof value === "string" ? value : fallback;
}

/** writes one value inside a backend's blob by path, immutably, creating
 * objects along the way and replacing a non-object mid-path -- every other
 * key at every level survives, which is what keeps a dialog control from
 * scrubbing blob state it does not know about (the probe cache included) */
export function withBlobValue(
	options: RendererOptionsMap,
	backendId: string,
	path: readonly string[],
	value: unknown
): RendererOptionsMap {
	const setAt = (node: unknown, depth: number): Record<string, unknown> => {
		const base =
			typeof node === "object" && node !== null && !Array.isArray(node)
				? { ...(node as Record<string, unknown>) }
				: {};
		const key = path[depth];
		base[key] = depth === path.length - 1 ? value : setAt(base[key], depth + 1);
		return base;
	};
	if (path.length === 0) return options;
	return { ...options, [backendId]: setAt(options[backendId], 0) };
}
