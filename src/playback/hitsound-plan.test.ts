// the SCHEDULING half of hitsounding, over synthetic judgement timelines.
//
// `fixtures/samples/` pins resolution -- which sound an object asks for --
// and nothing here: which sample fires off which judgement, and when, is this
// app's own composition with no lazer analogue to dump. nobody should read
// "hitsounds are fixture-covered" as covering any of the below.

import { describe, expect, test } from "bun:test";
import type { JudgementEventDto, LoadedScene, RenderNested, RenderObject, SampleLookup } from "../lib/scene-types";
import { testScene } from "../test/scene";
import {
	buildHitsoundPlan,
	COMBO_BREAK_THRESHOLD,
	DEFAULT_POSITIONAL_LEVEL,
	sampleBalance,
	sampleGain,
	type HitsoundOptions
} from "./hitsound-plan";

const OPTIONS: HitsoundOptions = {
	positionalLevel: DEFAULT_POSITIONAL_LEVEL,
	alwaysPlayFirstComboBreak: true,
	playfieldWidth: 512
};

function lookup(over: Partial<SampleLookup> = {}): SampleLookup {
	return { bank: "normal", name: "hitnormal", suffix: null, volume: 100, layered: false, filename: null, ...over };
}

function circle(startTime: number, samples: SampleLookup[], x = 256): RenderObject {
	return {
		startTime,
		endTime: startTime,
		position: [x, 192],
		stackHeight: 0,
		comboColourIndex: 1,
		comboIndex: 1,
		indexInCombo: 0,
		preempt: 600,
		fadeIn: 400,
		samples,
		kind: { type: "circle" }
	};
}

function nested(kind: RenderNested["kind"], spanIndex: number, time: number, samples: SampleLookup[]): RenderNested {
	return { kind, spanIndex, time, position: [100, 192], pathProgress: 0, preempt: 600, fadeIn: 400, samples };
}

function slider(startTime: number, parts: RenderNested[]): RenderObject {
	return {
		...circle(startTime, []),
		endTime: startTime + 1000,
		kind: {
			type: "slider",
			vertices: [0, 0, 100, 0],
			cumulativeLengths: [0, 100],
			distance: 100,
			segmentEnds: [1],
			repeatCount: Math.max(0, parts.filter((p) => p.kind === "repeat").length),
			spanCount: 1,
			spanDuration: 1000,
			duration: 1000,
			endPosition: [200, 192],
			snakeInDuration: 200,
			nested: parts
		}
	};
}

function spinner(startTime: number, bonusSamples: SampleLookup[], samples: SampleLookup[] = []): RenderObject {
	return {
		...circle(startTime, samples),
		endTime: startTime + 2000,
		kind: { type: "spinner", duration: 2000, spinsRequired: 3, maxBonusSpins: 2, bonusSamples }
	};
}

function sceneOf(objects: RenderObject[], events: JudgementEventDto[]): LoadedScene {
	const base = testScene();
	return testScene({
		renderPlan: { ...base.renderPlan, objects },
		simulation: {
			status: "authoritative",
			events,
			totals: { count300: 0, count100: 0, count50: 0, countMiss: 0, maxCombo: 0 }
		}
	});
}

function event(time: number, kind: JudgementEventDto["kind"], comboAfter = 1, objectIndex = 0): JudgementEventDto {
	return { time, objectIndex, kind, comboAfter, accuracyAfter: 1 };
}

/** the names each planned sample resolves through, which is the whole of what
 * the chain will be asked for */
const names = (plan: ReturnType<typeof buildHitsoundPlan>) => plan.map((s) => s.request.names[0]);

