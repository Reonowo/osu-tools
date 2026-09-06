// pure presentation logic for the integrity report: field labels, value
// formatting, and the cross-check sentence. the analysis panel is the thin
// shell over these

import type { Incompleteness, IntegrityReport, IntegrityRow, LifeBarGraphReport } from "./scene-types";

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

/** TODO.md's identity stated outright, with the header's own miss and 50
 * counts beside the implication they bound: stable awards neither geki nor
 * katu to a section containing a miss or a 50 */
export function describeCrossCheck(crossCheck: IntegrityReport["crossCheck"]): string {
	const { sections, gekiKatsu, sectionsWithoutBurst, countMiss, count50 } = crossCheck;
	return `${sections.toLocaleString()} sections − ${gekiKatsu.toLocaleString()} geki+katu = ${sectionsWithoutBurst.toLocaleString()} with a miss or 50 · header misses ${countMiss.toLocaleString()} · 50s ${count50.toLocaleString()}`;
}

/** the identity can only expose a header when it demands more burst-free
 * sections than the header has misses and 50s combined (each such section
 * needs at least one), or a negative count no honest header can produce.
 * on an incomplete play the header and the derivation describe different
 * amounts of play, so the identity carries no verdict there */
export function crossCheckConsistent(
	crossCheck: IntegrityReport["crossCheck"],
	incompleteness: Incompleteness | null = null
): boolean {
	if (incompleteness !== null) return true;
	return (
		crossCheck.sectionsWithoutBurst >= 0 &&
		crossCheck.sectionsWithoutBurst <= crossCheck.countMiss + crossCheck.count50
	);
}

/** how one integrity row should read: a match, a verdict-carrying
 * difference, or an expected difference on a play that ended early */
export type RowVerdict = "match" | "differs" | "expected";

export function rowVerdict(row: IntegrityRow, incompleteness: Incompleteness | null): RowVerdict {
	if (row.match) return "match";
	return incompleteness !== null ? "expected" : "differs";
}

/** the integrity section's life bar row. a compared graph reads as a count of
 * matched samples over the header's own total — never a verdict, since a
 * genuine play can land one short — and the other two states keep the
 * present-or-absent note's own wording: neither carries a graph to count */
export function lifeBarGraphNote(report: LifeBarGraphReport): string {
	if (report.status !== "compared") return "life bar absent — common in downloaded replays";
	return `${report.matched.toLocaleString()} of ${report.total.toLocaleString()} samples match`;
}

/** whether the loaded file's own header agrees about the fail, for the hp
 * section to print beside the fail point this document derives.
 *
 * three states, and only the compared one can answer: a header graph ending
 * in `0` is stable's own record of a fail, one that does not is its record of
 * a play that survived, and a header carrying no graph says neither. it lives
 * here beside the note above because both read the same report of the same
 * loaded file, and neither reads the HP curve at all */
export function headerFailNote(report: LifeBarGraphReport | null): string {
	if (report === null || report.status !== "compared") {
		return "the loaded file carries no life bar graph, so its header says nothing either way";
	}
	return report.headerFailed
		? "the loaded file's life bar graph ends at zero — stable recorded a fail"
		: "the loaded file's life bar graph does not end at zero — stable recorded no fail";
}

/** the play-ended-early annotation: the header counts only the objects
 * played while simulation judges the whole map, so header-vs-simulated
 * differences on an incomplete play are context, not accusation */
export function incompletenessNote(incompleteness: Incompleteness): string {
	return `play ended early: ${incompleteness.judged.toLocaleString()} of ${incompleteness.total.toLocaleString()} objects judged — the header stops at the fail point while simulation judges the whole map, so differences below are expected, not verdicts`;
}
