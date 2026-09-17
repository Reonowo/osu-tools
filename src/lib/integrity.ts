// pure presentation logic for the integrity report: field labels, value
// formatting, and the cross-check sentence. the analysis panel is the thin
// shell over these

import type {
	BlockCheck,
	Incompleteness,
	IntegrityCrossCheck,
	IntegrityReport,
	IntegrityRow,
	LifeBarGraphReport
} from "./scene-types";
import { displayRank } from "./derive";

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

/** the stable rows by their fixed labels; a native row is named by its
 * result (`large_tick_hit` reads "large tick hit") or, prefixed
 * `maximum:`, by the maximum statistics entry it compares */
export function integrityRowLabel(field: string): string {
	const known = ROW_LABELS[field];
	if (known !== undefined) return known;
	if (field.startsWith("maximum:")) return `max ${field.slice("maximum:".length).replaceAll("_", " ")}`;
	return field.replaceAll("_", " ");
}

/** perfect rides the wire as 0/1; every other field is a plain count */
export function integrityRowValue(field: string, value: number): string {
	if (field === "perfect") return value === 0 ? "no" : "yes";
	return value.toLocaleString();
}

/** TODO.md's identity stated outright, with the header's own miss and 50
 * counts beside the implication they bound: stable awards neither geki nor
 * katu to a section containing a miss or a 50 */
export function describeCrossCheck(crossCheck: IntegrityCrossCheck): string {
	const { sections, gekiKatsu, sectionsWithoutBurst, countMiss, count50 } = crossCheck;
	return `${sections.toLocaleString()} sections − ${gekiKatsu.toLocaleString()} geki+katu = ${sectionsWithoutBurst.toLocaleString()} with a miss or 50 · header misses ${countMiss.toLocaleString()} · 50s ${count50.toLocaleString()}`;
}

/** the identity can only expose a header when it demands more burst-free
 * sections than the header has misses and 50s combined (each such section
 * needs at least one), or a negative count no honest header can produce.
 * on an incomplete play the header and the derivation describe different
 * amounts of play, so the identity carries no verdict there */
export function crossCheckConsistent(
	crossCheck: IntegrityCrossCheck | null,
	incompleteness: Incompleteness | null = null
): boolean {
	if (crossCheck === null || incompleteness !== null) return true;
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
export function lifeBarGraphNote(report: LifeBarGraphReport | null): string {
	if (report === null) return "no life bar graph to score — a lazer client writes none";
	if (report.status !== "compared") return "life bar absent — common in downloaded replays";
	return `${report.matched.toLocaleString()} of ${report.total.toLocaleString()} samples match`;
}

/** whether the loaded file's own record agrees about the fail, for the hp
 * section to print beside the fail point this document derives. each profile
 * has its own oracle and the block is asked first, being the native one.
 *
 * three states either way, and neither oracle collapses its silent one: a
 * header graph ending in `0` is stable's record of a fail, one that does not
 * is its record of a play that survived, and a header carrying no graph says
 * neither; the block's rank reads the same way, `f` against anything else,
 * with a block carrying no rank -- or a report carrying no block comparison
 * -- saying neither. it lives here beside the note above because both read
 * the same report of the same loaded file, and neither reads the HP curve at
 * all */
export function headerFailNote(report: IntegrityReport | null): string {
	const block = report?.block ?? null;
	if (block !== null) {
		// the block's rank has the same three states the header's graph has: a
		// block that carries no rank says neither, and collapsing that into
		// "no fail" would assert a survival the file never recorded
		if (block.rankBlock === null) {
			return "the loaded file's block records no rank, so it says nothing either way";
		}
		return block.rankBlock === "f"
			? "the loaded file's block records rank F — lazer recorded a fail"
			: "the loaded file's block records a rank other than F — lazer recorded no fail";
	}
	// a native report carrying no block comparison reaches here with no oracle
	// of its own; naming stable's would name a record a lazer file never
	// carries. an UNREADABLE block is not this state -- it withholds the whole
	// report (load.rs maps the block into the comparison), so it arrives as a
	// null report and takes the stable arm below
	if (report?.profile === "native") {
		return "the loaded file's block carries no comparison, so it says nothing either way";
	}
	const graph = report?.lifeBarGraph ?? null;
	if (graph === null || graph.status !== "compared") {
		return "the loaded file carries no life bar graph, so its header says nothing either way";
	}
	return graph.headerFailed
		? "the loaded file's life bar graph ends at zero — stable recorded a fail"
		: "the loaded file's life bar graph does not end at zero — stable recorded no fail";
}

/** the native report's block line: the two ranks side by side, and the
 * truncation a failed source is compared under -- lazer's own score
 * processor stopped counting at the failing result, so the rows above
 * compare the engine's fold up to its own fail point, which is stated
 * rather than absorbed */
export function blockNote(block: BlockCheck): string {
	const recorded = block.rankBlock === null ? "no rank" : `rank ${displayRank(block.rankBlock)}`;
	const ranks = `block records ${recorded} · simulated ${displayRank(block.rankSimulated)}${block.rankMatch ? "" : " — differs"}`;
	if (block.truncatedAt === null) return ranks;
	return `${ranks} · the block records a fail, so the rows compare up to the engine's own fail point at ${(block.truncatedAt / 1000).toFixed(1)}s; a difference past that rule is a parity finding`;
}

/** the play-ended-early annotation: the header counts only the objects
 * played while simulation judges the whole map, so header-vs-simulated
 * differences on an incomplete play are context, not accusation */
export function incompletenessNote(incompleteness: Incompleteness): string {
	return `play ended early: ${incompleteness.judged.toLocaleString()} of ${incompleteness.total.toLocaleString()} objects judged — the header stops at the fail point while simulation judges the whole map, so differences below are expected, not verdicts`;
}
