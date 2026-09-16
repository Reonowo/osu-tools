// the replay panel's whole decision surface, as plain data in and plain data
// out: what the header line says about the play's rules profile, what the
// recorded-in-file card shows for the file's own score-info block, and how
// the simulated stats are labelled. the panel is a thin shell over these,
// which is what lets a headless test pin them against the native fixture

import type { LoadedScene, RulesProfile, ScoreInfoRecord, StatisticEntry } from "./scene-types";
import { profileText, simulated } from "./simulation";
import { displayRank } from "./derive";

/** the header's trailing text: the version the file was written at, and the
 * rules profile that version selects, since the two are one fact read twice */
export function replayHeaderTrailing(scene: LoadedScene): string {
	return `v${scene.replay.version} · ${profileText(scene.configuration.profile)}`;
}

/** how the simulated stats are labelled, or null when they are exact. an
 * approximate simulation says so beside the numbers it produced, naming the
 * profile it ran under, so it is never mistaken for the play's own */
export function simulatedStatsLabel(scene: LoadedScene): string | null {
	const { simulation } = scene;
	if (simulation.status !== "approximate") return null;
	return `approximate · ${profileText(simulation.profile)}`;
}

/** one row of the recorded-in-file card's block section */
export interface RecordedRow {
	label: string;
	value: string;
}

/** what the recorded-in-file card says about the file's own block: the
 * block's fields for a present one, a stated absence for the three states
 * that carry none, and the reader's reason for a malformed one. never
 * silently omitted -- a lazer file with no block is a fact worth a line */
export type RecordedInFile =
	| { kind: "none"; note: string }
	| { kind: "unreadable"; note: string }
	| { kind: "present"; rows: RecordedRow[]; statistics: StatisticEntry[]; maximumStatistics: StatisticEntry[] };

/** lazer's snake-case result name as the panel prints it */
export function resultLabel(result: string): string {
	return result.replace(/_/g, " ");
}

export function recordedInFile(record: ScoreInfoRecord, profile: RulesProfile): RecordedInFile {
	switch (record.status) {
		case "opaque":
			return { kind: "none", note: "no score-info block — a stable-written replay carries none" };
		case "absent":
			return {
				kind: "none",
				note: "no score-info block — written at lazer's first replay version, before the block existed"
			};
		case "empty":
			return {
				kind: "none",
				note:
					profile === "native"
						? "no score-info block — the file frames an empty one, so its mods were read from the legacy bitfield"
						: "no score-info block — the file frames an empty one"
			};
		case "malformed":
			return { kind: "unreadable", note: `score-info block unreadable — ${record.reason}` };
		case "present": {
			const rows: RecordedRow[] = [
				{ label: "rank", value: record.rank === null ? "none" : displayRank(record.rank) },
				{
					label: "total (no mods)",
					value:
						record.totalScoreWithoutMods === null ? "none" : record.totalScoreWithoutMods.toLocaleString()
				},
				{ label: "client", value: record.clientVersion === "" ? "unknown" : record.clientVersion },
				{ label: "online id", value: record.onlineId === "-1" ? "none" : record.onlineId },
				{ label: "pauses", value: String(record.pauseCount) }
			];
			return {
				kind: "present",
				rows,
				statistics: record.statistics,
				maximumStatistics: record.maximumStatistics
			};
		}
	}
}

/** one entry of the native statistics row: lazer's result, how many the
 * simulation counted, and how many the file's own block records for it --
 * null where the block has no entry, or no block was read */
export interface NativeStatistic {
	result: string;
	count: number;
	recorded: number | null;
}

/** the native statistics row beside the 300/100/50/miss tiles: every result
 * kind the map carries, in lazer's own order, with the block's count as the
 * frozen "was" beside each. null for a stable scene, which has no such map,
 * and for a native scene with no timeline */
export function nativeStatistics(scene: LoadedScene): NativeStatistic[] | null {
	const statistics = simulated(scene.simulation)?.totals.statistics ?? null;
	if (statistics == null) return null;
	const record = scene.replay.scoreInfo;
	const recorded = record.status === "present" ? record.statistics : [];
	return statistics.map((entry) => ({
		result: entry.result,
		count: entry.count,
		recorded: recorded.find((r) => r.result === entry.result)?.count ?? null
	}));
}
