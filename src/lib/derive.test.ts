import { describe, expect, test } from "bun:test";
import { testScene } from "../test/scene";
import type { JudgementEventDto, LoadedScene, RenderNested, RenderObject } from "./scene-types";
import { deriveScene } from "./derive";

describe("deriveScene", () => {
	test("bounds cover lead-in, frames, preempt, and fade-out tails", () => {
		const d = deriveScene(testScene());
		// min(0, -leadIn, firstFrame, firstAppear = 1000 - 600)
		expect(d.bounds.minTime).toBe(-1500);
		// max(lastFrame, lastEnd + 800)
		expect(d.bounds.maxTime).toBe(1800);
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
					events: [
						{
							time: 1400,
							objectIndex: 0,
							kind: { type: "circle", grade: "miss" },
							comboAfter: 0,
							accuracyAfter: 0
						}
					],
					totals: { count300: 0, count100: 0, count50: 0, countMiss: 1, maxCombo: 0 }
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
					events: [
						{
							time: 1180,
							objectIndex: 0,
							kind: { type: "circle", grade: "meh" },
							comboAfter: 1,
							accuracyAfter: 50 / 300
						}
					],
					totals: { count300: 0, count100: 0, count50: 1, countMiss: 0, maxCombo: 1 }
				}
			})
		);
		expect(d.bounds.maxTime).toBe(1980);
	});

	test("judgements group by object and severity ticks keep non-great grades", () => {
		const d = deriveScene(testScene());
		expect(d.judgementsByObject[0]).toHaveLength(1);
		expect(d.severityTicks).toEqual([{ time: 980, grade: "ok", objectIndex: 0 }]);
	});

	test("notSimulated scenes derive empty judgement data", () => {
		const d = deriveScene(testScene({ simulation: { status: "notSimulated", reason: "unsupportedMods" } }));
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

function nested(kind: RenderNested["kind"], time: number): RenderNested {
	return { kind, spanIndex: 0, time, position: [0, 0], pathProgress: 0, preempt: 600, fadeIn: 400, samples: [] };
}

function slider(startTime: number, endTime: number, nestedParts: RenderNested[]): RenderObject {
	return {
		...circle(startTime),
		endTime,
		kind: {
			type: "slider",
			vertices: [0, 0, 10, 0],
			cumulativeLengths: [0, 10],
			distance: 10,
			segmentEnds: [1],
			repeatCount: 0,
			spanCount: 1,
			spanDuration: endTime - startTime,
			duration: endTime - startTime,
			endPosition: [10, 0],
			snakeInDuration: 100,
			nested: nestedParts
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
			events,
			totals: { count300: 0, count100: 0, count50: 0, countMiss: 0, maxCombo: 0 }
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
					event(1012, 0, { type: "sliderHead", hit: true }),
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
					event(1150, 0, { type: "sliderHead", hit: false }),
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
		expect(d.objectLane[0].nestedMarks).toEqual([1000, 1500, 2000]);
	});

	test("circles and spinners carry no nested marks", () => {
		const d = deriveScene(
			laneScene([circle(1000), spinner(1500, 2500)], [], [{ time: 0, x: 0, y: 0, buttons: 0 }])
		);
		expect(d.objectLane[0].nestedMarks).toEqual([]);
		expect(d.objectLane[1].nestedMarks).toEqual([]);
	});

	test("a notSimulated scene derives objects with null grades and no tethers", () => {
		const base = testScene();
		const d = deriveScene(
			testScene({
				renderPlan: { ...base.renderPlan, objects: [circle(1000), spinner(1500, 2500)] },
				simulation: { status: "notSimulated", reason: "unsupportedMods" }
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
					event(2500, 1, { type: "sliderAggregate", grade: "ok" }),
					event(4000, 2, { type: "spinnerFinal", grade: "miss" }),
					event(5000, 3, { type: "circle", grade: "great" })
				],
				[{ time: 0, x: 0, y: 0, buttons: 0 }]
			)
		);
		expect(d.severityTicks).toEqual([
			{ time: 1005, grade: "meh", objectIndex: 0 },
			{ time: 2500, grade: "ok", objectIndex: 1 },
			{ time: 4000, grade: "miss", objectIndex: 2 }
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
					event(3020, 2, { type: "sliderHead", hit: true }),
					event(3500, 2, { type: "sliderAggregate", grade: "great" }),
					event(4150, 3, { type: "sliderHead", hit: false }),
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
		const { stats } = deriveScene(testScene({ simulation: { status: "notSimulated", reason: "unsupportedMods" } }));
		expect(stats.simulated).toBe(false);
		expect(stats.count300).toEqual({ value: 1, header: 1 });
		expect(stats.count100).toEqual({ value: 0, header: 0 });
		expect(stats.countMiss).toEqual({ value: 0, header: 0 });
		expect(stats.accuracy).toEqual({ value: 1, header: 1 });
		expect(stats.grade).toEqual({ value: "SS", header: "SS" });
		expect(stats.maxCombo).toEqual({ value: 1, header: 1 });
	});

	test("score and geki/katu are never simulated and stay header-valued", () => {
		const { stats } = deriveScene(testScene());
		expect(stats.totalScore).toBe(300);
		expect(stats.countGeki).toBe(0);
		expect(stats.countKatsu).toBe(0);
	});

	test("a miss always costs at least S, whatever the count-share accuracy says", () => {
		const scene = testScene();
		const { stats } = deriveScene(
			testScene({
				replay: { ...scene.replay, count300: 97, countMiss: 3 },
				simulation: { status: "notSimulated", reason: "unsupportedMods" }
			})
		);
		// 97×300 over 100 judged = 0.97, which clears the 0.95 S threshold --
		// the misses still demote to A
		expect(stats.accuracy.value).toBeCloseTo(0.97, 9);
		expect(stats.grade.value).toBe("A");
	});

	test("zero judged hits read as zero accuracy, not NaN", () => {
		const scene = testScene();
		const { stats } = deriveScene(
			testScene({
				replay: { ...scene.replay, count300: 0, maxCombo: 0 },
				simulation: { status: "notSimulated", reason: "unsupportedMods" }
			})
		);
		expect(stats.accuracy.value).toBe(0);
		expect(stats.grade.value).toBe("D");
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
