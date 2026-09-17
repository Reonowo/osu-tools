import { describe, expect, test } from "bun:test";
import { approximateNativeTestScene, nativeTestScene, testScene } from "../test/scene";
import type { Grade, HpCurve, JudgementEventDto, LoadedScene, RenderNested, RenderObject } from "./scene-types";
import { deriveScene, describeDrops, displayRank, dropSummary, type ObjectLaneEntry } from "./derive";
import { severityJump } from "./judgement-nav";

describe("deriveScene", () => {
	describe("hp", () => {
		/** the scene's own simulation carrying a chosen HP curve */
		function withCurve(hpCurve: HpCurve): LoadedScene {
			const base = testScene();
			if (base.simulation.status !== "authoritative") throw new Error("the test scene is authoritative");
			return testScene({ simulation: { ...base.simulation, hpCurve } });
		}

		test("a scene with no authoritative simulation has no curve at all", () => {
			const d = deriveScene(
				testScene({
					simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } }
				})
			);
			expect(d.hp).toEqual({ curve: [], lowest: null, failPoint: null });
		});

		test("an empty curve reports neither a lowest point nor a fail point", () => {
			const d = deriveScene(withCurve([]));
			expect(d.hp).toEqual({ curve: [], lowest: null, failPoint: null });
		});

		test("a clean play reports its lowest point and no fail point", () => {
			const d = deriveScene(
				withCurve([
					[0, 1],
					[1000, 0.4],
					[2000, 0.8]
				])
			);
			expect(d.hp.lowest).toEqual({ time: 1000, fraction: 0.4 });
			expect(d.hp.failPoint).toBeNull();
		});

		test("a play reaching zero twice keeps the first zero as its fail point", () => {
			const d = deriveScene(
				withCurve([
					[0, 1],
					[500, 0],
					[900, 0.7],
					[1400, 0],
					[1800, 0.3]
				])
			);
			expect(d.hp.failPoint).toBe(500);
		});

		test("the curve rides straight from the scene, never re-derived here", () => {
			const curve: HpCurve = [
				[0, 1],
				[10, 0.5]
			];
			expect(deriveScene(withCurve(curve)).hp.curve).toEqual(curve);
		});
	});

	test("bounds cover lead-in, frames, preempt, and fade-out tails", () => {
		const d = deriveScene(testScene());
		// min(0, -leadIn, firstFrame, firstAppear = 1000 - 600)
		expect(d.bounds.minTime).toBe(-1500);
		// max(lastFrame, lastEnd + 800)
		expect(d.bounds.maxTime).toBe(1800);
	});

	test("bounds reach an object that appears before the earliest-starting one", () => {
		// the second object starts later but carries the longer preempt, so it
		// is the first to appear: 1200 - 3000 = -1800, past the lead-in's -1500
		const base = testScene();
		const d = deriveScene(
			testScene({
				renderPlan: { ...base.renderPlan, objects: [circle(1000), { ...circle(1200), preempt: 3000 }] }
			})
		);
		expect(d.bounds.minTime).toBe(-1800);
		expect(d.timelineBounds.minTime).toBe(-1800);
	});

	test("timelineBounds are the judgement deadline bound, immune to event times", () => {
		const base = deriveScene(testScene());
		// min shared with the playback bounds; max(lastFrame, lastEnd + miss
		// window + 800) -- testScene: max(1100, 1000 + 400 + 800)
		expect(base.timelineBounds.minTime).toBe(-1500);
		expect(base.timelineBounds.maxTime).toBe(2200);

		// the latest possible judgement (a miss at the window's close) still
		// fits inside; the playback bounds move with it, the mapping does not
		const scene = testScene();
		const late = deriveScene(
			testScene({
				simulation: {
					...scene.simulation,
					status: "authoritative",
					hpCurve: [],
					scoreCurve: [],
					events: [
						{
							time: 1400,
							objectIndex: 0,
							kind: { type: "circle", grade: "miss" },
							comboAfter: 0,
							accuracyAfter: 0
						}
					],
					totals: { count300: 0, count100: 0, count50: 0, countMiss: 1, maxCombo: 0, accuracy: 0, rank: "d" }
				}
			})
		);
		expect(late.bounds.maxTime).toBe(2200);
		expect(late.timelineBounds.maxTime).toBe(2200);
	});

	test("a late judgement extends maxTime through its full fade", () => {
		// a circle hit 180ms late animates until 1180 + 800 (objectLifetime
		// keeps its drawable alive that long); the clock must not pause before
		// that when there is no audio to extend the bounds
		const scene = testScene();
		const d = deriveScene(
			testScene({
				simulation: {
					...scene.simulation,
					status: "authoritative",
					hpCurve: [],
					scoreCurve: [],
					events: [
						{
							time: 1180,
							objectIndex: 0,
							kind: { type: "circle", grade: "meh" },
							comboAfter: 1,
							accuracyAfter: 50 / 300
						}
					],
					totals: {
						count300: 0,
						count100: 0,
						count50: 1,
						countMiss: 0,
						maxCombo: 1,
						accuracy: 50 / 300,
						rank: "d"
					}
				}
			})
		);
		expect(d.bounds.maxTime).toBe(1980);
	});

	test("judgements group by object and severity ticks keep non-great grades", () => {
		const d = deriveScene(testScene());
		expect(d.judgementsByObject[0]).toHaveLength(1);
		expect(d.severityTicks).toEqual([{ time: 980, grade: "ok", objectIndex: 0, drop: false }]);
	});

	test("notSimulated scenes derive empty judgement data", () => {
		const d = deriveScene(
			testScene({ simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } } })
		);
		expect(d.judgementsByObject[0]).toEqual([]);
		expect(d.severityTicks).toEqual([]);
		expect(d.severityTargets).toEqual({ ok: [], meh: [], miss: [] });
		expect(d.presses).toHaveLength(1); // analysis data still derives
	});
});

function circle(startTime: number): RenderObject {
	return {
		startTime,
		endTime: startTime,
		position: [0, 0],
		stackHeight: 0,
		comboColourIndex: 0,
		comboIndex: 0,
		indexInCombo: 0,
		preempt: 600,
		fadeIn: 400,
		samples: [],
		kind: { type: "circle" }
	};
}