describe("samples fire off judgements, not beatmap times", () => {
	test("a circle sounds at the time it was JUDGED, not at its start time", () => {
		// the object starts at 1000; the play hit it 20ms early. an edit that
		// moves that press moves this sound with it, which is the whole point
		const scene = sceneOf([circle(1000, [lookup()])], [event(980, { type: "circle", grade: "ok" })]);
		const plan = buildHitsoundPlan(scene, OPTIONS);
		expect(plan).toHaveLength(1);
		expect(plan[0].time).toBe(980);
	});

	test("a miss is silent", () => {
		const scene = sceneOf([circle(1000, [lookup()])], [event(1400, { type: "circle", grade: "miss" }, 0)]);
		expect(buildHitsoundPlan(scene, OPTIONS)).toHaveLength(0);
	});

	test("a not-simulated scene makes no hit sounds at all", () => {
		const scene = testScene({ simulation: { status: "notSimulated", reason: "unsupportedMods" } });
		expect(buildHitsoundPlan(scene, OPTIONS)).toHaveLength(0);
	});

	test("every sample the object carries sounds together, layered hitnormal included", () => {
		// legacyskintransformer.cs:31-32 -- the layered hitnormal plays UNDER
		// the addition rather than instead of it; only a skin.ini with
		// LayeredHitSounds off replaces it, and with no legacy skin parsing that
		// reads as its default of on
		const scene = sceneOf(
			[circle(1000, [lookup({ layered: true }), lookup({ name: "hitwhistle" })])],
			[event(1000, { type: "circle", grade: "great" })]
		);
		expect(names(buildHitsoundPlan(scene, OPTIONS))).toEqual([
			"Gameplay/normal-hitnormal",
			"Gameplay/normal-hitwhistle"
		]);
	});
});

describe("per-sample gain and balance", () => {
	test("gain is the map's volume with lazer's floor under it", () => {
		// skinnablesound.cs:168 + drawablehitobject.cs:186
		expect(sampleGain(100)).toBe(1);
		expect(sampleGain(45)).toBe(0.45);
		expect(sampleGain(0)).toBe(0.05);
		expect(sampleGain(3)).toBe(0.05);
	});

	test("A CRAFTED VOLUME CANNOT BLAST PAST THE VOLUME CONTROLS", () => {
		// lazer lower-bounds a parsed volume at zero and stops there
		// (converthitobjectparser.cs:232), so a `.osu` can declare any i32 and
		// the engine carries it faithfully. unbounded here that is a gain of
		// twenty million on a GainNode -- full-scale clipping that no master or
		// hitsound level can pull back, because everything below the clipping
		// point still clips. the ceiling lives beside the floor, in the same
		// playback rule, and never bites a real map (the editor stops at 100)
		expect(sampleGain(2_147_483_647)).toBe(1);
		expect(sampleGain(101)).toBe(1);
		expect(sampleGain(Number.POSITIVE_INFINITY)).toBe(0.05);
		expect(sampleGain(Number.NaN)).toBe(0.05);
		expect(sampleGain(-2_147_483_648)).toBe(0.05);
	});

	test("balance is lazer's positional formula, rounded to two decimals", () => {
		// drawablehitobject.cs:602-610 -- level * 2 * (x/width - 0.5)
		expect(sampleBalance(256, 512, 0.2)).toBe(0);
		expect(sampleBalance(512, 512, 0.2)).toBe(0.2);
		expect(sampleBalance(0, 512, 0.2)).toBe(-0.2);
		expect(sampleBalance(512, 512, 1)).toBe(1);
		// the rounding is lazer's own, not ours: "balance is very hard to
		// perceive in small increments anyways"
		expect(sampleBalance(300, 512, 0.2)).toBe(0.03);
	});

	test("a level of zero centres everything", () => {
		const scene = sceneOf([circle(1000, [lookup()], 0)], [event(1000, { type: "circle", grade: "great" })]);
		expect(buildHitsoundPlan(scene, { ...OPTIONS, positionalLevel: 0 })[0].balance).toBe(0);
	});

	test("a sample is panned by ITS OWN object's position", () => {
		const scene = sceneOf(
			[circle(1000, [lookup()], 0), circle(2000, [lookup()], 512)],
			[event(1000, { type: "circle", grade: "great" }), event(2000, { type: "circle", grade: "great" }, 2, 1)]
		);
		expect(buildHitsoundPlan(scene, OPTIONS).map((s) => s.balance)).toEqual([-0.2, 0.2]);
	});
});

