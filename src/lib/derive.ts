// everything computed once per scene: analysis edges, playback bounds,
// judgement lookups, the object lane, and severity ticks

import { HIT_FADE_OUT_TIME } from "../engine/game-constants";
import type { PhysicalKey } from "../engine/buttons";
import { buttonEdges, pressEdges, type ButtonEdges, type Press } from "../engine/interpolation";
import { analyseScene, judgedTime, type ReplayAnalysis } from "./analysis";
import { comboChanges, type ComboChange } from "./combo";
import { hpExtremes, type HpExtremes } from "./hp";
import { severityTargets, type SeverityTargets, type SeverityTick } from "./judgement-nav";
import { finalScore } from "./score";
import { simulated, simulatedProfile } from "./simulation";
import type {
	Grade,
	HpCurve,
	JudgementEventDto,
	LoadedScene,
	RenderNested,
	RenderObject,
	RenderSlider,
	WireRank
} from "./scene-types";

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
	/** null when the scene carries no timeline */
	grade: Grade | null;
	tether: Tether | null;
	/** sliders only: head/repeat/tail marks at their drawn geometry times,
	 * ticks already filtered out; empty for circles and spinners */
	nestedMarks: NestedMark[];
	/** the times of the dropped ticks, ascending -- the lane's extra miss-red
	 * marks. under the stable profile populated only where the aggregate lands
	 * ok/meh; under the native profile for every slider, lazer having judged
	 * each element itself, so a great head carries them too. a tick that names
	 * its nested element marks at that element's own time; a stable score
	 * point with no lazer counterpart marks at the time it was judged */
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
	/** the play's dropped slider elements, one fold over objectLane's drop
	 * lists so the analysis panel's count and the lane's marks cannot disagree */
	drops: DropCounts;
	/** the overview strip's below-great marks, height meaning severity */
	severityTicks: SeverityTick[];
	/** every moment the combo changed, which is the whole input to the watch
	 * HUD's combo pop (`lib/combo.ts`). built here beside the severity ticks
	 * so a landed edit rebuilds it for free and the counter reads the new
	 * timeline with no transition of its own (`docs/adr/0009`) */
	comboChanges: ComboChange[];
	/** the same marks as navigable targets, per grade and sorted by where a
	 * jump lands rather than when the judgement fired (lib/judgement-nav.ts).
	 * built here rather than by its consumers so it re-derives on every landed
	 * edit for free: fix a miss, the engine re-simulates, this walk runs again
	 * and the target is gone with no invalidation logic anywhere */
	severityTargets: SeverityTargets;
	/** the play's HP: the engine's curve and the two readings taken off it.
	 * derived here rather than by the strip or the panel so both read one
	 * answer and both re-derive on a landed edit for free */
	hp: DerivedHp;
	/** hit-timing and cursor statistics for the analysis panel */
	analysis: ReplayAnalysis;
	/** the replay panel's numbers, simulated-primary with header references */
	stats: ReplayStats;
}

/** the HP curve and what the strip's fail mark and the panel's hp section
 * read off it. the resampling to pixel columns deliberately does NOT happen
 * here — it needs the strip's observed width, which is a render-time fact */
export interface DerivedHp extends HpExtremes {
	/** empty for a scene with no timeline, and for one whose drain-rate search
	 * never settled */
	curve: HpCurve;
}

/** the letter ranks as the app shows them, distinct from scene-types'
 * judgement Grade. lazer's `x` is displayed as SS and its hidden variants
 * fold onto their base letter (the tile has no silver treatment); `F` is
 * the native profile's fail */
export type RankGrade = "SS" | "S" | "A" | "B" | "C" | "D" | "F";

/** the wire's lazer vocabulary to the displayed letter. the only thing the
 * frontend does with a rank: the engine decides it, this spells it */
export function displayRank(rank: WireRank): RankGrade {
	switch (rank) {
		case "x":
		case "xh":
			return "SS";
		case "sh":
			return "S";
		case "s":
			return "S";
		case "a":
			return "A";
		case "b":
			return "B";
		case "c":
			return "C";
		case "d":
			return "D";
		case "f":
			return "F";
	}
}

/** one replay-panel stat: the value the panel leads with and the file's own
 * frozen reference -- the .osr header, or the score-info block where accuracy
 * and grade have one. the two are equal whenever the scene carries no
 * timeline, both sides reading that one record then */
export interface ReplayStat<T = number> {
	value: T;
	header: T;
}

