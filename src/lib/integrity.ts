// pure presentation logic for the integrity report: field labels, value
// formatting, and the cross-check sentence. the analysis panel is the thin
// shell over these

import type { IntegrityReport } from "./scene-types";

const ROW_LABELS: Record<string, string> = {
	count300: "300s",
	count100: "100s",
	count50: "50s",
	countGeki: "geki",
	countKatsu: "katu",
	countMiss: "misses",
	maxCombo: "max combo",
	perfect: "perfect",
	totalScore: "total score"
};

export function integrityRowLabel(field: string): string {
	return ROW_LABELS[field] ?? field;
}

/** perfect rides the wire as 0/1; every other field is a plain count */
export function integrityRowValue(field: string, value: number): string {
	if (field === "perfect") return value === 0 ? "no" : "yes";
	return value.toLocaleString();
}

/** TODO.md's identity stated outright, with the header's own miss count
 * beside the implication it checks */
export function describeCrossCheck(crossCheck: IntegrityReport["crossCheck"]): string {
	const { sections, gekiKatsu, sectionsWithMiss, countMiss } = crossCheck;
	return `${sections.toLocaleString()} sections − ${gekiKatsu.toLocaleString()} geki+katu = ${sectionsWithMiss.toLocaleString()} with a miss · header misses ${countMiss.toLocaleString()}`;
}

/** the identity can only expose a header when it demands more miss-sections
 * than the header has misses (each such section needs at least one), or a
 * negative count no honest header can produce */
export function crossCheckConsistent(crossCheck: IntegrityReport["crossCheck"]): boolean {
	return crossCheck.sectionsWithMiss >= 0 && crossCheck.sectionsWithMiss <= crossCheck.countMiss;
}

export function lifeBarNote(present: boolean): string {
	return present ? "life bar present" : "life bar absent — common in downloaded replays";
}