describe("slider pieces", () => {
	const parts = [
		nested("head", 0, 1000, [lookup({ bank: "normal" })]),
		nested("tick", 0, 1250, [lookup({ bank: "drum", name: "slidertick" })]),
		nested("repeat", 0, 1500, [lookup({ bank: "soft", name: "hitwhistle" })]),
		nested("repeat", 1, 2000, [lookup({ bank: "drum", name: "hitfinish" })]),
		nested("tail", 1, 2500, [lookup({ bank: "soft", name: "hitclap" })])
	];

	// the tail is the one piece that does not sound from its own judgement --
	// see the end-sound block below for the 36ms that buys
	test("head, repeat, tail and tick each sound their own node's samples", () => {
		const scene = sceneOf(
			[slider(1000, parts)],
			[
				event(1000, { type: "sliderHead", hit: true }),
				event(1250, { type: "sliderTick", hit: true }),
				event(1500, { type: "sliderRepeat", hit: true, repeatIndex: 0 }),
				event(2000, { type: "sliderRepeat", hit: true, repeatIndex: 1 }),
				event(2500, { type: "sliderTail", hit: true }),
				event(2500, { type: "sliderAggregate", grade: "great" })
			]
		);
		expect(names(buildHitsoundPlan(scene, OPTIONS))).toEqual([
			"Gameplay/normal-hitnormal",
			"Gameplay/drum-slidertick",
			"Gameplay/soft-hitwhistle",
			"Gameplay/drum-hitfinish",
			"Gameplay/soft-hitclap"
		]);
	});

	describe("THE SLIDER'S END SOUND LANDS AT THE SLIDER'S END", () => {
		// the loudest timing bug this app had. the tail judgement fires at the
		// LEGACY LAST TICK -- `TAIL_LENIENCY = -36`ms (slidereventgenerator.cs:24)
		// -- so sounding it off that event put every slider's end sound 36ms
		// early. measured against the local corpus: the tail judgement sits at
		// -36.9ms from the slider's end on essentially every slider of every
		// replay, while the AGGREGATE judgement sits within a millisecond of it.
		// lazer solves it the same way and left a note saying why
		// (slider.cs:285-289)

		// the shapes the real engine produces: the tail NODE at the slider's
		// end, the tail JUDGEMENT 36ms before it, the aggregate on the end
		const endTime = 2500;
		const tailJudgedAt = endTime - 36;

		test("the end sound is at the end time, not 36ms before it", () => {
			const scene = sceneOf(
				[slider(1000, parts)],
				[
					event(tailJudgedAt, { type: "sliderTail", hit: true }),
					event(endTime, { type: "sliderAggregate", grade: "great" })
				]
			);
			const plan = buildHitsoundPlan(scene, OPTIONS);
			expect(plan.map((s) => [s.time, s.request.names[0]])).toEqual([[endTime, "Gameplay/soft-hitclap"]]);
		});

		test("it sounds exactly once -- the tail judgement no longer carries it", () => {
			// the failure mode of moving a sample rather than copying it: both
			// events firing would flam every slider in the map
			const scene = sceneOf(
				[slider(1000, parts)],
				[
					event(tailJudgedAt, { type: "sliderTail", hit: true }),
					event(endTime, { type: "sliderAggregate", grade: "great" })
				]
			);
			expect(buildHitsoundPlan(scene, OPTIONS)).toHaveLength(1);
		});

		test("a dropped tail is silent even though the slider itself scored", () => {
			// drawableslider.cs:332 -- `!TailCircle.SamplePlaysOnlyOnHit ||
			// TailCircle.IsHit`, and the default is that it only plays on a hit.
			// releasing early still scores the slider off its head and ticks
			const scene = sceneOf(
				[slider(1000, parts)],
				[
					event(tailJudgedAt, { type: "sliderTail", hit: false }),
					event(endTime, { type: "sliderAggregate", grade: "ok" })
				]
			);
			expect(buildHitsoundPlan(scene, OPTIONS)).toHaveLength(0);
		});

		test("a slider that scored nothing makes no end sound -- only the break", () => {
			// drawableslider.cs:317-320 -- a slider armed Miss never reaches
			// PlaySamples. the tail cannot be hit under a miss aggregate, so this
			// is belt and braces, and it is the gate that would matter first if
			// the engine's proportional fold ever changed. the break the dropped
			// combo makes is a sound the GAME makes, not one this slider does
			const scene = sceneOf(
				[slider(1000, parts)],
				[
					event(tailJudgedAt, { type: "sliderTail", hit: true }),
					event(endTime, { type: "sliderAggregate", grade: "miss" }, 0)
				]
			);
			expect(names(buildHitsoundPlan(scene, OPTIONS))).toEqual(["Gameplay/combobreak"]);
		});

		test("the tail's gate reaches its own slider and no other", () => {
			// the join is by object index, so two sliders in flight cannot lend
			// each other a tail: the first drops its tail, the second holds
			const dropped = slider(1000, parts);
			const held = slider(3000, parts);
			const scene = sceneOf(
				[dropped, held],
				[
					event(tailJudgedAt, { type: "sliderTail", hit: false }, 1, 0),
					event(endTime, { type: "sliderAggregate", grade: "ok" }, 1, 0),
					event(4464, { type: "sliderTail", hit: true }, 1, 1),
					event(4500, { type: "sliderAggregate", grade: "great" }, 1, 1)
				]
			);
			expect(buildHitsoundPlan(scene, OPTIONS).map((s) => s.time)).toEqual([4500]);
		});
	});

	test("A REPEAT'S SAMPLE IS PICKED BY NODE IDENTITY, not by emission order", () => {
		// the property ticket 01 exists for. the two repeat judgements arrive
		// in the WRONG order here; each must still take its own node, because
		// the node it came from rides on the event rather than being recovered
		// by counting
		const scene = sceneOf(
			[slider(1000, parts)],
			[
				event(2000, { type: "sliderRepeat", hit: true, repeatIndex: 1 }),
				event(1500, { type: "sliderRepeat", hit: true, repeatIndex: 0 })
			]
		);
		const plan = buildHitsoundPlan(scene, OPTIONS);
		// sorted back into time order, and each still carries its own node
		expect(plan.map((s) => [s.time, s.request.names[0]])).toEqual([
			[1500, "Gameplay/soft-hitwhistle"],
			[2000, "Gameplay/drum-hitfinish"]
		]);
	});

	test("a dropped nested object is silent, exactly as a missed circle is", () => {
		const scene = sceneOf(
			[slider(1000, parts)],
			[
				event(1000, { type: "sliderHead", hit: false }, 0),
				event(1250, { type: "sliderTick", hit: false }, 0),
				event(1500, { type: "sliderRepeat", hit: false, repeatIndex: 0 }, 0),
				event(2500, { type: "sliderTail", hit: false }, 0)
			]
		);
		expect(buildHitsoundPlan(scene, OPTIONS)).toHaveLength(0);
	});

	test("an aggregate whose tail was never hit is silent", () => {
		// the aggregate is what TIMES the end sound, but the tail is what
		// decides there is one (drawableslidertail.cs:31 SamplePlaysOnlyOnHit
		// defaults to true). with no tail judgement at all there is nothing to
		// have hit, and a slider that sounded anyway would be sounding a node
		// the play dropped
		const scene = sceneOf([slider(1000, parts)], [event(2500, { type: "sliderAggregate", grade: "great" })]);
		expect(buildHitsoundPlan(scene, OPTIONS)).toHaveLength(0);
	});

	test("a tick joins the nearest generated tick even when the two lists time it differently", () => {
		// the simulation times its ticks by stable's own accumulated walk while
		// the render plan's nested list is lazer's -- a documented divergence,
		// so the join is by nearest rather than by exact equality
		const scene = sceneOf([slider(1000, parts)], [event(1253, { type: "sliderTick", hit: true })]);
		expect(names(buildHitsoundPlan(scene, OPTIONS))).toEqual(["Gameplay/drum-slidertick"]);
	});
});

