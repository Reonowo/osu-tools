// everything computed once per scene: analysis edges, playback bounds,
// judgement lookups, the object lane, and severity ticks

import { HIT_FADE_OUT_TIME } from "../engine/game-constants";
import type { PhysicalKey } from "../engine/buttons";
import { buttonEdges, pressEdges, type ButtonEdges, type Press } from "../engine/interpolation";
import { analyseScene, judgedTime, type ReplayAnalysis } from "./analysis";
import { severityTargets, type SeverityTargets, type SeverityTick } from "./judgement-nav";
import type { Grade, JudgementEventDto, LoadedScene, RenderNested, RenderObject, RenderSlider } from "./scene-types";

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

/** one head/repeat/tail mark: drawn geometry time + whether its element dropped */
export interface NestedMark {
	time: number;
	dropped: boolean;
}

/** one object lane entry, index-aligned with renderPlan.objects -- extent
 * and kind stay readable off the render object itself */
export interface ObjectLaneEntry {
	/** null when the simulation is not authoritative */
	grade: Grade | null;
	tether: Tether | null;
	/** sliders only: head/repeat/tail marks at their drawn geometry times,
	 * ticks already filtered out; empty for circles and spinners */
	nestedMarks: NestedMark[];
	/** judgement event times of dropped ticks, ascending -- the lane's extra
	 * miss-red marks, populated only where the aggregate lands ok/meh */
	tickDrops: number[];
}