/** the replay panel's whole readout, derived rather than computed in the
 * component so the panel is a pure display: counts, accuracy, grade, max combo
 * and the total score follow the simulation (the engine re-judges every edit
 * and re-folds the score curve with it, so these go live the moment a delta
 * lands) with the header as the "was" reference, while geki and katu have no
 * simulation to follow -- taking them live is one `derive_score` call away and
 * is recorded as a follow-up in TODO.md -- and stay header-valued outright.
 * accuracy and grade are READ off the wire on both sides, never computed
 * here from the counts: the engine is their one author, which is what lets
 * the native profile fill the same seats with lazer's rules */
export interface ReplayStats {
	/** true when value came from a simulation -- authoritative or approximate;
	 * the scene's simulation status says which */
	simulated: boolean;
	count300: ReplayStat;
	count100: ReplayStat;
	count50: ReplayStat;
	countMiss: ReplayStat;
	/** 0-1 */
	accuracy: ReplayStat;
	grade: ReplayStat<RankGrade>;
	maxCombo: ReplayStat;
	/** the score curve's last step, which IS the engine's `total_score` for
	 * the current document (the engine pins that equality), with the file's
	 * own total as the frozen reference. 0 for a play that scored nothing;
	 * the header's own value where there is no curve to read at all */
	totalScore: ReplayStat;
	countGeki: number;
	countKatsu: number;
}

