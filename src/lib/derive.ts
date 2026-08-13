// everything computed once per scene: analysis edges, playback bounds,
// judgement lookups, the object lane, and severity ticks

import { HIT_FADE_OUT_TIME } from "../engine/argon";
import type { PhysicalKey } from "../engine/buttons";
import { buttonEdges, pressEdges, type ButtonEdges, type Press } from "../engine/interpolation";
import { analyseScene, judgedTime, type ReplayAnalysis } from "./analysis";
import type { Grade, JudgementEventDto, LoadedScene } from "./scene-types";

/** the tether: the bond from an object to its judging press. exists exactly
 * where a hit error exists (analysis.ts's judgedTime, the shared predicate),
 * so toTime - fromTime IS the hit error the analysis panel histograms */
export interface Tether {
	/** the time the judgement is measured against: the circle's start, or the
	 * slider head's nested time */
	fromTime: number;
	/** the judgement event's time -- the judging press's rising edge */
	toTime: number;
	/** the judging press's physical key, resolved at derive time so a click
	 * on the object reaches its press without re-reading frame bits */
	key: PhysicalKey;
	/** the judging press's rise frame index -- the press-run lookup's exact
	 * target. duplicate-time frames can pack a release and re-press into one
	 * millisecond, where (toTime, key) alone names two distinct runs; only
	 * the frame index says which run actually judged */
	pressFrameIndex: number;
}

/** one object lane entry, index-aligned with renderPlan.objects -- extent
 * and kind stay readable off the render object itself */
export interface ObjectLaneEntry {
	/** null when the simulation is not authoritative */
	grade: Grade | null;
	tether: Tether | null;
	/** sliders only: head/repeat/tail nested mark times, ticks already
	 * filtered out; empty for circles and spinners */
	nestedMarks: number[];
}

export interface DerivedScene {
	presses: Press[];
	edges: ButtonEdges;
	bounds: { minTime: number; maxTime: number };
	/** indexed by objectIndex; empty arrays when not simulated */
	judgementsByObject: JudgementEventDto[][];
	/** the object lane's per-object model, index-aligned with
	 * renderPlan.objects */
	objectLane: ObjectLaneEntry[];
	/** the overview strip's below-great marks, height meaning severity */
	severityTicks: { time: number; grade: "ok" | "meh" | "miss" }[];
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

/** resolves each press-judged event's judging press by matching the event's
 * time against the derived press list, never by re-reading frame bits.
 * pressEdges already emits left before right within one frame, matching how
 * stable consumes click edges left-first (simulation/buttons.rs's
 * consume_one_edge, porting circle.go:56-61), so claiming same-time presses
 * in list order pairs same-time press-judged events (event order) with
 * (left, right). a press-caused miss at the same millisecond also consumed
 * an edge, deliberately unmodelled: the resolved press stays deterministic
 * and any error is confined to which of two same-millisecond presses is
 * named */
function judgingPressResolver(presses: readonly Press[]): (time: number) => Press | null {
	const claimedAt = new Map<number, number>();
	return (time) => {
		// first press with time >= t
		let lo = 0;
		let hi = presses.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (presses[mid].time < time) lo = mid + 1;
			else hi = mid;
		}
		const claimed = claimedAt.get(time) ?? 0;
		const exact = presses[lo + claimed];
		if (exact !== undefined && exact.time === time) {
			claimedAt.set(time, claimed + 1);
			return exact;
		}
		// no unclaimed press at the exact millisecond -- unreachable for an
		// authoritative simulation, whose press-judged events land on a press's
		// own frame time. fall back to the nearest press by distance (earlier
		// wins ties) rather than dropping the tether, keeping the tether-count-
		// equals-hit-error-count invariant on a degenerate stream; only a
		// stream with no presses at all still drops it, there being no key to
		// name (and no press to have judged anything)
		const before = presses[lo - 1];
		const after = presses[lo];
		if (before === undefined && after === undefined) return null;
		if (before === undefined) return after;
		if (after === undefined) return before;
		return time - before.time <= after.time - time ? before : after;
	};
}

export function deriveScene(scene: LoadedScene): DerivedScene {
	const objects = scene.renderPlan.objects;
	const firstAppear = objects.length > 0 ? objects[0].startTime - objects[0].preempt : 0;
	const lastEnd = objects.reduce((max, o) => Math.max(max, o.endTime), 0);
	const firstFrame = scene.frames.length > 0 ? scene.frames[0].time : 0;
	const lastFrame = scene.frames.length > 0 ? scene.frames[scene.frames.length - 1].time : 0;

	const presses = pressEdges(scene.frames);
	const judgementsByObject: JudgementEventDto[][] = objects.map(() => []);
	const objectLane: ObjectLaneEntry[] = objects.map((object) => ({
		grade: null,
		tether: null,
		nestedMarks:
			object.kind.type === "slider" ? object.kind.nested.filter((n) => n.kind !== "tick").map((n) => n.time) : []
	}));
	const severityTicks: DerivedScene["severityTicks"] = [];
	// a late judgement extends its drawable's fade past the object's endTime
	// (objectLifetime in renderer/playfield.ts), and the playback bounds must
	// cover that full fade or the clock pauses mid-animation when the audio
	// is absent or shorter
	let lastEventTime = lastEnd;
	if (scene.simulation.status === "authoritative") {
		const judgingPress = judgingPressResolver(presses);
		for (const event of scene.simulation.events) {
			lastEventTime = Math.max(lastEventTime, event.time);
			judgementsByObject[event.objectIndex]?.push(event);
			const kind = event.kind;
			const entry = objectLane[event.objectIndex];
			const object = objects[event.objectIndex];
			// the graded kinds double as the grade sources: the circle event for
			// circles, the aggregate for sliders, the final for spinners -- kind
			// alone names the source, so no per-object-kind dispatch is needed
			if (kind.type === "circle" || kind.type === "sliderAggregate" || kind.type === "spinnerFinal") {
				if (kind.grade !== "great") severityTicks.push({ time: event.time, grade: kind.grade });
				if (entry !== undefined) entry.grade = kind.grade;
			}
			if (entry === undefined || object === undefined) continue;
			// a tether exists exactly where a hit error exists: judgedTime is the
			// shared predicate behind the analysis panel's hit-error list, and the
			// invariant test pins the two call sites together
			const reference = judgedTime(object, kind);
			if (reference !== null) {
				const press = judgingPress(event.time);
				if (press !== null) {
					entry.tether = {
						fromTime: reference,
						toTime: event.time,
						key: press.key,
						pressFrameIndex: press.frameIndex
					};
				}
			}
		}
	}

	return {
		presses,
		edges: buttonEdges(scene.frames),
		bounds: {
			minTime: Math.min(0, -scene.beatmap.audioLeadIn, firstFrame, firstAppear),
			maxTime: Math.max(lastFrame, lastEventTime + HIT_FADE_OUT_TIME)
		},
		judgementsByObject,
		objectLane,
		severityTicks,
		analysis: analyseScene(scene, presses),
		stats: replayStats(scene)
	};
}