export interface DerivedScene {
	presses: Press[];
	edges: ButtonEdges;
	/** the live playback bounds the clock maps against, re-derived on every
	 * landed delta so the fade past a re-judged last object stays covered.
	 * the timeline tiers deliberately do NOT draw against these -- they use
	 * the store's fold of timelineBounds below, so an edit cannot shift the
	 * dock's frame of reference */
	bounds: { minTime: number; maxTime: number };
	/** the document's timeline mapping bounds: judgement-invariant by
	 * construction, unlike the playback bounds above. every simulation event
	 * lands at or before its object's miss deadline -- a hit at its press
	 * within the late meh window, a miss at the window's close, slider and
	 * spinner events at or before their own end -- so lastEnd + the miss
	 * window + the fade covers any re-judgement an edit can produce, and no
	 * drag can outgrow it. only the frame stream's own extent (or a new
	 * scene) moves it, which is what lets the store fold it widen-only into
	 * a frame of reference that holds still under editing */
	timelineBounds: { minTime: number; maxTime: number };
	/** indexed by objectIndex; empty arrays when not simulated */
	judgementsByObject: JudgementEventDto[][];
	/** the object lane's per-object model, index-aligned with
	 * renderPlan.objects */
	objectLane: ObjectLaneEntry[];
	/** the overview strip's below-great marks, height meaning severity */
	severityTicks: SeverityTick[];
	/** the same marks as navigable targets, per grade and sorted by where a
	 * jump lands rather than when the judgement fired (lib/judgement-nav.ts).
	 * built here rather than by its consumers so it re-derives on every landed
	 * edit for free: fix a miss, the engine re-simulates, this walk runs again
	 * and the target is gone with no invalidation logic anywhere */
	severityTargets: SeverityTargets;
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

/** the nested elements the lane marks -- head/repeat/tail, ticks excluded --
 * shared between building the marks and applying drop state to them, so the
 * two sides can never disagree on index alignment */
function markedNested(slider: RenderSlider): RenderNested[] {
	return slider.nested.filter((n) => n.kind !== "tick");
}

function markDropped(entry: ObjectLaneEntry, marked: readonly RenderNested[], matches: (n: RenderNested) => boolean) {
	const index = marked.findIndex(matches);
	const mark = entry.nestedMarks[index];
	if (mark !== undefined) mark.dropped = true;
}

/** the hover readout's cause segment for a below-great slider -- `dropped
 * tail`, `dropped 2 ticks + tail` -- worded from the entry's drop state, or
 * null where no cause belongs (not a slider, aggregate outside ok/meh, or
 * nothing recorded dropped). elements list head-to-tail; ticks count from
 * tickDrops, the others from the marks aligned with the object's own
 * head/repeat/tail nested elements */
export function dropSummary(object: RenderObject, entry: ObjectLaneEntry): string | null {
	if (object.kind.type !== "slider") return null;
	if (entry.grade !== "ok" && entry.grade !== "meh") return null;
	const marked = markedNested(object.kind);
	const droppedOf = (kind: RenderNested["kind"]) =>
		marked.filter((n, i) => n.kind === kind && entry.nestedMarks[i]?.dropped === true).length;
	const counted = (count: number, name: string) => (count === 1 ? name : `${count} ${name}s`);
	const parts: string[] = [];
	if (droppedOf("head") > 0) parts.push("head");
	const repeats = droppedOf("repeat");
	if (repeats > 0) parts.push(counted(repeats, "repeat"));
	const ticks = entry.tickDrops.length;
	if (ticks > 0) parts.push(counted(ticks, "tick"));
	if (droppedOf("tail") > 0) parts.push("tail");
	if (parts.length === 0) return null;
	return `dropped ${parts.join(" + ")}`;
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
			object.kind.type === "slider"
				? markedNested(object.kind).map((n) => ({ time: n.time, dropped: false }))
				: [],
		tickDrops: []
	}));
	const severityTicks: SeverityTick[] = [];
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
				// the object rides along with the mark: the strip draws by time, but
				// navigating to a mark needs the object it belongs to, and this push
				// is the one place both are already in hand
				if (kind.grade !== "great") {
					severityTicks.push({
						time: event.time,
						grade: kind.grade,
						objectIndex: event.objectIndex,
						// exact under the legacy simulation path, the only one today:
						// the slider aggregate is a pure element-count fold, so every
						// below-great slider is drop-caused, and aggregate miss means
						// zero elements collected (the plain tick already says it all).
						// a lazer-native rules profile would break that equivalence,
						// and this one site would then consult the drop lists instead
						drop: kind.type === "sliderAggregate" && kind.grade !== "miss"
					});
				}
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
		// dropped-element marks, applied only where the aggregate lands ok/meh:
		// that is exactly the population the aggregate under-informs. aggregate
		// great means nothing dropped, and aggregate miss means zero elements
		// collected -- a fully-missed slider's span colour and plain miss tick
		// already say everything, so it gets no per-element marks
		for (let index = 0; index < objectLane.length; index++) {
			const entry = objectLane[index];
			const kind = objects[index].kind;
			if (kind.type !== "slider" || (entry.grade !== "ok" && entry.grade !== "meh")) continue;
			const marked = markedNested(kind);
			for (const event of judgementsByObject[index]) {
				const judged = event.kind;
				if (judged.type === "sliderHead" && !judged.hit) {
					markDropped(entry, marked, (n) => n.kind === "head");
				} else if (judged.type === "sliderRepeat" && !judged.hit) {
					// the event's repeatIndex and the render plan's spanIndex agree
					// by construction: the repeat ending span N is repeat N on both
					// sides (stable_points.rs:199, render_plan.rs's passthrough)
					const repeatIndex = judged.repeatIndex;
					markDropped(entry, marked, (n) => n.kind === "repeat" && n.spanIndex === repeatIndex);
				} else if (judged.type === "sliderTail" && !judged.hit) {
					// matched by kind, never moved to the event's own time: the
					// simulation judges the tail at the legacy last tick ~36ms
					// early, and a mark sliding left of the span's end would read
					// as a bug rather than as the drop it marks
					markDropped(entry, marked, (n) => n.kind === "tail");
				} else if (judged.type === "sliderTick" && !judged.hit) {
					// the event's own time, deliberately never matched against the
					// render plan's tick list: tick judgements carry no identity,
					// and nearest-time matching across the two generators is the
					// recorded ~140ms stable-vs-lazer hazard (hitsound-plan.ts's
					// nearestNested). reverses cheaply if tick judgements ever
					// gain identity on the wire
					entry.tickDrops.push(event.time);
				}
			}
			entry.tickDrops.sort((a, b) => a - b);
		}
	}

	const minTime = Math.min(0, -scene.beatmap.audioLeadIn, firstFrame, firstAppear);
	return {
		presses,
		edges: buttonEdges(scene.frames),
		bounds: {
			minTime,
			maxTime: Math.max(lastFrame, lastEventTime + HIT_FADE_OUT_TIME)
		},
		timelineBounds: {
			minTime,
			maxTime: Math.max(lastFrame, lastEnd + scene.renderPlan.hitWindows.miss + HIT_FADE_OUT_TIME)
		},
		judgementsByObject,
		objectLane,
		severityTicks,
		severityTargets: severityTargets(severityTicks, objects),
		analysis: analyseScene(scene, presses),
		stats: replayStats(scene)
	};
}
