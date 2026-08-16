import { describe, expect, test } from "bun:test";
import { fromHex } from "../../engine/color";
import { trackValueAt } from "../../engine/transforms";
import { testScene } from "../../test/scene";
import {
	argonProJudgementPiece,
	GRADE_COLOURS,
	judgementSpecs,
	resultTracks,
	ringExplosion,
	tickMissTracks
} from "./judgement-tracks";

describe("judgement specs", () => {
	test("authoritative circle events pop at the object position", () => {
		const specs = judgementSpecs(testScene());
		expect(specs).toHaveLength(1);
		expect(specs[0]).toMatchObject({ x: 100, y: 100, grade: "ok", time: 980, style: "text" });
	});

	test("not-simulated scenes produce nothing", () => {
		const scene = testScene({ simulation: { status: "notSimulated", reason: "unsupportedMods" } });
		expect(judgementSpecs(scene)).toHaveLength(0);
	});

	test("slider aggregates pop at the tail; tick misses at the tick; tick hits nothing", () => {
		const base = testScene();
		const scene = testScene({
			renderPlan: {
				...base.renderPlan,
				objects: [
					{
						...base.renderPlan.objects[0],
						endTime: 1500,
						kind: {
							type: "slider",
							vertices: [0, 0, 100, 0],
							cumulativeLengths: [0, 100],
							distance: 100,
							segmentEnds: [1],
							repeatCount: 0,
							spanCount: 1,
							spanDuration: 500,
							duration: 500,
							endPosition: [200, 100],
							snakeInDuration: 200,
							nested: [
								{
									kind: "head",
									spanIndex: 0,
									time: 1000,
									position: [100, 100],
									pathProgress: 0,
									preempt: 600,
									fadeIn: 400,
									samples: []
								},
								{
									kind: "tick",
									spanIndex: 0,
									time: 1250,
									position: [150, 100],
									pathProgress: 0.5,
									preempt: 500,
									fadeIn: 150,
									samples: []
								},
								{
									kind: "tail",
									spanIndex: 0,
									time: 1500,
									position: [200, 100],
									pathProgress: 1,
									preempt: 600,
									fadeIn: 400,
									samples: []
								}
							]
						}
					}
				]
			},
			simulation: {
				status: "authoritative",
				events: [
					{
						time: 1000,
						objectIndex: 0,
						kind: { type: "sliderHead", hit: true },
						comboAfter: 1,
						accuracyAfter: 1
					},
					{
						time: 1250,
						objectIndex: 0,
						kind: { type: "sliderTick", hit: false },
						comboAfter: 0,
						accuracyAfter: 1
					},
					{
						time: 1500,
						objectIndex: 0,
						kind: { type: "sliderTail", hit: true },
						comboAfter: 1,
						accuracyAfter: 1
					},
					{
						time: 1500,
						objectIndex: 0,
						kind: { type: "sliderAggregate", grade: "ok" },
						comboAfter: 1,
						accuracyAfter: 0.9
					}
				],
				totals: { count300: 0, count100: 1, count50: 0, countMiss: 0, maxCombo: 1 }
			}
		});
		const specs = judgementSpecs(scene);
		expect(specs).toHaveLength(2);
		const tickMiss = specs.find((s) => s.style === "tickMiss")!;
		expect([tickMiss.x, tickMiss.y]).toEqual([150, 100]);
		const aggregate = specs.find((s) => s.style === "text")!;
		expect([aggregate.x, aggregate.y]).toEqual([200, 100]);
		expect(aggregate.grade).toBe("ok");
	});

	test("hit slider ticks/repeats produce nothing even when nested data matches", () => {
		const base = testScene();
		const scene = testScene({
			renderPlan: {
				...base.renderPlan,
				objects: [
					{
						...base.renderPlan.objects[0],
						endTime: 1500,
						kind: {
							type: "slider",
							vertices: [0, 0, 100, 0],
							cumulativeLengths: [0, 100],
							distance: 100,
							segmentEnds: [1],
							repeatCount: 0,
							spanCount: 1,
							spanDuration: 500,
							duration: 500,
							endPosition: [200, 100],
							snakeInDuration: 200,
							nested: [
								{
									kind: "tick",
									spanIndex: 0,
									time: 1250,
									position: [150, 100],
									pathProgress: 0.5,
									preempt: 500,
									fadeIn: 150,
									samples: []
								}
							]
						}
					}
				]
			},
			simulation: {
				status: "authoritative",
				events: [
					{
						time: 1250,
						objectIndex: 0,
						kind: { type: "sliderTick", hit: true },
						comboAfter: 1,
						accuracyAfter: 1
					}
				],
				totals: { count300: 0, count100: 0, count50: 0, countMiss: 0, maxCombo: 1 }
			}
		});
		expect(judgementSpecs(scene)).toHaveLength(0);
	});

	test("spinner finals pop at the playfield centre", () => {
		const scene = testScene({
			simulation: {
				status: "authoritative",
				events: [
					{
						time: 980,
						objectIndex: 0,
						kind: { type: "spinnerFinal", grade: "meh" },
						comboAfter: 1,
						accuracyAfter: 1
					}
				],
				totals: { count300: 0, count100: 0, count50: 1, countMiss: 0, maxCombo: 1 }
			}
		});
		const specs = judgementSpecs(scene);
		expect(specs).toHaveLength(1);
		expect(specs[0]).toMatchObject({ x: 256, y: 192, grade: "meh", style: "text" });
	});

	// the point of these two is the MECHANISM, not the outcome: nothing here
	// keys on "greats are noisy", it keys on argonpro answering Drawable.Empty()
	test("a great draws nothing because the skin answers empty, while every other grade still draws", () => {
		const gradeSpecs = (grade: "great" | "ok" | "meh" | "miss") =>
			judgementSpecs(
				testScene({
					simulation: {
						status: "authoritative",
						events: [
							{
								time: 980,
								objectIndex: 0,
								kind: { type: "circle", grade },
								comboAfter: 1,
								accuracyAfter: 1
							}
						],
						totals: { count300: 0, count100: 0, count50: 0, countMiss: 0, maxCombo: 1 }
					}
				})
			);
		expect(gradeSpecs("great")).toHaveLength(0);
		for (const grade of ["ok", "meh", "miss"] as const) {
			expect(gradeSpecs(grade)).toEqual([expect.objectContaining({ grade, style: "text", time: 980 })]);
		}
	});

	test("the skin's three-valued answer keeps empty and no-answer distinct", () => {
		// an empty answer is a decision the skin made; a `none` is a decline
		// that a later source in the chain would answer instead. a chain that
		// collapsed them would resurrect the very piece the skin removed
		expect(argonProJudgementPiece("great")).toEqual({ answer: "empty" });
		expect(argonProJudgementPiece("largeTickHit")).toEqual({ answer: "none" });
		expect(argonProJudgementPiece("largeTickMiss")).toEqual({ answer: "piece", style: "tickMiss" });
		expect(argonProJudgementPiece("miss")).toEqual({ answer: "piece", style: "text" });
	});

	test("seed is the event's index into simulation.events, not the object index", () => {
		const scene = testScene({
			simulation: {
				status: "authoritative",
				events: [
					{ time: 900, objectIndex: 0, kind: { type: "spinnerSpin" }, comboAfter: 0, accuracyAfter: 1 },
					{
						time: 980,
						objectIndex: 0,
						kind: { type: "circle", grade: "meh" },
						comboAfter: 1,
						accuracyAfter: 1
					}
				],
				totals: { count300: 0, count100: 0, count50: 1, countMiss: 0, maxCombo: 1 }
			}
		});
		const specs = judgementSpecs(scene);
		expect(specs).toHaveLength(1);
		expect(specs[0].seed).toBe(1);
	});
});

