// everything computed once per scene: analysis edges, playback bounds,
// judgement lookups, and timeline markers

import { HIT_FADE_OUT_TIME } from "../engine/argon";
import { buttonEdges, pressEdges, type ButtonEdges, type Press } from "../engine/interpolation";
import { analyseScene, type ReplayAnalysis } from "./analysis";
import type { JudgementEventDto, LoadedScene } from "./scene-types";

export interface DerivedScene {
	presses: Press[];
	edges: ButtonEdges;
	bounds: { minTime: number; maxTime: number };
	/** indexed by objectIndex; empty arrays when not simulated */
	judgementsByObject: JudgementEventDto[][];
	timelineMarkers: { time: number; grade: "ok" | "meh" | "miss" }[];
	/** hit-timing and cursor statistics for the analysis panel */
	analysis: ReplayAnalysis;
	/** the replay panel's numbers, simulated-primary with header references */
	stats: ReplayStats;
}

/** the letter ranks, distinct from scene-types' judgement Grade */
export type RankGrade = "SS" | "S" | "A" | "B" | "C" | "D";

/** one replay-panel stat: the value the panel leads with and the .osr
 * header's own value as the frozen reference. the two are equal whenever no
 * authoritative simulation is present */
export interface ReplayStat<T = number> {
	value: T;
	header: T;
}

/** the replay panel's whole readout, derived rather than computed in the
 * component so the panel is a pure display: counts, accuracy, grade, and max
 * combo follow the simulation (the engine re-judges every edit, so these go
 * live the moment a delta lands) with the header as the "was" reference,
 * while score and geki/katu have no simulation to follow -- the score port
 * is plan-4 work -- and stay header-valued outright */
export interface ReplayStats {
	/** true when value came from an authoritative simulation */
	simulated: boolean;
	count300: ReplayStat;
	count100: ReplayStat;
	count50: ReplayStat;
	countMiss: ReplayStat;
	/** 0-1 */
	accuracy: ReplayStat;
	grade: ReplayStat<RankGrade>;
	maxCombo: ReplayStat;
	totalScore: number;
	countGeki: number;
	countKatsu: number;
}

interface HitCounts {
	count300: number;
	count100: number;
	count50: number;
	countMiss: number;
}

/** osu! standard accuracy: weighted hit value over total judged hits */
function accuracyOf(counts: HitCounts): number {
	const judged = counts.count300 + counts.count100 + counts.count50 + counts.countMiss;
	if (judged === 0) return 0;
	return (300 * counts.count300 + 100 * counts.count100 + 50 * counts.count50) / (300 * judged);
}

// a miss always costs at least S, even when the count-share accuracy still
// lands at or above the S threshold -- matches osu!'s own grading rule
function gradeFor(accuracy: number, countMiss: number): RankGrade {
	if (countMiss === 0 && accuracy >= 1) return "SS";
	if (countMiss === 0 && accuracy >= 0.95) return "S";
	if (accuracy >= 0.9) return "A";
	if (accuracy >= 0.8) return "B";
	if (accuracy >= 0.7) return "C";
	return "D";
}

function replayStats(scene: LoadedScene): ReplayStats {
	const header = scene.replay;
	const totals = scene.simulation.status === "authoritative" ? scene.simulation.totals : null;
	const live = totals ?? header;
	const headerAccuracy = accuracyOf(header);
	const liveAccuracy = totals === null ? headerAccuracy : accuracyOf(totals);
	return {
		simulated: totals !== null,
		count300: { value: live.count300, header: header.count300 },
		count100: { value: live.count100, header: header.count100 },
		count50: { value: live.count50, header: header.count50 },
		countMiss: { value: live.countMiss, header: header.countMiss },
		accuracy: { value: liveAccuracy, header: headerAccuracy },
		grade: {
			value: gradeFor(liveAccuracy, live.countMiss),
			header: gradeFor(headerAccuracy, header.countMiss)
		},
		maxCombo: { value: live.maxCombo, header: header.maxCombo },
		totalScore: header.totalScore,
		countGeki: header.countGeki,
		countKatsu: header.countKatsu
	};
}

export function deriveScene(scene: LoadedScene): DerivedScene {
	const objects = scene.renderPlan.objects;
	const firstAppear = objects.length > 0 ? objects[0].startTime - objects[0].preempt : 0;
	const lastEnd = objects.reduce((max, o) => Math.max(max, o.endTime), 0);
	const firstFrame = scene.frames.length > 0 ? scene.frames[0].time : 0;
	const lastFrame = scene.frames.length > 0 ? scene.frames[scene.frames.length - 1].time : 0;

	const judgementsByObject: JudgementEventDto[][] = objects.map(() => []);
	const timelineMarkers: DerivedScene["timelineMarkers"] = [];
	// a late judgement extends its drawable's fade past the object's endTime
	// (objectLifetime in renderer/playfield.ts), and the playback bounds must
	// cover that full fade or the clock pauses mid-animation when the audio
	// is absent or shorter
	let lastEventTime = lastEnd;
	if (scene.simulation.status === "authoritative") {
		for (const event of scene.simulation.events) {
			lastEventTime = Math.max(lastEventTime, event.time);
			judgementsByObject[event.objectIndex]?.push(event);
			const kind = event.kind;
			if (kind.type === "circle" || kind.type === "sliderAggregate" || kind.type === "spinnerFinal") {
				if (kind.grade !== "great") timelineMarkers.push({ time: event.time, grade: kind.grade });
			}
		}
	}

	const presses = pressEdges(scene.frames);

	return {
		presses,
		edges: buttonEdges(scene.frames),
		bounds: {
			minTime: Math.min(0, -scene.beatmap.audioLeadIn, firstFrame, firstAppear),
			maxTime: Math.max(lastFrame, lastEventTime + HIT_FADE_OUT_TIME)
		},
		judgementsByObject,
		timelineMarkers,
		analysis: analyseScene(scene, presses),
		stats: replayStats(scene)
	};
}