function nested(kind: RenderNested["kind"], time: number, spanIndex = 0): RenderNested {
	return { kind, spanIndex, time, position: [0, 0], pathProgress: 0, preempt: 600, fadeIn: 400, samples: [] };
}

function slider(startTime: number, endTime: number, nestedParts: RenderNested[]): RenderObject {
	// the span shape follows the nested list so a repeat-bearing literal stays
	// a slider the engine could emit: n repeats mean n + 1 spans, and the tail
	// always rides the last one
	const repeatCount = nestedParts.filter((n) => n.kind === "repeat").length;
	const spanCount = repeatCount + 1;
	return {
		...circle(startTime),
		endTime,
		kind: {
			type: "slider",
			vertices: [0, 0, 10, 0],
			cumulativeLengths: [0, 10],
			distance: 10,
			segmentEnds: [1],
			repeatCount,
			spanCount,
			spanDuration: (endTime - startTime) / spanCount,
			duration: endTime - startTime,
			endPosition: [10, 0],
			snakeInDuration: 100,
			nested: nestedParts.map((n) => (n.kind === "tail" ? { ...n, spanIndex: spanCount - 1 } : n))
		}
	};
}

function spinner(startTime: number, endTime: number): RenderObject {
	return {
		...circle(startTime),
		endTime,
		kind: { type: "spinner", duration: endTime - startTime, spinsRequired: 3, maxBonusSpins: 1, bonusSamples: [] }
	};
}

function event(time: number, objectIndex: number, kind: JudgementEventDto["kind"]): JudgementEventDto {
	return { time, objectIndex, kind, comboAfter: 1, accuracyAfter: 1 };
}

function laneScene(objects: RenderObject[], events: JudgementEventDto[], frames: LoadedScene["frames"]): LoadedScene {
	const base = testScene();
	return testScene({
		frames,
		renderPlan: { ...base.renderPlan, objects },
		simulation: {
			status: "authoritative",
			hpCurve: [],
			scoreCurve: [],
			events,
			totals: { count300: 0, count100: 0, count50: 0, countMiss: 0, maxCombo: 0, accuracy: 0, rank: "d" }
		}
	});
}