describe("spinners", () => {
	test("a spinner sounds its own samples at its final judgement", () => {
		const scene = sceneOf(
			[spinner(1000, [lookup({ name: "spinnerbonus" })], [lookup({ bank: "soft" })])],
			[event(3000, { type: "spinnerFinal", grade: "great" })]
		);
		expect(names(buildHitsoundPlan(scene, OPTIONS))).toEqual(["Gameplay/soft-hitnormal"]);
	});

	test("a missed spinner is silent", () => {
		const scene = sceneOf(
			[spinner(1000, [lookup({ name: "spinnerbonus" })], [lookup()])],
			[event(3000, { type: "spinnerFinal", grade: "miss" }, 0)]
		);
		expect(buildHitsoundPlan(scene, OPTIONS)).toHaveLength(0);
	});

	test("bonus spins sound as they land; ordinary spins do not", () => {
		// spinner.cs:92-94 -- a SpinnerTick carries no samples at all, only a
		// SpinnerBonusTick does
		const scene = sceneOf(
			[spinner(1000, [lookup({ bank: "drum", name: "spinnerbonus" })])],
			[
				event(1500, { type: "spinnerSpin" }),
				event(2000, { type: "spinnerBonus" }),
				event(2400, { type: "spinnerBonus" })
			]
		);
		const plan = buildHitsoundPlan(scene, OPTIONS);
		expect(plan.map((s) => [s.time, s.request.names[0]])).toEqual([
			[2000, "Gameplay/drum-spinnerbonus"],
			[2400, "Gameplay/drum-spinnerbonus"]
		]);
	});

	test("no looping sample is ever scheduled", () => {
		// sliderslide, sliderwhistle and spinnerspin are vendored but out of
		// scope: a tracking-driven gain envelope has nothing in common with a
		// lookahead scheduler
		const scene = sceneOf(
			[slider(1000, [nested("head", 0, 1000, [lookup()]), nested("tail", 0, 2000, [lookup()])])],
			[
				event(1000, { type: "sliderHead", hit: true }),
				event(1964, { type: "sliderTail", hit: true }),
				event(2000, { type: "sliderAggregate", grade: "great" })
			]
		);
		const requested = buildHitsoundPlan(scene, OPTIONS).flatMap((s) => s.request.names);
		expect(requested.some((n) => /sliderslide|sliderwhistle|spinnerspin/.test(n))).toBe(false);
	});
});

