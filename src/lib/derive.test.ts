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