describe("deriveScene object lane", () => {
	test("a hit circle carries its grade and a tether from its start time to the press time", () => {
		const d = deriveScene(testScene());
		expect(d.objectLane).toHaveLength(1);
		expect(d.objectLane[0].grade).toBe("ok");
		// the default scene's press at 980 is raw buttons 1: an M1 press
		expect(d.objectLane[0].tether).toEqual({ fromTime: 1000, toTime: 980, key: "M1", pressFrameIndex: 1 });
	});

	test("a missed circle carries its grade and no tether", () => {
		const d = deriveScene(
			laneScene(
				[circle(1000)],
				[event(1150, 0, { type: "circle", grade: "miss" })],
				[
					{ time: 0, x: 0, y: 0, buttons: 0 },
					{ time: 1150, x: 0, y: 0, buttons: 1 },
					{ time: 1200, x: 0, y: 0, buttons: 0 }
				]
			)
		);
		expect(d.objectLane[0].grade).toBe("miss");
		expect(d.objectLane[0].tether).toBeNull();
	});

	test("a slider tethers from its head nested time to the slider-head event, graded by the aggregate", () => {
		const d = deriveScene(
			laneScene(
				[slider(1000, 1500, [nested("head", 1000), nested("tick", 1250), nested("tail", 1500)])],
				[
					event(1012, 0, { type: "sliderHead", grade: "great" }),
					event(1500, 0, { type: "sliderAggregate", grade: "meh" })
				],
				[
					{ time: 0, x: 0, y: 0, buttons: 0 },
					{ time: 1012, x: 0, y: 0, buttons: 5 },
					{ time: 1600, x: 0, y: 0, buttons: 0 }
				]
			)
		);
		expect(d.objectLane[0].grade).toBe("meh");
		expect(d.objectLane[0].tether).toEqual({ fromTime: 1000, toTime: 1012, key: "K1", pressFrameIndex: 1 });
	});

	test("a head-missed slider keeps its aggregate grade with no tether", () => {
		const d = deriveScene(
			laneScene(
				[slider(1000, 1500, [nested("head", 1000), nested("tail", 1500)])],
				[
					event(1150, 0, { type: "sliderHead", grade: "miss" }),
					event(1500, 0, { type: "sliderAggregate", grade: "ok" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].grade).toBe("ok");
		expect(d.objectLane[0].tether).toBeNull();
	});

	test("a spinner carries a grade and never a tether, even judged great", () => {
		const d = deriveScene(
			laneScene(
				[spinner(1000, 2000)],
				[event(2000, 0, { type: "spinnerFinal", grade: "great" })],
				[
					{ time: 0, x: 0, y: 0, buttons: 0 },
					{ time: 2000, x: 0, y: 0, buttons: 1 },
					{ time: 2100, x: 0, y: 0, buttons: 0 }
				]
			)
		);
		expect(d.objectLane[0].grade).toBe("great");
		expect(d.objectLane[0].tether).toBeNull();
	});

	test("simultaneous left and right rises resolve left-first, pairing same-time events in event order", () => {
		// one frame raises K1 and K2 together; two circles judged at that
		// millisecond pair (first event, left press) then (second event, right)
		const d = deriveScene(
			laneScene(
				[circle(1000), circle(1010)],
				[event(1005, 0, { type: "circle", grade: "great" }), event(1005, 1, { type: "circle", grade: "ok" })],
				[
					{ time: 0, x: 0, y: 0, buttons: 0 },
					{ time: 1005, x: 0, y: 0, buttons: 15 },
					{ time: 1100, x: 0, y: 0, buttons: 0 }
				]
			)
		);
		expect(d.objectLane[0].tether).toEqual({ fromTime: 1000, toTime: 1005, key: "K1", pressFrameIndex: 1 });
		expect(d.objectLane[1].tether).toEqual({ fromTime: 1010, toTime: 1005, key: "K2", pressFrameIndex: 1 });
	});

	test("a same-millisecond release and re-press stay distinct through the press frame index", () => {
		// duplicate-time frames are legal: K1 falls and rises again at 1005,
		// making two distinct runs whose rising edges share one millisecond.
		// (toTime, key) is identical for both tethers, so the frame index is
		// the only thing telling the judging runs apart
		const d = deriveScene(
			laneScene(
				[circle(1000), circle(1010)],
				[event(1005, 0, { type: "circle", grade: "great" }), event(1005, 1, { type: "circle", grade: "ok" })],
				[
					{ time: 0, x: 0, y: 0, buttons: 0 },
					{ time: 1005, x: 0, y: 0, buttons: 5 },
					{ time: 1005, x: 0, y: 0, buttons: 0 },
					{ time: 1005, x: 0, y: 0, buttons: 5 },
					{ time: 1100, x: 0, y: 0, buttons: 0 }
				]
			)
		);
		expect(d.objectLane[0].tether).toEqual({ fromTime: 1000, toTime: 1005, key: "K1", pressFrameIndex: 1 });
		expect(d.objectLane[1].tether).toEqual({ fromTime: 1010, toTime: 1005, key: "K1", pressFrameIndex: 3 });
	});

	test("slider nested marks keep heads, repeats and tails and drop ticks", () => {
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 2000, [
						nested("head", 1000),
						nested("tick", 1200),
						nested("repeat", 1500),
						nested("tick", 1700),
						nested("tail", 2000)
					])
				],
				[],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].nestedMarks).toEqual([
			{ time: 1000, dropped: false },
			{ time: 1500, dropped: false },
			{ time: 2000, dropped: false }
		]);
		expect(d.objectLane[0].tickDrops).toEqual([]);
	});

	test("circles and spinners carry no nested marks", () => {
		const d = deriveScene(
			laneScene([circle(1000), spinner(1500, 2500)], [], [{ time: 0, x: 0, y: 0, buttons: 0 }])
		);
		expect(d.objectLane[0].nestedMarks).toEqual([]);
		expect(d.objectLane[1].nestedMarks).toEqual([]);
		expect(d.objectLane[0].tickDrops).toEqual([]);
		expect(d.objectLane[1].tickDrops).toEqual([]);
	});

	test("a notSimulated scene derives objects with null grades and no tethers", () => {
		const base = testScene();
		const d = deriveScene(
			testScene({
				renderPlan: { ...base.renderPlan, objects: [circle(1000), spinner(1500, 2500)] },
				simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } }
			})
		);
		expect(d.objectLane).toHaveLength(2);
		expect(d.objectLane.every((entry) => entry.grade === null && entry.tether === null)).toBe(true);
	});

	test("lead-in objects survive derivation", () => {
		const d = deriveScene(
			laneScene(
				[circle(-500), circle(1000)],
				[event(-510, 0, { type: "circle", grade: "great" })],
				[
					{ time: -600, x: 0, y: 0, buttons: 0 },
					{ time: -510, x: 0, y: 0, buttons: 1 },
					{ time: -400, x: 0, y: 0, buttons: 0 }
				]
			)
		);
		expect(d.objectLane).toHaveLength(2);
		expect(d.objectLane[0].tether).toEqual({ fromTime: -500, toTime: -510, key: "M1", pressFrameIndex: 1 });
	});

	test("severity ticks cover circle, slider-aggregate and spinner-final events, excluding greats", () => {
		const d = deriveScene(
			laneScene(
				[circle(1000), slider(2000, 2500, [nested("head", 2000)]), spinner(3000, 4000), circle(5000)],
				[
					event(1005, 0, { type: "circle", grade: "meh" }),
					// the ok aggregate's cause rides beside it: the dropped head
					event(2150, 1, { type: "sliderHead", grade: "miss" }),
					event(2500, 1, { type: "sliderAggregate", grade: "ok" }),
					event(4000, 2, { type: "spinnerFinal", grade: "miss" }),
					event(5000, 3, { type: "circle", grade: "great" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.severityTicks).toEqual([
			{ time: 1005, grade: "meh", objectIndex: 0, drop: false },
			{ time: 2500, grade: "ok", objectIndex: 1, drop: true },
			{ time: 4000, grade: "miss", objectIndex: 2, drop: false }
		]);
	});

	test("the drop flag reads the object's drop list -- circles, spinners and missed sliders stay plain", () => {
		// every below-great slider is drop-caused under the stable profile
		// (the aggregate is a pure element-count fold, so an ok or meh always
		// has a dropped element beside it), and the flag reads that drop list
		// rather than the grade, which is what lets the native profile's
		// timing-100 head read as no drop. a fully missed slider carries no
		// drop state and keeps the plain miss tick per the partially-hit
		// exception
		const d = deriveScene(
			laneScene(
				[
					circle(1000),
					slider(2000, 2500, [nested("head", 2000), nested("tail", 2500)]),
					slider(3000, 3500, [nested("head", 3000), nested("tail", 3500)]),
					slider(4000, 4500, [nested("head", 4000), nested("tail", 4500)]),
					spinner(5000, 6000)
				],
				[
					event(1005, 0, { type: "circle", grade: "ok" }),
					event(2464, 1, { type: "sliderTail", hit: false, nestedIndex: 1 }),
					event(2500, 1, { type: "sliderAggregate", grade: "ok" }),
					event(3150, 2, { type: "sliderHead", grade: "miss" }),
					event(3500, 2, { type: "sliderAggregate", grade: "meh" }),
					event(4150, 3, { type: "sliderHead", grade: "miss" }),
					event(4464, 3, { type: "sliderTail", hit: false, nestedIndex: 1 }),
					event(4900, 3, { type: "sliderAggregate", grade: "miss" }),
					event(6000, 4, { type: "spinnerFinal", grade: "meh" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.severityTicks.map((tick) => [tick.objectIndex, tick.drop])).toEqual([
			[0, false],
			[1, true],
			[2, true],
			[3, false],
			[4, false]
		]);
	});

	test("the derived target lists agree with the ticks they were built from", () => {
		// what is pinned here is the join, not the search: which ticks exist and
		// which grades they carry is the test above, and where a jump lands is
		// judgement-nav's own. this is the one seam between them -- that every
		// mark the strip draws is reachable, under its own grade, at its own
		// object's appearance
		const d = deriveScene(
			laneScene(
				[circle(1000), slider(2000, 2500, [nested("head", 2000)]), spinner(3000, 4000), circle(5000)],
				[
					event(1005, 0, { type: "circle", grade: "meh" }),
					event(2500, 1, { type: "sliderAggregate", grade: "ok" }),
					event(4000, 2, { type: "spinnerFinal", grade: "miss" }),
					event(5000, 3, { type: "circle", grade: "great" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		const objects = Object.values(d.severityTargets).flat();
		expect(objects.map((target) => target.objectIndex).sort()).toEqual(
			d.severityTicks.map((tick) => tick.objectIndex).sort()
		);
		// each landing is its object's own start time, never the event time the
		// tick beside it carries (1005 / 2500 / 4000 above)
		expect(d.severityTargets.meh).toEqual([{ objectIndex: 0, landingTime: 1000, grade: "meh" }]);
		expect(d.severityTargets.ok).toEqual([{ objectIndex: 1, landingTime: 2000, grade: "ok" }]);
		expect(d.severityTargets.miss).toEqual([{ objectIndex: 2, landingTime: 3000, grade: "miss" }]);
	});

	test("invariant: objects carrying a tether equal the analysis hit-error list in count", () => {
		// every tether-relevant shape at once: a hit circle, a missed circle, a
		// hit-head slider, a head-missed slider, and a spinner
		const d = deriveScene(
			laneScene(
				[
					circle(1000),
					circle(2000),
					slider(3000, 3500, [nested("head", 3000), nested("tail", 3500)]),
					slider(4000, 4500, [nested("head", 4000), nested("tail", 4500)]),
					spinner(5000, 6000)
				],
				[
					event(990, 0, { type: "circle", grade: "great" }),
					event(2400, 1, { type: "circle", grade: "miss" }),
					event(3020, 2, { type: "sliderHead", grade: "great" }),
					event(3500, 2, { type: "sliderAggregate", grade: "great" }),
					event(4150, 3, { type: "sliderHead", grade: "miss" }),
					event(4500, 3, { type: "sliderAggregate", grade: "ok" }),
					event(6000, 4, { type: "spinnerFinal", grade: "great" })
				],
				[
					{ time: 0, x: 0, y: 0, buttons: 0 },
					{ time: 990, x: 0, y: 0, buttons: 1 },
					{ time: 995, x: 0, y: 0, buttons: 0 },
					{ time: 3020, x: 0, y: 0, buttons: 5 },
					{ time: 3600, x: 0, y: 0, buttons: 0 }
				]
			)
		);
		const tethered = d.objectLane.filter((entry) => entry.tether !== null);
		expect(tethered).toHaveLength(d.analysis.errors.length);
		expect(tethered).toHaveLength(2);
	});
});

describe("deriveScene drop marks", () => {
	test("a dropped head, repeat, and tail each flip exactly their own mark, at its geometry time", () => {
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 1500, [nested("head", 1000), nested("tick", 1250), nested("tail", 1500)]),
					slider(2000, 2500, [nested("head", 2000), nested("repeat", 2250), nested("tail", 2500)]),
					slider(3000, 3500, [nested("head", 3000), nested("tail", 3500)])
				],
				[
					event(1100, 0, { type: "sliderHead", grade: "miss" }),
					event(1250, 0, { type: "sliderTick", hit: true, nestedIndex: null }),
					event(1464, 0, { type: "sliderTail", hit: true, nestedIndex: null }),
					event(1500, 0, { type: "sliderAggregate", grade: "ok" }),
					event(2010, 1, { type: "sliderHead", grade: "great" }),
					event(2250, 1, { type: "sliderRepeat", hit: false, repeatIndex: 0, nestedIndex: null }),
					event(2464, 1, { type: "sliderTail", hit: true, nestedIndex: null }),
					event(2500, 1, { type: "sliderAggregate", grade: "ok" }),
					event(3010, 2, { type: "sliderHead", grade: "great" }),
					event(3464, 2, { type: "sliderTail", hit: false, nestedIndex: null }),
					// the true fold value: 1 of 2 elements is exactly 0.5, and a
					// two-element slider can never land meh
					event(3500, 2, { type: "sliderAggregate", grade: "ok" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].nestedMarks).toEqual([
			{ time: 1000, dropped: true },
			{ time: 1500, dropped: false }
		]);
		expect(d.objectLane[1].nestedMarks).toEqual([
			{ time: 2000, dropped: false },
			{ time: 2250, dropped: true },
			{ time: 2500, dropped: false }
		]);
		// the tail's mark keeps the drawn end time: the event sits at the
		// legacy last tick (3464 = 3500 - 36) and the mark must not slide there
		expect(d.objectLane[2].nestedMarks).toEqual([
			{ time: 3000, dropped: false },
			{ time: 3500, dropped: true }
		]);
		expect(d.objectLane.map((entry) => entry.tickDrops)).toEqual([[], [], []]);
	});

	test("repeats match by index: two repeats, only the dropped second one's mark flips", () => {
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 3000, [
						nested("head", 1000),
						nested("repeat", 1666, 0),
						nested("repeat", 2333, 1),
						nested("tail", 3000)
					])
				],
				[
					event(1010, 0, { type: "sliderHead", grade: "great" }),
					event(1666, 0, { type: "sliderRepeat", hit: true, repeatIndex: 0, nestedIndex: null }),
					event(2333, 0, { type: "sliderRepeat", hit: false, repeatIndex: 1, nestedIndex: null }),
					event(2964, 0, { type: "sliderTail", hit: true, nestedIndex: null }),
					event(3000, 0, { type: "sliderAggregate", grade: "ok" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		// a kind-only match would flip the first repeat's mark instead
		expect(d.objectLane[0].nestedMarks).toEqual([
			{ time: 1000, dropped: false },
			{ time: 1666, dropped: false },
			{ time: 2333, dropped: true },
			{ time: 3000, dropped: false }
		]);
	});

	test("dropped ticks land in tickDrops at their event's own times, ascending; hit ticks appear nowhere", () => {
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 2000, [
						nested("head", 1000),
						nested("tick", 1250),
						nested("tick", 1500),
						nested("tick", 1750),
						nested("tail", 2000)
					])
				],
				[
					event(1010, 0, { type: "sliderHead", grade: "great" }),
					// deliberately not the render plan's tick times: the mark sits
					// where the simulation judged the drop
					event(1252, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					event(1500, 0, { type: "sliderTick", hit: true, nestedIndex: null }),
					event(1751, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					// the dropped tail keeps the aggregate a genuine meh: 2 of 5
					// elements folds to 0.4
					event(1964, 0, { type: "sliderTail", hit: false, nestedIndex: null }),
					event(2000, 0, { type: "sliderAggregate", grade: "meh" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].tickDrops).toEqual([1252, 1751]);
		// the hit tick at 1500 appears nowhere; only the tail's own mark flips
		expect(d.objectLane[0].nestedMarks).toEqual([
			{ time: 1000, dropped: false },
			{ time: 2000, dropped: true }
		]);
	});

	test("a dropped tick that names its element marks at that element's own time", () => {
		// the identity join: the stable judgement of the FIRST tick lands
		// 140ms late, nearer the second tick's time -- the mark goes where the
		// named element is, not where a nearest-time guess would put it
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 2000, [
						nested("head", 1000),
						nested("tick", 1250),
						nested("tick", 1400),
						nested("tail", 2000)
					])
				],
				[
					event(1010, 0, { type: "sliderHead", grade: "great" }),
					event(1390, 0, { type: "sliderTick", hit: false, nestedIndex: 1 }),
					event(1400, 0, { type: "sliderTick", hit: true, nestedIndex: 2 }),
					event(1964, 0, { type: "sliderTail", hit: true, nestedIndex: 3 }),
					event(2000, 0, { type: "sliderAggregate", grade: "ok" }),
					event(2000, 0, { type: "sliderEnd", complete: true })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].tickDrops).toEqual([1250]);
		expect(d.drops).toEqual({ heads: 0, repeats: 0, ticks: 1, tails: 0 });
		// and the severity tick reads the drop off the same list
		expect(d.severityTicks).toEqual([{ time: 2000, grade: "ok", objectIndex: 0, drop: true }]);
	});

	test("a dropped repeat and tail that name their element flip exactly that mark", () => {
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 3000, [
						nested("head", 1000),
						nested("repeat", 1666, 0),
						nested("repeat", 2333, 1),
						nested("tail", 3000)
					])
				],
				[
					event(1010, 0, { type: "sliderHead", grade: "great" }),
					event(1666, 0, { type: "sliderRepeat", hit: true, repeatIndex: 0, nestedIndex: 1 }),
					event(2333, 0, { type: "sliderRepeat", hit: false, repeatIndex: 1, nestedIndex: 2 }),
					event(2964, 0, { type: "sliderTail", hit: false, nestedIndex: 3 }),
					event(3000, 0, { type: "sliderAggregate", grade: "ok" }),
					event(3000, 0, { type: "sliderEnd", complete: true })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].nestedMarks).toEqual([
			{ time: 1000, dropped: false },
			{ time: 1666, dropped: false },
			{ time: 2333, dropped: true },
			{ time: 3000, dropped: true }
		]);
	});

	test("tickDrops stay ascending even when the event stream arrives out of order", () => {
		// the simulation emits in time order, so this stream is synthetic --
		// it pins that ascending is this derivation's own guarantee rather
		// than a property borrowed from the input
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 2000, [
						nested("head", 1000),
						nested("tick", 1250),
						nested("tick", 1750),
						nested("tail", 2000)
					])
				],
				[
					event(1751, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					event(1252, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					event(2000, 0, { type: "sliderAggregate", grade: "meh" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].tickDrops).toEqual([1252, 1751]);
	});

	test("a great aggregate applies no drop state, whatever the element events claim", () => {
		const d = deriveScene(
			laneScene(
				[slider(1000, 2000, [nested("head", 1000), nested("tick", 1500), nested("tail", 2000)])],
				[
					event(1010, 0, { type: "sliderHead", grade: "great" }),
					event(1500, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					event(1964, 0, { type: "sliderTail", hit: false, nestedIndex: null }),
					event(2000, 0, { type: "sliderAggregate", grade: "great" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].nestedMarks.every((mark) => !mark.dropped)).toBe(true);
		expect(d.objectLane[0].tickDrops).toEqual([]);
	});

	test("a fully-missed slider gets no per-element marks -- the partially-hit exception", () => {
		const d = deriveScene(
			laneScene(
				[slider(1000, 2000, [nested("head", 1000), nested("tick", 1500), nested("tail", 2000)])],
				[
					event(1150, 0, { type: "sliderHead", grade: "miss" }),
					event(1500, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					event(1964, 0, { type: "sliderTail", hit: false, nestedIndex: null }),
					event(2000, 0, { type: "sliderAggregate", grade: "miss" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.objectLane[0].nestedMarks.every((mark) => !mark.dropped)).toBe(true);
		expect(d.objectLane[0].tickDrops).toEqual([]);
	});
});

describe("dropSummary", () => {
	const object = slider(1000, 2000, [
		nested("head", 1000),
		nested("tick", 1250),
		nested("tick", 1500),
		nested("repeat", 1600, 0),
		nested("repeat", 1800, 1),
		nested("tail", 2000)
	]);
	// marked order after the tick exclusion: head, repeat 0, repeat 1, tail
	function entryWith(
		dropped: [boolean, boolean, boolean, boolean],
		tickDrops: number[] = [],
		grade: Grade = "ok"
	): ObjectLaneEntry {
		return {
			grade,
			tether: null,
			nestedMarks: [
				{ time: 1000, dropped: dropped[0] },
				{ time: 1600, dropped: dropped[1] },
				{ time: 1800, dropped: dropped[2] },
				{ time: 2000, dropped: dropped[3] }
			],
			tickDrops
		};
	}

	test("names a single dropped element bare", () => {
		expect(dropSummary(object, entryWith([false, false, false, true]))).toBe("dropped tail");
		expect(dropSummary(object, entryWith([true, false, false, false]))).toBe("dropped head");
		expect(dropSummary(object, entryWith([false, true, false, false]))).toBe("dropped repeat");
		expect(dropSummary(object, entryWith([false, false, false, false], [1252]))).toBe("dropped tick");
	});

	test("counts and pluralises multiples, joined head-to-tail", () => {
		expect(dropSummary(object, entryWith([false, false, false, true], [1252, 1502]))).toBe(
			"dropped 2 ticks + tail"
		);
		expect(dropSummary(object, entryWith([true, false, false, false], [1252, 1502]))).toBe(
			"dropped head + 2 ticks"
		);
		expect(dropSummary(object, entryWith([false, true, true, false]))).toBe("dropped 2 repeats");
		expect(dropSummary(object, entryWith([true, true, true, true], [1252]))).toBe(
			"dropped head + 2 repeats + tick + tail"
		);
	});

	test("answers null where no cause segment belongs", () => {
		// a slider with no recorded drops, whatever its grade, and a non-slider
		expect(dropSummary(object, entryWith([false, false, false, false]))).toBeNull();
		expect(dropSummary(object, entryWith([false, false, false, false], [], "great"))).toBeNull();
		expect(dropSummary(object, entryWith([false, false, false, false], [], "miss"))).toBeNull();
		expect(dropSummary(circle(1000), { grade: "ok", tether: null, nestedMarks: [], tickDrops: [] })).toBeNull();
	});

	test("a recorded drop is named whatever the grade: the native profile drops elements under a great head", () => {
		// under the stable profile no mark is ever applied outside ok/meh, so
		// these states arise only under the native profile, where lazer
		// judged the element and the readout must say so
		expect(dropSummary(object, entryWith([false, false, false, true], [], "great"))).toBe("dropped tail");
		expect(dropSummary(object, entryWith([false, false, false, true], [], "miss"))).toBe("dropped tail");
	});
});

describe("deriveScene drop totals", () => {
	test("sums the lane's recorded drops by kind across every slider", () => {
		const d = deriveScene(
			laneScene(
				[
					slider(1000, 1500, [nested("head", 1000), nested("tick", 1250), nested("tail", 1500)]),
					slider(2000, 2500, [nested("head", 2000), nested("repeat", 2250), nested("tail", 2500)]),
					slider(3000, 3500, [nested("head", 3000), nested("tail", 3500)])
				],
				[
					event(1100, 0, { type: "sliderHead", grade: "miss" }),
					event(1250, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					event(1464, 0, { type: "sliderTail", hit: true, nestedIndex: null }),
					event(1500, 0, { type: "sliderAggregate", grade: "meh" }),
					event(2010, 1, { type: "sliderHead", grade: "great" }),
					event(2250, 1, { type: "sliderRepeat", hit: false, repeatIndex: 0, nestedIndex: null }),
					event(2464, 1, { type: "sliderTail", hit: false, nestedIndex: null }),
					event(2500, 1, { type: "sliderAggregate", grade: "meh" }),
					event(3010, 2, { type: "sliderHead", grade: "great" }),
					event(3464, 2, { type: "sliderTail", hit: false, nestedIndex: null }),
					event(3500, 2, { type: "sliderAggregate", grade: "ok" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.drops).toEqual({ heads: 1, repeats: 1, ticks: 1, tails: 2 });
	});

	test("a fully missed slider's elements are not recorded, so they are not counted", () => {
		const d = deriveScene(
			laneScene(
				[slider(1000, 1500, [nested("head", 1000), nested("tick", 1250), nested("tail", 1500)])],
				[
					event(1400, 0, { type: "sliderHead", grade: "miss" }),
					event(1250, 0, { type: "sliderTick", hit: false, nestedIndex: null }),
					event(1464, 0, { type: "sliderTail", hit: false, nestedIndex: null }),
					event(1500, 0, { type: "sliderAggregate", grade: "miss" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.drops).toEqual({ heads: 0, repeats: 0, ticks: 0, tails: 0 });
	});

	test("an unsimulated scene counts nothing", () => {
		const d = deriveScene(
			testScene({ simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } } })
		);
		expect(d.drops).toEqual({ heads: 0, repeats: 0, ticks: 0, tails: 0 });
	});
});

describe("describeDrops", () => {
	test("lists the kinds head-to-tail, pluralising counts above one", () => {
		expect(describeDrops({ heads: 0, repeats: 0, ticks: 1, tails: 3 })).toBe("tick + 3 tails");
		expect(describeDrops({ heads: 2, repeats: 1, ticks: 0, tails: 0 })).toBe("2 heads + repeat");
		expect(describeDrops({ heads: 1, repeats: 2, ticks: 1, tails: 1 })).toBe("head + 2 repeats + tick + tail");
	});

	test("answers null when nothing dropped", () => {
		expect(describeDrops({ heads: 0, repeats: 0, ticks: 0, tails: 0 })).toBeNull();
	});
});

describe("deriveScene replay stats", () => {
	test("simulated totals are primary, with the header value riding along as the reference", () => {
		// the default scene's header says 1×300 (SS) while its simulation says
		// 1×100 -- exactly the drift an edit produces
		const { stats } = deriveScene(testScene());
		expect(stats.simulated).toBe(true);
		expect(stats.count300).toEqual({ value: 0, header: 1 });
		expect(stats.count100).toEqual({ value: 1, header: 0 });
		expect(stats.count50).toEqual({ value: 0, header: 0 });
		expect(stats.countMiss).toEqual({ value: 0, header: 0 });
		expect(stats.accuracy.value).toBeCloseTo(1 / 3, 9);
		expect(stats.accuracy.header).toBe(1);
		expect(stats.grade).toEqual({ value: "D", header: "SS" });
		expect(stats.maxCombo).toEqual({ value: 1, header: 1 });
	});

	test("without simulated totals every row falls back to the header value", () => {
		const { stats } = deriveScene(
			testScene({ simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } } })
		);
		expect(stats.simulated).toBe(false);
		expect(stats.count300).toEqual({ value: 1, header: 1 });
		expect(stats.count100).toEqual({ value: 0, header: 0 });
		expect(stats.countMiss).toEqual({ value: 0, header: 0 });
		expect(stats.accuracy).toEqual({ value: 1, header: 1 });
		expect(stats.grade).toEqual({ value: "SS", header: "SS" });
		expect(stats.maxCombo).toEqual({ value: 1, header: 1 });
	});

	test("a native play's accuracy reference is the block's own, never the legacy projection", () => {
		// the "was" line pairs an accuracy with a rank, and both halves must come
		// from the SAME record. the block folds to 1 (one great of one possible)
		// while this header's four counts say something else, so reading the
		// header here would light the drift line on load for a file nothing has
		// edited -- and pair a legacy-rule accuracy with the block's rank
		const { stats } = deriveScene(nativeTestScene());
		expect(stats.accuracy.header).toBe(1);
		expect(stats.grade.header).toBe("SS");

		// and when the block states no accuracy, the header is the only reference
		// left, which is a fallback rather than a claim
		const scene = nativeTestScene();
		if (scene.replay.scoreInfo.status !== "present") throw new Error("present");
		const silent = deriveScene({
			...scene,
			replay: { ...scene.replay, scoreInfo: { ...scene.replay.scoreInfo, accuracy: null } }
		});
		expect(silent.stats.accuracy.header).toBe(scene.replay.accuracy);
	});

	test("the score follows the curve, with the header riding along as the reference", () => {
		// the shared fixture's header says 300 while its one-judgement curve
		// ends at 100 -- exactly the drift an edit produces, and the same shape
		// max combo above already reads
		const { stats } = deriveScene(testScene());
		expect(stats.totalScore).toEqual({ value: 100, header: 300 });
	});

	test("a play that scored nothing reads 0 rather than falling back to the header", () => {
		const base = testScene().simulation;
		if (base.status !== "authoritative") throw new Error("the shared fixture simulates");
		const { stats } = deriveScene(testScene({ simulation: { ...base, scoreCurve: [] } }));
		expect(stats.totalScore).toEqual({ value: 0, header: 300 });
	});

	test("a curve that could not be folded falls back to the header, unlike an empty one", () => {
		// the two states an empty array would otherwise collapse together: a
		// play that scored nothing is a truthful 0, a withheld fold knows
		// nothing and must not claim one (scene-types' ScoreCurve)
		const base = testScene().simulation;
		if (base.status !== "authoritative") throw new Error("the shared fixture simulates");
		const { stats } = deriveScene(testScene({ simulation: { ...base, scoreCurve: null } }));
		expect(stats.totalScore).toEqual({ value: 300, header: 300 });
	});

	test("without a simulation the score falls back to the header, as every other row does", () => {
		const { stats } = deriveScene(
			testScene({ simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } } })
		);
		expect(stats.totalScore).toEqual({ value: 300, header: 300 });
	});

	test("geki and katu have no simulation to follow and stay header-valued", () => {
		const { stats } = deriveScene(testScene());
		expect(stats.countGeki).toBe(0);
		expect(stats.countKatsu).toBe(0);
	});

	test("accuracy and grade are read off the wire, never recomputed from the counts", () => {
		// the header claims 97x300 with 3 misses, and the engine answered the
		// accuracy and the miss-demoted A for it; the counts alone are not
		// consulted, which is what lets the native profile answer otherwise
		const scene = testScene();
		const { stats } = deriveScene(
			testScene({
				replay: { ...scene.replay, count300: 97, countMiss: 3, accuracy: 0.97, rank: "a" },
				simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } }
			})
		);
		expect(stats.accuracy.value).toBeCloseTo(0.97, 9);
		expect(stats.grade.value).toBe("A");
	});

	test("with no timeline the accuracy and grade read one record, so an unedited lazer play shows no drift", () => {
		// a lazer file the app will not simulate (mods) still carries its
		// block, and the block is the record BOTH sides read there. reading
		// the header's legacy projection as the value would pair it with the
		// block as its own reference and drift a play nothing has touched --
		// and since rank_from_accuracy has no `f` arm, it would lead a failed
		// play with an A and hide the block's F in the "was" line
		const scene = nativeTestScene();
		if (scene.replay.scoreInfo.status !== "present") throw new Error("the native fixture carries a block");
		const unsimulated = nativeTestScene({
			replay: {
				...scene.replay,
				accuracy: 1,
				rank: "x",
				scoreInfo: { ...scene.replay.scoreInfo, accuracy: 0.8123, rank: "f" }
			},
			simulation: { status: "notSimulated", reason: { kind: "unsupportedMods", acronyms: ["HD"] } }
		});
		const { stats } = deriveScene(unsimulated);
		expect(stats.accuracy.value).toBeCloseTo(0.8123, 9);
		expect(stats.accuracy.value).toBe(stats.accuracy.header);
		expect(stats.grade.value).toBe("F");
		expect(stats.grade.value).toBe(stats.grade.header);
	});

	test("the wire's lazer rank vocabulary spells as the app's letters", () => {
		expect(displayRank("x")).toBe("SS");
		expect(displayRank("xh")).toBe("SS");
		expect(displayRank("sh")).toBe("S");
		expect(displayRank("s")).toBe("S");
		expect(displayRank("d")).toBe("D");
		expect(displayRank("f")).toBe("F");
	});
});

describe("deriveScene analysis", () => {
	test("carries the per-scene analysis alongside the existing derived data", () => {
		const scene = testScene({
			frames: [
				{ time: 0, x: 0, y: 0, buttons: 0 },
				{ time: 16, x: 16, y: 0, buttons: 0 },
				{ time: 32, x: 32, y: 0, buttons: 0 }
			]
		});
		const derived = deriveScene(scene);
		expect(derived.analysis.frameCount).toBe(3);
		expect(derived.analysis.velocity.length).toBeGreaterThan(0);
	});
});

describe("an approximate simulation derives exactly as an authoritative one", () => {
	test("lane, ticks, hp, combo changes and stats read the approximate timeline", () => {
		const authoritative = deriveScene(testScene());
		const approximate = deriveScene(approximateNativeTestScene());
		expect(approximate.objectLane).toEqual(authoritative.objectLane);
		expect(approximate.severityTicks).toEqual(authoritative.severityTicks);
		expect(approximate.judgementsByObject).toEqual(authoritative.judgementsByObject);
		expect(approximate.hp).toEqual(authoritative.hp);
		expect(approximate.comboChanges).toEqual(authoritative.comboChanges);
		expect(approximate.analysis.errors).toEqual(authoritative.analysis.errors);
		expect(approximate.stats.simulated).toBe(true);
		expect(approximate.stats.count100).toEqual(authoritative.stats.count100);
		expect(approximate.stats.totalScore).toEqual(authoritative.stats.totalScore);
	});
});

describe("native judgement-derived surfaces", () => {
	// a lane scene judged under the native profile: no aggregate, the head's
	// timing grade and the elements' own results say everything
	function nativeLane(objects: RenderObject[], events: JudgementEventDto[], frames: LoadedScene["frames"]) {
		return { ...laneScene(objects, events, frames), configuration: nativeTestScene().configuration };
	}
	const tracked = () => slider(1000, 1500, [nested("head", 1000), nested("tick", 1250), nested("tail", 1500)]);
	const press = [
		{ time: 0, x: 0, y: 0, buttons: 0 },
		{ time: 1010, x: 0, y: 0, buttons: 1 },
		{ time: 1600, x: 0, y: 0, buttons: 0 }
	];

	test("an ok head with every element hit is one timing mark, never a drop", () => {
		const d = deriveScene(
			nativeLane(
				[tracked()],
				[
					event(1010, 0, { type: "sliderHead", grade: "ok" }),
					event(1250, 0, { type: "sliderTick", hit: true, nestedIndex: 1 }),
					event(1464, 0, { type: "sliderTail", hit: true, nestedIndex: 2 }),
					event(1500, 0, { type: "sliderEnd", complete: true })
				],
				press
			)
		);
		expect(d.objectLane[0].grade).toBe("ok");
		expect(d.severityTicks).toEqual([{ time: 1010, grade: "ok", objectIndex: 0, drop: false }]);
		expect(d.objectLane[0].nestedMarks.every((m) => !m.dropped)).toBe(true);
		expect(d.objectLane[0].tickDrops).toEqual([]);
		expect(d.severityTargets.ok).toEqual([{ objectIndex: 0, landingTime: 1000, grade: "ok" }]);
		// the tether points at the press that judged the head, so the head's
		// error enters the unstable rate as lazer's does
		expect(d.objectLane[0].tether).toEqual({ fromTime: 1000, toTime: 1010, key: "M1", pressFrameIndex: 1 });
	});

	test("a great head with a dropped tick is one drop mark at the element's own time", () => {
		const d = deriveScene(
			nativeLane(
				[tracked()],
				[
					event(1000, 0, { type: "sliderHead", grade: "great" }),
					event(1250, 0, { type: "sliderTick", hit: false, nestedIndex: 1 }),
					event(1464, 0, { type: "sliderTail", hit: true, nestedIndex: 2 }),
					event(1500, 0, { type: "sliderEnd", complete: true })
				],
				press
			)
		);
		expect(d.objectLane[0].grade).toBe("great");
		expect(d.objectLane[0].tickDrops).toEqual([1250]);
		expect(d.severityTicks).toEqual([{ time: 1250, grade: "miss", objectIndex: 0, drop: true }]);
		expect(d.severityTargets.miss).toEqual([{ objectIndex: 0, landingTime: 1000, grade: "miss" }]);
		expect(dropSummary(tracked(), d.objectLane[0])).toBe("dropped tick");
	});

	test("an ok head with a dropped tail is two marks, and the jump covers both without wrapping", () => {
		const d = deriveScene(
			nativeLane(
				[tracked()],
				[
					event(1010, 0, { type: "sliderHead", grade: "ok" }),
					event(1250, 0, { type: "sliderTick", hit: true, nestedIndex: 1 }),
					event(1500, 0, { type: "sliderTail", hit: false, nestedIndex: 2 }),
					event(1500, 0, { type: "sliderEnd", complete: true })
				],
				press
			)
		);
		expect(d.severityTicks).toEqual([
			{ time: 1010, grade: "ok", objectIndex: 0, drop: false },
			{ time: 1500, grade: "meh", objectIndex: 0, drop: true }
		]);
		expect(d.objectLane[0].nestedMarks).toEqual([
			{ time: 1000, dropped: false },
			{ time: 1500, dropped: true }
		]);
		expect(d.severityTargets.ok).toHaveLength(1);
		expect(d.severityTargets.meh).toHaveLength(1);
		const first = severityJump(d.severityTargets, "meh", 1, 0);
		expect(first.target?.landingTime).toBe(1000);
		expect(severityJump(d.severityTargets, "meh", 1, 1000).target).toBeNull();
	});

	test("a missed native head is one timing mark, never doubled as a drop of its own", () => {
		const d = deriveScene(
			nativeLane(
				[tracked()],
				[
					event(1150, 0, { type: "sliderHead", grade: "miss" }),
					event(1250, 0, { type: "sliderTick", hit: true, nestedIndex: 1 }),
					event(1464, 0, { type: "sliderTail", hit: true, nestedIndex: 2 }),
					event(1500, 0, { type: "sliderEnd", complete: true })
				],
				press
			)
		);
		expect(d.severityTicks).toEqual([{ time: 1150, grade: "miss", objectIndex: 0, drop: false }]);
		expect(d.severityTargets.miss).toHaveLength(1);
		expect(d.objectLane[0].nestedMarks[0]).toEqual({ time: 1000, dropped: true });
		expect(d.objectLane[0].tether).toBeNull();
	});

	test("a stable slider's aggregate still grades it, whatever its head says", () => {
		const d = deriveScene(
			laneScene(
				[tracked()],
				[
					event(1010, 0, { type: "sliderHead", grade: "great" }),
					event(1250, 0, { type: "sliderTick", hit: false, nestedIndex: 1 }),
					event(1464, 0, { type: "sliderTail", hit: true, nestedIndex: 2 }),
					event(1500, 0, { type: "sliderAggregate", grade: "ok" }),
					event(1500, 0, { type: "sliderEnd", complete: true })
				],
				press
			)
		);
		expect(d.objectLane[0].grade).toBe("ok");
		expect(d.severityTicks).toEqual([{ time: 1500, grade: "ok", objectIndex: 0, drop: true }]);
	});

	test("the rank tile's frozen reference is the block's own rank on a lazer file", () => {
		const scene = nativeTestScene();
		if (scene.replay.scoreInfo.status !== "present") throw new Error("the native fixture carries a block");
		const failed = nativeTestScene({
			replay: { ...scene.replay, scoreInfo: { ...scene.replay.scoreInfo, rank: "f" } }
		});
		expect(deriveScene(failed).stats.grade.header).toBe("F");
		expect(deriveScene(scene).stats.grade.header).toBe("SS");
		expect(deriveScene(testScene()).stats.grade.header).toBe(displayRank(testScene().replay.rank));
	});
});
