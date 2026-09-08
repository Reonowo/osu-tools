// pure logic for the export dialog: default-path derivation, the path
// expectation keyed off the dirty split, overwrite-consent resolution, and
// the post-export summary rows. the ExportDialog component is the thin
// shell over these

import { isoDateFromTicks } from "./format";
import type { IpcError, RegeneratedFields } from "./scene-types";

/** which of the three export paths the document's dirty split selects */
export type ExportPathKind = "regenerating" | "carried" | "passthrough";

export function exportPathKind(framesDirty: boolean, metadataDirty: boolean): ExportPathKind {
	if (framesDirty) return "regenerating";
	if (metadataDirty) return "carried";
	return "passthrough";
}

/** what the user should expect BEFORE the file exists, per path. an
 * incomplete play's regenerating export is honest-by-construction: the
 * derived fields describe the exported frames' full-map simulation, decayed
 * tail included, and the copy says so before the user commits */
export function expectationCopy(kind: ExportPathKind, incomplete = false): string {
	switch (kind) {
		case "regenerating": {
			const base =
				"frames were edited: every derived header field is regenerated from the re-simulated timeline, the life bar graph included, and the replay hash is recomputed";
			const endedEarly =
				". this play ended early, so the regenerated fields describe the exported frames simulated over the whole map — every object past the end of the frames counts as a miss";
			return incomplete ? base + endedEarly : base;
		}
		case "carried":
			return "only metadata changed: the frame payload is carried byte-for-byte under the edited header, with the replay hash recomputed and the source's own life bar graph carried over";
		case "passthrough":
			return "no edits: the original file is re-emitted byte-identically, unknown trailing data included";
	}
}

/** the marker an edited export's default name carries before its extension.
 * shared with the video dialog's default file name -- the TEXT is shared,
 * the condition deliberately is not: this dialog appends it unconditionally
 * so the prefill never shadows the source `.osr`, while a synthesized video
 * name has nothing to shadow and marks only a dirty document */
export const EDITED_MARKER = " (edited)";

/** index of the last path separator, either slash kind, -1 when none -- the
 * one splitting rule every path-string decision in the export flows shares */
