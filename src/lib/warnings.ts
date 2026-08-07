// pure helpers for the scene's warning list -- display text plus the
// referentially-stable selector that reads it off the store. the status
// bar's warning chip (StatusBar.tsx) is the only renderer left; the old
// floating WarningBanners component these were extracted from is gone

import { formatMods } from "@/lib/format";
import type { LoadedSceneWarning } from "@/lib/scene-types";
import type { ViewerState } from "@/state/store";

export function warningText(w: LoadedSceneWarning): string {
	switch (w.kind) {
		case "audioMissing":
			return "audio file missing — playing silently on the internal clock";
		case "modsNotSimulated":
			return `mods not simulated (${formatMods(w.mods)}) — judgements, combo, and accuracy are hidden`;
		case "beatmapMismatch":
			return "beatmap doesn't match the replay (explicit override) — geometry may be wrong; judgements disabled";
	}
}

/**
 * pairs each warning with its display text, preserving array order exactly --
 * the backend pushes warnings in a fixed mismatch -> mods -> audio order and
 * that order is never sorted or reindexed on the way to the caller
 */
export function warningList(warnings: LoadedSceneWarning[]): { kind: LoadedSceneWarning["kind"]; text: string }[] {
	return warnings.map((w) => ({ kind: w.kind, text: warningText(w) }));
}

// a store selector feeds useSyncExternalStore, which compares each snapshot to
// the previous one by reference -- returning a fresh `[]` per call would make
// the snapshot never equal itself and re-render until react's depth limit trips.
// scene is null until a replay loads, so this default is the startup path
const NO_WARNINGS: LoadedSceneWarning[] = [];

export const selectWarnings = (s: ViewerState): LoadedSceneWarning[] => s.scene?.warnings ?? NO_WARNINGS;
