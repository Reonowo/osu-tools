// pure logic for the export dialog: default-path derivation, the path
// expectation keyed off the dirty split, overwrite-consent resolution, and
// the post-export summary rows. the ExportDialog component is the thin
// shell over these

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
				"frames were edited: every derived header field is regenerated from the re-simulated timeline, the life bar is written empty, and the replay hash is recomputed";
			const endedEarly =
				". this play ended early, so the regenerated fields describe the exported frames simulated over the whole map — every object past the end of the frames counts as a miss";
			return incomplete ? base + endedEarly : base;
		}
		case "carried":
			return "only metadata changed: the frame payload is carried byte-for-byte under the edited header, with the replay hash recomputed and the life bar written empty";
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
		{ label: "life bar", value: "written empty" },
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
