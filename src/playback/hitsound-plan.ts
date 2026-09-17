// which sound the current simulation makes, and when: the whole judgement ->
// sample composition, as a pure function over the scene.
//
// this is the half of hitsounding with no lazer analogue to dump, so it is the
// half fixtures cannot cover -- `fixtures/samples/` pins RESOLUTION (which
// sound an object asks for) and nothing here. tested directly instead, over
// synthetic judgement timelines.
//
// the one rule everything else follows from: samples fire off JUDGEMENTS, not
// beatmap times. `DrawableHitObject.updateState` calls `PlaySamples()` only
// when the new armed state is `Hit` and the transition is not forced
// (drawablehitobject.cs:497-498), so a miss is silent, a late hit sounds late,
// and an edit that moves a press moves its sound. a scene that was never
// simulated has no judgements at all and therefore makes no hit sounds.

import type { JudgementEventDto, LoadedScene, RenderNested, RenderObject, SampleLookup } from "@/lib/scene-types";
import { simulated } from "@/lib/simulation";
import { namedRequest, sampleRequest, type SampleRequest } from "./sample-sources";

/** drawablehitobject.cs:186 MINIMUM_SAMPLE_VOLUME -- a sample never plays
 * quieter than this, however low the map set it */
export const MINIMUM_SAMPLE_VOLUME = 5;

/** osuconfigmanager.cs:144 -- how far a sample is panned toward the object's
 * side of the playfield. lazer's own default */
export const DEFAULT_POSITIONAL_LEVEL = 0.2;

/** comboeffects.cs:59 -- a break below this combo is silent unless it is the
 * play's first and the preference says otherwise */
export const COMBO_BREAK_THRESHOLD = 20;

export interface HitsoundOptions {
	/** 0-1; osuconfigmanager.cs:144 PositionalHitsoundsLevel */
	positionalLevel: number;
	/** lazer's AlwaysPlayFirstComboBreak, default on */
	alwaysPlayFirstComboBreak: boolean;
	/** playfield width in osu!px, for the positional balance. the render plan
	 * carries it rather than this module assuming 512 */
	playfieldWidth: number;
}

/** one sound to make. everything about it is decided here, before any audio
 * node exists -- the scheduler only turns these into `start(when)` calls */
export interface ScheduledSample {
	/** beatmap time, ms */
	time: number;
	/** what to ask the lookup chain for */
	request: SampleRequest;
	/** 0-1, this sample's own gain: `max(volume, 5) / 100`
	 * (skinnablesound.cs:168) */
	gain: number;
	/** -1..1 stereo balance */
	balance: number;
}

/**
 * drawablehitobject.cs:602-610 `CalculateSamplePlaybackBalance` --
 * `level * 2 * (position - 0.5)`, rounded to two decimals because "balance is
 * very hard to perceive in small increments anyways". `position` is the
 * object's x as a fraction of the playfield
 * (drawableosuhitobject.cs:35,151)
 */
export function sampleBalance(x: number, playfieldWidth: number, level: number): number {
	const position = playfieldWidth > 0 ? x / playfieldWidth : 0.5;
	const balance = Math.round(level * 2 * (position - 0.5) * 100) / 100;
	// centre is centre: a level of 0 on the left half rounds to -0, which is
	// the same pan and a different value to read back
	return balance === 0 ? 0 : balance;
}

/**
 * skinnablesound.cs:168 -- `Math.Max(s.Volume, MinimumSampleVolume) / 100`,
 * plus a ceiling lazer does not have.
 *
 * the floor is lazer's; the CEILING is ours, and it is a safety bound rather
 * than a parity one. lazer lower-bounds a parsed volume at zero and stops
 * there (converthitobjectparser.cs:232 -- `Math.Max(0, ParseInt(...))`), so a
 * crafted `.osu` can declare `2147483647` and reach this function with it. the
 * engine carries that through faithfully, as it must; unbounded here it would
 * become a gain of twenty million on a GainNode -- a full-scale blast that no
 * master or hitsound level could attenuate, since every channel below the
 * clipping point still clips.
 *
 * no real map is affected: the editor's own control tops out at 100, so the
 * clamp only ever bites on input that was never legitimate
 */
export function sampleGain(volume: number): number {
	if (!Number.isFinite(volume)) return MINIMUM_SAMPLE_VOLUME / 100;
	return Math.min(Math.max(volume, MINIMUM_SAMPLE_VOLUME), 100) / 100;
}

/** the nested piece a slider judgement came from, or null when the plan and
 * the timeline disagree about the slider's shape (a defensive guard, not an
 * expected state) */
function nestedFor(object: RenderObject, kind: RenderNested["kind"], match: (n: RenderNested) => boolean) {
	if (object.kind.type !== "slider") return null;
	return object.kind.nested.find((n) => n.kind === kind && match(n)) ?? null;
}