describe("GRADE_COLOURS", () => {
	// osucolour.cs:325 (Blue), 331 (Yellow), 337 (Green), 464 (Red), read via
	// ForHitResult at osucolour.cs:114-145
	test("matches OsuColour's ForHitResult palette", () => {
		expect(GRADE_COLOURS.great).toEqual(fromHex("66ccff"));
		expect(GRADE_COLOURS.ok).toEqual(fromHex("88b300"));
		expect(GRADE_COLOURS.meh).toEqual(fromHex("ffcc22"));
		expect(GRADE_COLOURS.miss).toEqual(fromHex("ed1121"));
	});
});

describe("ringExplosion", () => {
	test("meh gets 3 small rings travelling 0.3x the base distance", () => {
		const rings = ringExplosion("meh", 0);
		expect(rings).toHaveLength(3);
		for (const ring of rings) {
			expect(ring.size).toBe(9);
			expect(ring.distance).toBeGreaterThanOrEqual((52 * 0.3) / 2);
			expect(ring.distance).toBeLessThanOrEqual(52 * 0.3);
		}
	});

	test("ok gets 4 small rings travelling 0.6x the base distance", () => {
		const rings = ringExplosion("ok", 1);
		expect(rings).toHaveLength(4);
		for (const ring of rings) {
			expect(ring.size).toBe(9);
			expect(ring.distance).toBeGreaterThanOrEqual((52 * 0.6) / 2);
			expect(ring.distance).toBeLessThanOrEqual(52 * 0.6);
		}
	});

	test("great gets 4 small + 4 large rings at full travel, small rings first", () => {
		const rings = ringExplosion("great", 2);
		expect(rings).toHaveLength(8);
		expect(rings.slice(0, 4).every((r) => r.size === 9)).toBe(true);
		expect(rings.slice(4).every((r) => r.size === 14)).toBe(true);
		for (const ring of rings) {
			expect(ring.distance).toBeGreaterThanOrEqual(52 / 2);
			expect(ring.distance).toBeLessThanOrEqual(52);
		}
	});

	test("miss produces no rings (RingExplosion is only built for hit results)", () => {
		expect(ringExplosion("miss", 3)).toHaveLength(0);
	});

	test("is deterministic across repeated calls with the same seed", () => {
		const a = ringExplosion("great", 42);
		const b = ringExplosion("great", 42);
		expect(b).toEqual(a);
	});

	test("is deterministic regardless of call order, so seeking back and forth cannot reshuffle particles", () => {
		const forwardOrder = [ringExplosion("great", 5), ringExplosion("ok", 6), ringExplosion("meh", 7)];
		const seekedOrder = [ringExplosion("meh", 7), ringExplosion("great", 5), ringExplosion("ok", 6)];
		expect(seekedOrder[1]).toEqual(forwardOrder[0]);
		expect(seekedOrder[2]).toEqual(forwardOrder[1]);
		expect(seekedOrder[0]).toEqual(forwardOrder[2]);
	});

	test("different seeds produce different particle layouts", () => {
		const a = ringExplosion("great", 0);
		const b = ringExplosion("great", 1);
		expect(a).not.toEqual(b);
	});

	test("reproduces lazer's degrees-fed-as-radians quirk literally (argonjudgementpiece.cs:153-163)", () => {
		// an independent reference implementation of the same public-domain
		// mulberry32 algorithm decision 7 specifies, used to derive the expected
		// first-ring direction/distance without depending on ringExplosion's
		// own internals
		function referenceMulberry32(seed: number): () => number {
			let a = seed | 0;
			return () => {
				a = (a + 0x6d2b79f5) | 0;
				let t = Math.imul(a ^ (a >>> 15), 1 | a);
				t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
				return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
			};
		}
		const rng = referenceMulberry32(123);
		const travel = 52; // great: no travel scaling
		const direction = rng() * 360; // degrees, fed straight into cos/sin below
		const distance = travel / 2 + rng() * (travel / 2);

		const [first] = ringExplosion("great", 123);
		expect(first.dirX).toBeCloseTo(Math.cos(direction), 10);
		expect(first.dirY).toBeCloseTo(Math.sin(direction), 10);
		expect(first.distance).toBeCloseTo(distance, 10);

		// if the quirk were "fixed" to a proper degrees->radians conversion,
		// dirX/dirY would land somewhere else entirely for this seed
		expect(first.dirX).not.toBeCloseTo(Math.cos((direction * Math.PI) / 180), 5);
		expect(first.dirY).not.toBeCloseTo(Math.sin((direction * Math.PI) / 180), 5);
	});
});