function replayStats(scene: LoadedScene): ReplayStats {
	const header = scene.replay;
	// authoritative or approximate: the stats follow whatever timeline the
	// scene carries, and the panel says which it was (`simulated`)
	const timeline = simulated(scene.simulation);
	const totals = timeline?.totals ?? null;
	// null for a scene with no simulation AND for one whose curve could not be
	// folded; both fall back to the header, because neither knows a score. an
	// EMPTY curve is a third thing and is a real 0 (scene-types' ScoreCurve)
	const scoreCurve = timeline?.scoreCurve ?? null;
	const live = totals ?? header;
	// the frozen "was" for the rank: the block's own rank on a file that
	// carries one -- lazer's record of the play, F included -- and the
	// header's counts read through the rank rule otherwise
	const recorded = scene.replay.scoreInfo;
	const recordedRank = recorded.status === "present" && recorded.rank !== null ? recorded.rank : header.rank;
	// the same frozen "was" for accuracy, and for the same reason: under the
	// native profile the live value is lazer's accuracy (slider tails and large
	// ticks weighed in), while the header's four counts are a legacy projection
	// that cannot express it. reading the header there would light the panel's
	// drift line on load for every lazer play with a slider, and pair a
	// legacy-rule accuracy with the block's own rank in one line
	const recordedAccuracy =
		recorded.status === "present" && recorded.accuracy !== null ? recorded.accuracy : header.accuracy;
	return {
		simulated: totals !== null,
		count300: { value: live.count300, header: header.count300 },
		count100: { value: live.count100, header: header.count100 },
		count50: { value: live.count50, header: header.count50 },
		countMiss: { value: live.countMiss, header: header.countMiss },
		// the timeline leads where there is one, and the RECORDED value leads
		// where there is not -- never the header's legacy projection, which
		// would sit opposite the block as its own reference and light the
		// panel's drift line on a play nothing has edited. it also decides
		// which record the tile leads with: `rank_from_accuracy` has no `f`
		// arm (score/rank.rs), so a failed lazer play read through the header
		// leads with an A and relegates the block's own F to the "was" line
		accuracy: { value: totals?.accuracy ?? recordedAccuracy, header: recordedAccuracy },
		grade: { value: displayRank(totals?.rank ?? recordedRank), header: displayRank(recordedRank) },
		maxCombo: { value: live.maxCombo, header: header.maxCombo },
		totalScore: {
			value: scoreCurve === null ? header.totalScore : finalScore(scoreCurve),
			header: header.totalScore
		},
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

/** the nested element a judgement names by index, when it names one of the
 * expected kind -- the identity join every drop mark prefers; null lets the
 * caller fall back to the kind's own identity (the one tail, the repeat
 * ending the named span) */
function namedNested(slider: RenderSlider, index: number | null, kind: RenderNested["kind"]): RenderNested | null {
	if (index === null) return null;
	const nested = slider.nested[index];
	return nested !== undefined && nested.kind === kind ? nested : null;
}

/** dropped slider elements by kind: one slider's, or every slider's summed.
 * only the recorded drops count: under the stable profile those on sliders
 * whose aggregate landed ok/meh (a fully missed slider carries no per-element
 * marks), under the native profile every element lazer dropped */
export interface DropCounts {
	heads: number;
	repeats: number;
	ticks: number;
	tails: number;
}

export const NO_DROPS: DropCounts = { heads: 0, repeats: 0, ticks: 0, tails: 0 };

/** one entry's drop state counted by kind: ticks from tickDrops, the others
 * from the marks aligned with the object's own head/repeat/tail nested
 * elements. null where the entry carries no drop state at all: not a
 * slider, or nothing recorded dropped -- which under the stable profile is
 * every aggregate outside ok/meh, since the marks are applied only there */
function dropCounts(object: RenderObject, entry: ObjectLaneEntry): DropCounts | null {
	if (object.kind.type !== "slider") return null;
	if (!entry.nestedMarks.some((mark) => mark.dropped) && entry.tickDrops.length === 0) return null;
	const marked = markedNested(object.kind);
	const droppedOf = (kind: RenderNested["kind"]) =>
		marked.filter((n, i) => n.kind === kind && entry.nestedMarks[i]?.dropped === true).length;
	return {
		heads: droppedOf("head"),
		repeats: droppedOf("repeat"),
		ticks: entry.tickDrops.length,
		tails: droppedOf("tail")
	};
}

/** the play's dropped slider elements, summed over the object lane */
export function dropTotals(objects: readonly RenderObject[], objectLane: readonly ObjectLaneEntry[]): DropCounts {
	const total = { ...NO_DROPS };
	for (let index = 0; index < objectLane.length; index++) {
		const counts = dropCounts(objects[index], objectLane[index]);
		if (counts === null) continue;
		total.heads += counts.heads;
		total.repeats += counts.repeats;
		total.ticks += counts.ticks;
		total.tails += counts.tails;
	}
	return total;
}

/** the wording every drop readout shares -- `tail`, `2 ticks + tail`,
 * `head + 2 repeats + tick + tail` -- elements listed head-to-tail, or null
 * when nothing dropped */
export function describeDrops(counts: DropCounts): string | null {
	const counted = (count: number, name: string) => (count === 1 ? name : `${count} ${name}s`);
	const parts: string[] = [];
	if (counts.heads > 0) parts.push(counted(counts.heads, "head"));
	if (counts.repeats > 0) parts.push(counted(counts.repeats, "repeat"));
	if (counts.ticks > 0) parts.push(counted(counts.ticks, "tick"));
	if (counts.tails > 0) parts.push(counted(counts.tails, "tail"));
	return parts.length === 0 ? null : parts.join(" + ");
}

/** the hover readout's cause segment for a slider with recorded drops --
 * `dropped tail`, `dropped 2 ticks + tail` -- worded from the entry's drop
 * state, or null where no cause belongs (not a slider, or nothing recorded
 * dropped). the grade is not the gate: under the native profile a great head
 * can sit over a dropped tick, and a missed one over a dropped tail */
export function dropSummary(object: RenderObject, entry: ObjectLaneEntry): string | null {
	const counts = dropCounts(object, entry);
	if (counts === null) return null;
	const words = describeDrops(counts);
	return words === null ? null : `dropped ${words}`;
}

/** the scene's HP curve with its lowest point and fail point. gated on a
 * timeline existing exactly as combo and accuracy are: an unsimulated or
 * beatmap-mismatched play has no HP to show, and the wire already ships an
 * empty curve for a drain search that never settled. an approximate timeline
 * carries an HP curve like it carries a combo -- it is a display surface */
function derivedHp(scene: LoadedScene): DerivedHp {
	const curve = simulated(scene.simulation)?.hpCurve ?? [];
	return { curve, ...hpExtremes(curve) };
}

export function deriveScene(scene: LoadedScene): DerivedScene {
	const objects = scene.renderPlan.objects;
	// the min over every object, not the first's: an object appears at its
	// start minus its OWN preempt, so a later-starting object with a longer
	// preempt appears first, and the clock must reach it before it fades in
	const firstAppear = objects.reduce((min, o) => Math.min(min, o.startTime - o.preempt), Infinity);
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
	const timeline = simulated(scene.simulation);
	// under the native profile a slider has no aggregate: its head's timing
	// grade is its grade, and a dropped element is a mark of its own
	const nativelyJudged = simulatedProfile(scene) === "native";
	if (timeline !== null) {
		const judgingPress = judgingPressResolver(presses);
		for (const event of timeline.events) {
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
				// is the one place both are already in hand. the drop flag is
				// settled below, once the object's drop list exists
				if (kind.grade !== "great") {
					severityTicks.push({
						time: event.time,
						grade: kind.grade,
						objectIndex: event.objectIndex,
						drop: false
					});
				}
				if (entry !== undefined) entry.grade = kind.grade;
			} else if (kind.type === "sliderHead" && nativelyJudged) {
				// the native slider's grade IS its head's timing grade -- a 100 on
				// a head with nothing dropped is a fixture fact -- and the mark it
				// leaves is a timing mark, never a drop, whatever the elements did
				if (kind.grade !== "great") {
					severityTicks.push({
						time: event.time,
						grade: kind.grade,
						objectIndex: event.objectIndex,
						drop: false
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
		// dropped-element marks. under the stable profile, applied only where
		// the aggregate lands ok/meh: that is exactly the population the
		// aggregate under-informs. aggregate great means nothing dropped, and
		// aggregate miss means zero elements collected -- a fully-missed
		// slider's span colour and plain miss tick already say everything, so
		// it gets no per-element marks. under the native profile every slider
		// reads its elements: lazer judged each one, and a great head with a
		// dropped tick is a drop the aggregate never existed to fold away
		for (let index = 0; index < objectLane.length; index++) {
			const entry = objectLane[index];
			const kind = objects[index].kind;
			if (kind.type !== "slider") continue;
			if (!nativelyJudged && entry.grade !== "ok" && entry.grade !== "meh") continue;
			const marked = markedNested(kind);
			for (const event of judgementsByObject[index]) {
				const judged = event.kind;
				if (judged.type === "sliderHead" && judged.grade === "miss") {
					markDropped(entry, marked, (n) => n.kind === "head");
				} else if (judged.type === "sliderRepeat" && !judged.hit) {
					// by the element the event names, else by the ordinal it
					// carries: the event's repeatIndex and the render plan's
					// spanIndex agree by construction (the repeat ending span N is
					// repeat N on both sides -- stable_points.rs, render_plan.rs)
					const named = namedNested(kind, judged.nestedIndex, "repeat");
					const repeatIndex = judged.repeatIndex;
					markDropped(entry, marked, (n) =>
						named !== null ? n === named : n.kind === "repeat" && n.spanIndex === repeatIndex
					);
				} else if (judged.type === "sliderTail" && !judged.hit) {
					// matched by identity, never moved to the event's own time: the
					// simulation judges the tail at the legacy last tick ~36ms
					// early, and a mark sliding left of the span's end would read
					// as a bug rather than as the drop it marks
					const named = namedNested(kind, judged.nestedIndex, "tail");
					markDropped(entry, marked, (n) => (named !== null ? n === named : n.kind === "tail"));
				} else if (judged.type === "sliderTick" && !judged.hit) {
					// by the element the event names -- its own geometry time --
					// which is what closes the recorded nearest-time hazard
					// between the two generators. a stable score point lazer never
					// generated has no element to name and marks where it was judged
					const named = namedNested(kind, judged.nestedIndex, "tick");
					entry.tickDrops.push(named === null ? event.time : named.time);
				}
			}
			entry.tickDrops.sort((a, b) => a - b);
			// the native drop mark: one tick per slider with anything dropped,
			// separate from the head's timing mark, drawn at the earliest drop.
			// a dropped tick or repeat broke combo, which is a miss's weight; a
			// dropped tail alone cost score and no combo, a meh's
			// the head is never one of them: its miss is its own timing mark,
			// pushed above, and counting it here too would mark one missed
			// head twice
			if (nativelyJudged) {
				const counts = dropCounts(objects[index], entry);
				if (counts !== null && counts.repeats + counts.ticks + counts.tails > 0) {
					const droppedTimes = [
						...marked.flatMap((n, i) =>
							n.kind !== "head" && entry.nestedMarks[i]?.dropped === true
								? [entry.nestedMarks[i].time]
								: []
						),
						...entry.tickDrops
					];
					severityTicks.push({
						// folded, never spread: one slider may drop up to limits.rs's
						// MAX_SLIDER_NESTED_OBJECTS elements, and a spread that long
						// is a RangeError rather than a minimum
						time: droppedTimes.reduce((earliest, time) => (time < earliest ? time : earliest), Infinity),
						grade: counts.ticks + counts.repeats > 0 ? "miss" : "meh",
						objectIndex: index,
						drop: true
					});
				}
			}
		}
		// under the stable profile a severity tick is drop-caused when its
		// object's drop list says so: every ok/meh slider (the aggregate is
		// an element-count fold, so below great means something dropped) and
		// never a fully missed one, which carries no drop state. the native
		// ticks already said which they are when they were pushed
		if (!nativelyJudged) {
			for (const tick of severityTicks) {
				const object = objects[tick.objectIndex];
				const entry = objectLane[tick.objectIndex];
				if (object === undefined || entry === undefined) continue;
				const counts = dropCounts(object, entry);
				tick.drop = counts !== null && counts.heads + counts.repeats + counts.ticks + counts.tails > 0;
			}
		}
		// the strip draws by time and the jump lists sort by landing time, so
		// the native drop marks fall into place wherever they were pushed
		severityTicks.sort((a, b) => a.time - b.time);
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
		drops: dropTotals(objects, objectLane),
		severityTicks,
		severityTargets: severityTargets(severityTicks, objects),
		comboChanges: comboChanges(timeline?.events ?? []),
		hp: derivedHp(scene),
		analysis: analyseScene(scene, presses),
		stats: replayStats(scene)
	};
}