/**
 * every sound the currently simulated play makes, in timeline order.
 *
 * recomputed whenever the judgement timeline is -- which is every landed edit
 * -- so what is heard always matches what is currently simulated. that is also
 * why the combo-break marker below is derived here rather than remembered
 * anywhere: editing away an early miss must promote the next break to first,
 * and a marker held in the scheduler would leave the next one silent
 */
export function buildHitsoundPlan(scene: LoadedScene, options: HitsoundOptions): ScheduledSample[] {
	// authoritative or approximate alike: what is heard follows whatever
	// timeline the scene carries, which is what makes an approximate play
	// audible at all
	const timeline = simulated(scene.simulation);
	if (timeline === null) return [];
	const plan: ScheduledSample[] = [];
	const objects = scene.renderPlan.objects;
	// the slider's end sound is gated on one judgement and timed by another, so
	// the gate has to be in hand before the timing one is reached
	const tailsHit = hitTails(timeline.events);

	// comboeffects.cs:24,59 -- "the first break of the play", recomputed from
	// this timeline every time rather than carried across edits
	let seenFirstBreak = false;
	let previousCombo = 0;

	const push = (time: number, lookups: readonly SampleLookup[], x: number) => {
		const balance = sampleBalance(x, options.playfieldWidth, options.positionalLevel);
		for (const lookup of lookups) {
			plan.push({ time, request: sampleRequest(lookup), gain: sampleGain(lookup.volume), balance });
		}
	};

	for (const event of timeline.events) {
		const object = objects[event.objectIndex];
		if (object !== undefined) pushObjectSamples(push, event, object, tailsHit.has(event.objectIndex));
		if (comboBreaks(event, previousCombo, seenFirstBreak, options)) {
			// comboeffects.cs:34 -- a plain `SampleInfo`, so its only lookup
			// name is itself. no bank, no suffix, no per-object volume: it is a
			// sound the game makes, not one an object makes, and it is centred
			plan.push({ time: event.time, request: namedRequest("Gameplay/combobreak"), gain: 1, balance: 0 });
		}
		if (event.comboAfter === 0 && previousCombo > 0) seenFirstBreak = true;
		previousCombo = event.comboAfter;
	}

	// the timeline is emitted in application order, which is time order except
	// where two deadlines land on one frame; the scheduler wants time order
	return plan.sort((a, b) => a.time - b.time);
}

/**
 * the object index of every slider whose tail was hit.
 *
 * a separate pass rather than a flag carried along the loop: the tail is what
 * DECIDES whether the end sound plays (drawableslider.cs:332) and the whole
 * slider is what TIMES it, and joining two judgements by "the tail comes first"
 * is the positional join this module refuses to make anywhere else
 */
function hitTails(events: readonly JudgementEventDto[]): Set<number> {
	const hit = new Set<number>();
	for (const event of events) {
		if (event.kind.type === "sliderTail" && event.kind.hit) hit.add(event.objectIndex);
	}
	return hit;
}

