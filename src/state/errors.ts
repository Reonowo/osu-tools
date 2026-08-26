// maps the typed ipc error union to user-facing copy plus the recovery the
// spec attaches to each kind (not-found -> manual picker, mismatch ->
// explicit override, db-not-found -> picker with a settings pointer)

import type { IpcError } from "../lib/scene-types";

export type Recovery = "pickBeatmap" | "openSettings" | "offerMismatch" | null;

export function describeIpcError(e: IpcError): { title: string; detail: string; recovery: Recovery } {
	switch (e.kind) {
		case "replayParse":
			return { title: "couldn't read the replay", detail: e.message, recovery: null };
		case "beatmapParse":
			return { title: "couldn't read the beatmap", detail: e.message, recovery: null };
		case "beatmapNotFound":
			return {
				title: "beatmap not found",
				detail: `no installed beatmap matches ${e.md5}; pick the .osu or .osz manually`,
				recovery: "pickBeatmap"
			};
		case "beatmapMismatch":
			return {
				title: "beatmap doesn't match the replay",
				detail: `the replay expects ${e.expectedMd5} but the picked file hashes to ${e.actualMd5}`,
				recovery: "offerMismatch"
			};
		case "osuDbNotFound":
			return {
				title: "osu! stable install not found",
				detail:
					e.searched.length > 0
						? `looked for osu!.db in: ${e.searched.join(", ")}. set the install path in settings, or pick the beatmap manually`
						: "set the install path in settings, or pick the beatmap manually",
				recovery: "pickBeatmap"
			};
		case "unsupportedMode":
			return {
				title: "unsupported game mode",
				detail: `${e.mode} isn't supported; only osu! standard`,
				recovery: null
			};
		case "resourceLimit":
			return {
				title: "file exceeds safety limits",
				detail: `${e.cap}: ${e.actual} > ${e.limit}`,
				recovery: null
			};
		case "io":
			return { title: "file error", detail: e.message, recovery: null };
		case "internal":
			return { title: "internal error", detail: e.message, recovery: null };
		case "invalidEdit":
			return { title: "couldn't apply the edit", detail: e.message, recovery: null };
		case "staleSession":
			return {
				title: "the edit hit a replaced session",
				detail: "the replay changed under this edit; the view resynced to the authoritative document",
				recovery: null
			};
		case "notEditable":
			return { title: "this replay can't be frame-edited", detail: e.reason, recovery: null };
		case "fileExists":
			return {
				title: "file already exists",
				detail: `${e.path} already exists; confirm the overwrite or pick another destination`,
				recovery: null
			};
		case "exportOverflow":
			return {
				title: "a derived value doesn't fit the header",
				detail: `${e.field} exceeds its on-disk width; the file can't claim it honestly`,
				recovery: null
			};
		case "rendererNotInstalled":
			return {
				title: "video renderer not installed",
				detail: "the renderer hasn't been downloaded yet; the export dialog offers the install",
				recovery: null
			};
		case "stagingFailed":
			return { title: "couldn't prepare the render", detail: e.message, recovery: null };
		case "renderFailed":
			return { title: "the render failed", detail: e.detail, recovery: null };
		case "cancelled":
			return { title: "export cancelled", detail: "the render was stopped and cleaned up", recovery: null };
		case "exportBusy":
			return {
				title: "an export is already running",
				detail: "one video operation runs at a time; wait for it or cancel it first",
				recovery: null
			};
	}
}
