// the metadata panel's mods section, as plain data: one row per effective
// mod with its changed settings, and the provenance line that says where
// the mods came from when it was not the block. the panel is a thin shell
// over these so a headless test can pin them against the native fixture

import type { LoadedScene } from "./scene-types";
import { formatMods } from "./format";

/** one effective mod as the panel lists it */
export interface EffectiveModRow {
	acronym: string;
	/** `key: value` per changed setting, in the block's own order; empty for
	 * a mod at its defaults, which is what makes the two distinguishable */
	settings: string[];
}

/** the mod rows the panel lists. a stable file keeps its legacy chips
 * exactly as before -- the bitfield's names through formatMods, one chip each
 * -- and a lazer file lists the block's own entries with their settings */
export function effectiveModRows(scene: LoadedScene): EffectiveModRow[] {
	const { configuration, replay } = scene;
	if (configuration.profile === "stable") {
		const text = formatMods(replay.mods);
		return text === "none" ? [] : text.split(" ").map((acronym) => ({ acronym, settings: [] }));
	}
	return configuration.mods.map((mod) => ({
		acronym: mod.acronym,
		settings: Object.entries(mod.settings).map(([key, value]) => `${key}: ${settingText(value)}`)
	}));
}

/** the chrome's mod chips: the effective acronyms, `NM` when there are
 * genuinely none, and `?` when the file's own list could not be read at all.
 * that last case is why this exists rather than each bar folding
 * `effectiveModRows` itself -- an unreadable block resolves to an EMPTY mod
 * list with `unresolvable` provenance, so a bar that only checks emptiness
 * chips "no mods" for a play whose mods are unknown, while the metadata
 * panel's provenance note beside it calls them exactly that */
export function modChipLabels(scene: LoadedScene): string[] {
	if (scene.configuration.provenance === "unresolvable") return ["?"];
	const acronyms = effectiveModRows(scene).map((row) => row.acronym);
	return acronyms.length === 0 ? ["NM"] : acronyms;
}

/** an opaque setting value as a short literal */
function settingText(value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
	return JSON.stringify(value);
}

/** the line that says where the mods came from, or null when they came from
 * where a reader expects: the bitfield on a stable file, the block on a lazer
 * one. an inferred list and an unresolvable one are both worth a sentence */
export function modProvenanceNote(scene: LoadedScene): string | null {
	switch (scene.configuration.provenance) {
		case "bitfield":
		case "block":
			return null;
		case "inferredFromBitfield":
			return "inferred from the legacy mod bitfield: the file carries no readable score-info block, which is how lazer's own reader falls back too";
		case "unresolvable":
			return "unresolved: the file's score-info block could not be read, so its mods are unknown";
	}
}
