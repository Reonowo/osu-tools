import { describe, expect, test } from "bun:test";
import { testScene } from "../test/scene";
import { deriveScene } from "./derive";

describe("deriveScene", () => {
	test("bounds cover lead-in, frames, preempt, and fade-out tails", () => {
		const d = deriveScene(testScene());
		// min(0, -leadIn, firstFrame, firstAppear = 1000 - 600)
		expect(d.bounds.minTime).toBe(-1500);
		// max(lastFrame, lastEnd + 800)
		expect(d.bounds.maxTime).toBe(1800);
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

	test("judgements group by object and markers keep non-great grades", () => {
		const d = deriveScene(testScene());
		expect(d.judgementsByObject[0]).toHaveLength(1);
		expect(d.timelineMarkers).toEqual([{ time: 980, grade: "ok" }]);
	});

	test("notSimulated scenes derive empty judgement data", () => {
		const d = deriveScene(testScene({ simulation: { status: "notSimulated", reason: "unsupportedMods" } }));
		expect(d.judgementsByObject[0]).toEqual([]);
		expect(d.timelineMarkers).toEqual([]);
		expect(d.presses).toHaveLength(1); // analysis data still derives
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