describe("combo break", () => {
	// comboeffects.cs:59 -- combo reaches 0 AND (the combo lost was > 20, or it
	// is the play's first break and the preference is on)
	function breakAfter(combo: number, options: HitsoundOptions = OPTIONS, alreadyBroken = false) {
		const events: JudgementEventDto[] = [];
		if (alreadyBroken) {
			// an earlier break, so the one under test is not the first
			events.push(event(100, { type: "circle", grade: "great" }, 1));
			events.push(event(200, { type: "circle", grade: "miss" }, 0));
		}
		events.push(event(1000, { type: "circle", grade: "great" }, combo));
		events.push(event(2000, { type: "circle", grade: "miss" }, 0));
		const scene = sceneOf([circle(1000, []), circle(2000, [])], events);
		// only the break under test at t=2000; the `alreadyBroken` prelude
		// deliberately sounds its own, which is what makes the later one not
		// the play's first
		return buildHitsoundPlan(scene, options).filter(
			(s) => s.request.names[0] === "Gameplay/combobreak" && s.time === 2000
		);
	}

	test("losing a combo of 21 plays; losing a combo of 20 does not", () => {
		// the boundary is strict: OldValue > 20
		expect(breakAfter(COMBO_BREAK_THRESHOLD + 1, OPTIONS, true)).toHaveLength(1);
		expect(breakAfter(COMBO_BREAK_THRESHOLD, OPTIONS, true)).toHaveLength(0);
	});

	test("the play's FIRST break plays regardless of combo size, unless the preference is off", () => {
		expect(breakAfter(1)).toHaveLength(1);
		expect(breakAfter(1, { ...OPTIONS, alwaysPlayFirstComboBreak: false })).toHaveLength(0);
	});

	test("the first-break marker is derived from THIS timeline, so erasing a break promotes the next", () => {
		// the reason the marker is never remembered in the scheduler: editing
		// away an early miss must make the next break sound, and a stale marker
		// would silence exactly the break the user was listening for
		const withEarlyBreak = breakAfter(1, OPTIONS, true);
		const withoutEarlyBreak = breakAfter(1, OPTIONS, false);
		// with an earlier break present, the small later one is not first and
		// stays silent; erase that earlier break and the same event sounds
		expect(withEarlyBreak).toHaveLength(0);
		expect(withoutEarlyBreak).toHaveLength(1);
	});

	test("a combo that was already zero is not a break", () => {
		// lazer's Combo bindable only fires on a change; a run of misses breaks
		// once, not once per miss
		const scene = sceneOf(
			[circle(1000, []), circle(2000, []), circle(3000, [])],
			[
				event(1000, { type: "circle", grade: "great" }, 30),
				event(2000, { type: "circle", grade: "miss" }, 0),
				event(3000, { type: "circle", grade: "miss" }, 0, 2)
			]
		);
		expect(
			buildHitsoundPlan(scene, OPTIONS).filter((s) => s.request.names[0] === "Gameplay/combobreak")
		).toHaveLength(1);
	});

	test("the break sound is centred and at full volume, being the game's rather than an object's", () => {
		const [breakSound] = breakAfter(1);
		expect(breakSound.balance).toBe(0);
		expect(breakSound.gain).toBe(1);
	});
});