describe("tickMissTracks (argonjudgementpiecesslidertickmiss.cs:41-47)", () => {
	test("scale jumps to 1.4 then eases (Out = OutQuad) to 1 over 150ms", () => {
		const tracks = tickMissTracks({ time: 1000 });
		expect(trackValueAt(tracks.scale, 1000, 1)).toBe(1.4);
		// OutQuad(0.5) = 0.5*(2-0.5) = 0.75 -> 1.4 + (1-1.4)*0.75 = 1.1
		expect(trackValueAt(tracks.scale, 1075, 1)).toBeCloseTo(1.1, 9);
		expect(trackValueAt(tracks.scale, 1150, 1)).toBe(1);
	});

	test("alpha fades 1 -> 0 linearly over 600ms (FadeOutFromOne(600))", () => {
		const tracks = tickMissTracks({ time: 1000 });
		expect(trackValueAt(tracks.alpha, 1000, 0)).toBe(1);
		expect(trackValueAt(tracks.alpha, 1300, 0)).toBeCloseTo(0.5, 9);
		expect(trackValueAt(tracks.alpha, 1600, 0)).toBe(0);
	});
});

describe("resultTracks (argonjudgementpiece.cs:63-97)", () => {
	test("containerAlpha fades 1 -> 0 linearly over 800ms for every grade (FadeOutFromOne(800))", () => {
		for (const grade of ["great", "ok", "meh", "miss"] as const) {
			const tracks = resultTracks({ time: 1000, grade });
			expect(trackValueAt(tracks.containerAlpha, 1000, 0)).toBe(1);
			expect(trackValueAt(tracks.containerAlpha, 1400, 0)).toBeCloseTo(0.5, 9);
			expect(trackValueAt(tracks.containerAlpha, 1800, 0)).toBe(0);
		}
	});

	test("hit grades: text fades in over 300ms OutQuint and scales 1->1.2 over 1800ms OutQuint", () => {
		const tracks = resultTracks({ time: 1000, grade: "great" });
		// OutQuint(0.5) = (0.5-1)^5 + 1 = 0.96875
		expect(trackValueAt(tracks.textAlpha, 1000, 1)).toBe(0);
		expect(trackValueAt(tracks.textAlpha, 1150, 1)).toBeCloseTo(0.96875, 9);
		expect(trackValueAt(tracks.textAlpha, 1300, 1)).toBe(1);
		expect(trackValueAt(tracks.textScale, 1000, 1)).toBe(1);
		expect(trackValueAt(tracks.textScale, 1900, 1)).toBeCloseTo(1 + 0.2 * 0.96875, 9);
		expect(trackValueAt(tracks.textScale, 2800, 1)).toBe(1.2);
		// no miss-only tracks for a hit
		expect(tracks.missScale).toHaveLength(0);
		expect(tracks.missDrop).toHaveLength(0);
		expect(tracks.missRotate).toHaveLength(0);
	});

	test("miss: text is pinned at alpha/scale 1 (no independent text animation)", () => {
		const tracks = resultTracks({ time: 1000, grade: "miss" });
		expect(trackValueAt(tracks.textAlpha, 1000, 0)).toBe(1);
		expect(trackValueAt(tracks.textAlpha, 1900, 0)).toBe(1);
		expect(trackValueAt(tracks.textScale, 1000, 1)).toBe(1);
		expect(trackValueAt(tracks.textScale, 1900, 1)).toBe(1);
	});

	test("miss: scale 1.6->1 over 100ms In (InQuad), drop 0->100 over 800ms InQuint, rotate 0->40 over 800ms InQuint", () => {
		const tracks = resultTracks({ time: 1000, grade: "miss" });
		// InQuad(0.5) = 0.25 -> 1.6 + (1-1.6)*0.25 = 1.45
		expect(trackValueAt(tracks.missScale, 1000, 1)).toBe(1.6);
		expect(trackValueAt(tracks.missScale, 1050, 1)).toBeCloseTo(1.45, 9);
		expect(trackValueAt(tracks.missScale, 1100, 1)).toBe(1);
		// InQuint(0.5) = 0.5^5 = 0.03125
		expect(trackValueAt(tracks.missDrop, 1000, 0)).toBe(0);
		expect(trackValueAt(tracks.missDrop, 1400, 0)).toBeCloseTo(100 * 0.03125, 9);
		expect(trackValueAt(tracks.missDrop, 1800, 0)).toBe(100);
		expect(trackValueAt(tracks.missRotate, 1000, 0)).toBe(0);
		expect(trackValueAt(tracks.missRotate, 1400, 0)).toBeCloseTo(40 * 0.03125, 9);
		expect(trackValueAt(tracks.missRotate, 1800, 0)).toBe(40);
	});

	test("ring tracks: spawn at 0.3 of travel, move out over 600ms OutQuint, fade 1000ms OutQuint -- shared by every grade", () => {
		for (const grade of ["great", "ok", "meh"] as const) {
			const tracks = resultTracks({ time: 1000, grade });
			expect(trackValueAt(tracks.ringMove, 1000, 0)).toBeCloseTo(0.3, 9);
			// OutQuint(0.5) = 0.96875 -> 0.3 + 0.7*0.96875 = 0.978125
			expect(trackValueAt(tracks.ringMove, 1300, 0)).toBeCloseTo(0.978125, 9);
			expect(trackValueAt(tracks.ringMove, 1600, 0)).toBe(1);
			expect(trackValueAt(tracks.ringAlpha, 1000, 0)).toBe(1);
			expect(trackValueAt(tracks.ringAlpha, 1500, 0)).toBeCloseTo(1 - 0.96875, 9);
			expect(trackValueAt(tracks.ringAlpha, 2000, 0)).toBe(0);
		}
	});
});