export function lastPathSeparator(path: string): number {
	return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

/** the destination the dialog prefills: the source path with the edited
 * marker before the extension, so the common case needs no typing and never
 * shadows the original */
export function defaultExportPath(osrPath: string): string {
	const sepIndex = lastPathSeparator(osrPath);
	const dotIndex = osrPath.lastIndexOf(".");
	// a dot inside the directory part, or leading a hidden-style name, is
	// not an extension separator
	if (dotIndex <= sepIndex + 1) return `${osrPath}${EDITED_MARKER}`;
	return `${osrPath.slice(0, dotIndex)}${EDITED_MARKER}${osrPath.slice(dotIndex)}`;
}

/** what a redirected prefill needs to know about the play, all of it already
 * on the loaded scene */
export interface ExportNaming {
	playerName: string | null;
	artist: string;
	title: string;
	version: string;
	/** .net ticks as the scene carries them */
	timestampTicks: string;
}

/** the app is std-only, so the mode suffix stable puts in an export name is
 * fixed. it is spelled out rather than omitted because a file missing it
 * does not sort or read like its neighbours in the folder */
const STABLE_MODE_SUFFIX = "Osu";

/** characters windows forbids in a file name, replaced with a space. this is
 * a PREFILL the user can edit, not a claim to reproduce stable's own
 * sanitisation -- what it has to be is a name the save dialog accepts */
const FORBIDDEN_IN_FILE_NAME = /[<>:"/\\|?*]/g;

function sanitizeFileName(name: string): string {
	return name.replace(FORBIDDEN_IN_FILE_NAME, " ");
}

/** windows paths are case-insensitive and mix separators, so a prefix test
 * has to normalise both before comparing */
function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function isInside(path: string, directory: string): boolean {
	const parent = normalizePath(directory);
	return parent.length > 0 && normalizePath(path).startsWith(`${parent}/`);
}

/** the separator the install root is already written with, so a prefill
 * reads like the path it came from rather than mixing both kinds */
function separatorOf(root: string): string {
	return root.includes("\\") ? "\\" : "/";
}

/**
 * the destination the export dialog prefills, given where the replay came
 * from.
 *
 * a play opened out of stable's `Data/r` is the case this exists for: that
 * folder is the client's own private data, and writing an edited replay into
 * it would put a file there stable never wrote and cannot account for. so a
 * source inside the install but outside its `Replays` folder is redirected
 * to `Replays` under stable's own export name -- `<player> - <artist> -
 * <title> [<version>] (<date>) Osu`, plus this app's edited marker.
 *
 * every other source keeps [`defaultExportPath`]'s rule, the Replays folder
 * included: a redirect that fired where it was not needed would move a file
 * the user had deliberately put somewhere.
 */
export function redirectedExportPath(osrPath: string, installRoot: string | null, naming: ExportNaming): string {
	if (installRoot === null) return defaultExportPath(osrPath);
	const separator = separatorOf(installRoot);
	const replaysDir = `${installRoot.replace(/[\\/]+$/, "")}${separator}Replays`;
	if (!isInside(osrPath, installRoot) || isInside(osrPath, replaysDir)) {
		return defaultExportPath(osrPath);
	}
	const date = isoDateFromTicks(naming.timestampTicks);
	// an empty player name leaves a leading " - ", exactly as stable's own
	// export of a guest play does
	const player = naming.playerName ?? "";
	const dated = date === null ? "" : ` (${date})`;
	const name = sanitizeFileName(
		`${player} - ${naming.artist} - ${naming.title} [${naming.version}]${dated} ${STABLE_MODE_SUFFIX}`
	);
	return `${replaysDir}${separator}${name}${EDITED_MARKER}.osr`;
}

/** the consent the first export attempt sends: with the overwrite warning
 * disabled, consent is granted by the setting itself and export overwrites
 * without asking */
export function initialOverwriteConsent(warnOnOverwrite: boolean): boolean {
	return !warnOnOverwrite;
}

/** whether a failed export should offer the overwrite confirmation instead
 * of rendering as a plain refusal */
export function offersOverwriteConfirm(error: IpcError): boolean {
	return error.kind === "fileExists";
}

/** the post-export summary for a regenerating export: each value the written
 * header now claims, plus the two dirty-export constants */
export function regeneratedSummaryRows(fields: RegeneratedFields): { label: string; value: string }[] {
	return [
		{ label: "300s", value: fields.count300.toLocaleString() },
		{ label: "100s", value: fields.count100.toLocaleString() },
		{ label: "50s", value: fields.count50.toLocaleString() },
		{ label: "misses", value: fields.countMiss.toLocaleString() },
		{ label: "geki / katu", value: `${fields.countGeki.toLocaleString()} / ${fields.countKatsu.toLocaleString()}` },
		{ label: "max combo", value: fields.maxCombo.toLocaleString() },
		{ label: "perfect", value: fields.perfect ? "yes" : "no" },
		{ label: "total score", value: fields.totalScore.toLocaleString() },
		{
			label: "life bar",
			// the graph is written either way -- the search not settling is a
			// caveat on the numbers behind it, not a missing field
			value: fields.lifeBarConverged ? "regenerated" : "regenerated (drain search did not converge)"
		},
		{ label: "replay hash", value: "recomputed" }
	];
}

/** the outcome sentence for the two paths that regenerate nothing */
export function outcomeCopy(kind: ExportPathKind, bytes: number): string {
	const size = `${bytes.toLocaleString()} bytes`;
	switch (kind) {
		case "passthrough":
			return `wrote ${size}, byte-identical to the source`;
		case "carried":
			return `wrote ${size} with the frame payload carried verbatim under the edited header`;
		case "regenerating":
			// exhaustiveness arm only: a regenerating success renders the
			// summary rows, never this sentence
			return `wrote ${size}`;
	}
}