function pushObjectSamples(
	push: (time: number, lookups: readonly SampleLookup[], x: number) => void,
	event: JudgementEventDto,
	object: RenderObject,
	tailHit: boolean
): void {
	const kind = event.kind;
	switch (kind.type) {
		// a circle and a spinner sound their own samples, and only when the
		// armed state is Hit -- a miss plays nothing
		case "circle":
			if (kind.grade !== "miss") push(event.time, object.samples, object.position[0]);
			return;
		case "spinnerFinal":
			if (kind.grade !== "miss") push(event.time, object.samples, object.position[0]);
			return;
		// spinner.cs:94 -- a BONUS spin sounds; an ordinary one carries no
		// samples in lazer and is silent here too (the continuous spinnerspin
		// loop is a separate, deferred mechanism)
		case "spinnerBonus":
			if (object.kind.type === "spinner") push(event.time, object.kind.bonusSamples, object.position[0]);
			return;
		case "spinnerSpin":
			return;
		// slider.cs:277-289 -- each nested piece sounds its own node. the head
		// is node 0, a repeat is node `repeatIndex + 1`, the tail is the last
		// node, and a tick is the slider's own sample renamed; all four are
		// already resolved onto the nested entries by the engine, so the join
		// here is only about WHICH piece. WHEN is a separate question, and the
		// tail is the one piece whose two answers differ -- see below
		case "sliderHead": {
			if (kind.grade === "miss") return;
			const head = nestedFor(object, "head", () => true);
			if (head !== null) push(event.time, head.samples, head.position[0]);
			return;
		}
		case "sliderRepeat": {
			if (!kind.hit) return;
			// by the identity the judgement carries, NEVER by counting repeat
			// events: a positional join goes silently wrong the first time
			// emission order changes, and wrong here means the map's own
			// hitsounding plays on the wrong reverse. the nested index is the
			// element itself; the repeat ordinal is the same identity spelled
			// as a node, for an event that carries no index
			const repeat =
				nestedByIndex(object, kind.nestedIndex, "repeat") ??
				nestedFor(object, "repeat", (n) => n.spanIndex === kind.repeatIndex);
			if (repeat !== null) push(event.time, repeat.samples, repeat.position[0]);
			return;
		}
		// silent HERE, and the one judgement in this switch that is: the tail
		// node sits at the LEGACY LAST TICK, `TAIL_LENIENCY = -36`ms before the
		// slider actually ends (slidereventgenerator.cs:24,102), so sounding it
		// off its own judgement plays every slider's end sound 36ms early --
		// measured at -36.9ms on every slider of every replay in the local
		// corpus, which is a third of a 1/4 at 200bpm and by far the loudest
		// timing error in the app. lazer hit this and said so: "the samples
		// should be attached to the slider tail, however this can only be done
		// if LastTick is removed otherwise they would play earlier than they're
		// intended to. For now, the samples are played by the slider itself at
		// the correct end time" (slider.cs:285-289). so does this -- see
		// sliderEnd below
		case "sliderTail":
			return;
		case "sliderTick": {
			if (!kind.hit) return;
			// by the element the judgement names. the two sides come from
			// different generators -- the simulation times its ticks by
			// stable's own walk, the render plan's nested list is lazer's, and
			// the two disagree by more than a tick spacing (`beatmap::
			// stable_points`' own test pins a stable tick at 1464ms against
			// lazer's ~1607) -- which is exactly why a nearest-time join was
			// the wrong tool: it could borrow a neighbouring tick's position.
			// the one tick without an identity is a stable score point lazer
			// never generated (a null index); it still sounds, as stable did,
			// and takes the nearest generated tick's pan since it has none of
			// its own -- every tick of a slider sounds the same sample
			const tick = nestedByIndex(object, kind.nestedIndex, "tick") ?? nearestNested(object, "tick", event.time);
			if (tick !== null) push(event.time, tick.samples, tick.position[0]);
			return;
		}
		// where the slider's end sound actually lands. the lifecycle end is
		// the slider's OWN event, and lazer holds the slider's judgement until
		// `Time.Current >= HitObject.EndTime` (drawableslider.cs:295) -- so
		// this event is at the end time the tail node misses by 36ms.
		//
		// two gates, both lazer's. the slider has to be armed Hit at all,
		// which is any nested element hit (drawableslider.cs:317-320 -- the
		// engine's `complete` flag is that condition, and under the stable
		// profile it agrees with the aggregate's not-a-miss); and
		// `SamplePlaysOnlyOnHit` defaults to true (drawableslidertail.cs:31),
		// so a dropped tail is silent even when the slider itself scored
		case "sliderEnd": {
			if (!kind.complete || !tailHit) return;
			const tail = nestedFor(object, "tail", () => true);
			// the tail node still OWNS the samples -- the engine resolved the
			// last node's lookups onto it, and moving what plays them does not
			// move which ones they are
			if (tail !== null) push(event.time, tail.samples, tail.position[0]);
			return;
		}
		// the stable profile's grade fold: it sounds nothing of its own, the
		// end sound having moved onto the lifecycle end both profiles emit
		case "sliderAggregate":
			return;
	}
}

/** the nested piece the judgement names by index, when it names one of the
 * expected kind; null otherwise, so the caller can fall back */
function nestedByIndex(object: RenderObject, index: number | null, kind: RenderNested["kind"]): RenderNested | null {
	if (index === null || object.kind.type !== "slider") return null;
	const nested = object.kind.nested[index];
	return nested !== undefined && nested.kind === kind ? nested : null;
}

/** the nested piece of a kind closest in time to `time`. used only for a tick
 * with no identity -- a stable score point the lazer list never generated --
 * whose only known coordinate is the time stable judged it at */
function nearestNested(object: RenderObject, kind: RenderNested["kind"], time: number): RenderNested | null {
	if (object.kind.type !== "slider") return null;
	let best: RenderNested | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const nested of object.kind.nested) {
		if (nested.kind !== kind) continue;
		const distance = Math.abs(nested.time - time);
		if (distance < bestDistance) {
			best = nested;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * comboeffects.cs:59 -- `combo.NewValue == 0 && (combo.OldValue > 20 ||
 * (alwaysPlayFirst && firstBreakTime == null))`.
 *
 * every input is already on the judgement timeline: `comboAfter` is the new
 * value, the previous event's is the old one, and "first break of the play" is
 * whether any earlier event in THIS timeline broke combo
 */
function comboBreaks(
	event: JudgementEventDto,
	previousCombo: number,
	seenFirstBreak: boolean,
	options: HitsoundOptions
): boolean {
	if (event.comboAfter !== 0) return false;
	// a combo that was already 0 has not been broken -- lazer's Combo bindable
	// only fires on a change
	if (previousCombo === 0) return false;
	if (previousCombo > COMBO_BREAK_THRESHOLD) return true;
	return options.alwaysPlayFirstComboBreak && !seenFirstBreak;
}
