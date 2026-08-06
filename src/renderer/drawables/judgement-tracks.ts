// pure state for argon judgement popups: which popups exist (judgementSpecs),
// the deterministic ring-explosion particle geometry (ringExplosion), and the
// per-property animation tracks (tickMissTracks/resultTracks). citations:
// osuargonskintransformer.cs:23-42 (which results get pieces),
// drawableosujudgement.cs:39-71 (positioning), argonjudgementpiece.cs
// (animation), argonjudgementpiecesslidertickmiss.cs (tick miss),
// osucolour.cs:111-145 + 323-465 (colours)

import { fromHex, type Rgba } from "../../engine/color";
import { easeIn, inQuint, out, outQuint } from "../../engine/easing";
import { jump, tween, type Track } from "../../engine/transforms";
import type { Grade, LoadedScene, RenderNested } from "../../lib/scene-types";

/** osucolour.cs:325,331,337,464 -- Blue/Yellow/Green/Red, read via ForHitResult
 * (osucolour.cs:114-145). reused by the timeline (task 20) for marker colours */
export const GRADE_COLOURS: Record<Grade, Rgba> = {
	great: fromHex("66ccff"),
	ok: fromHex("88b300"),
	meh: fromHex("ffcc22"),
	miss: fromHex("ed1121")
};

export interface JudgementSpec {
	time: number;
	x: number;
	y: number;
	grade: Grade;
	style: "text" | "tickMiss";
	seed: number;
}

function nestedAt(nested: RenderNested[], time: number, kind: RenderNested["kind"]): RenderNested | null {
	return nested.find((n) => n.kind === kind && Math.abs(n.time - time) <= 1) ?? null;
}

/** osuargonskintransformer.cs:23-42 -- which hitresults get a popup at all
 * (large tick hits and slider tail hits return null; large tick/ignore misses
 * get the tick-miss piece; everything else gets the text piece).
 * drawableosujudgement.cs:39-71 -- popup position (slider tail for the
 * aggregate, playfield centre for spinners, the object itself otherwise) */
export function judgementSpecs(scene: LoadedScene): JudgementSpec[] {
	if (scene.simulation.status !== "authoritative") return [];
	const specs: JudgementSpec[] = [];
	scene.simulation.events.forEach((event, seed) => {
		const obj = scene.renderPlan.objects[event.objectIndex];
		const kind = event.kind;
		switch (kind.type) {
			case "circle":
				specs.push({
					time: event.time,
					x: obj.position[0],
					y: obj.position[1],
					grade: kind.grade,
					style: "text",
					seed
				});
				break;
			case "sliderAggregate": {
				const [x, y] = obj.kind.type === "slider" ? obj.kind.endPosition : obj.position;
				specs.push({ time: event.time, x, y, grade: kind.grade, style: "text", seed });
				break;
			}
			case "spinnerFinal":
				specs.push({ time: event.time, x: 256, y: 192, grade: kind.grade, style: "text", seed });
				break;
			case "sliderTick":
			case "sliderRepeat": {
				if (kind.hit || obj.kind.type !== "slider") break;
				const nested = nestedAt(obj.kind.nested, event.time, kind.type === "sliderTick" ? "tick" : "repeat");
				if (nested !== null) {
					specs.push({
						time: event.time,
						x: nested.position[0],
						y: nested.position[1],
						grade: "miss",
						style: "tickMiss",
						seed
					});
				}
				break;
			}
			default:
				break;
		}
	});
	return specs;
}

/** deterministic per-popup prng (decision 7): seeded by the event's index in
 * scene.simulation.events, so re-seeking never reshuffles a popup's rings --
 * ringExplosion always replays the same sequence for the same seed */
function mulberry32(seed: number): () => number {
	let a = seed | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export interface RingSpec {
	size: number;
	dirX: number;
	dirY: number;
	distance: number;
}

/** argonjudgementpiece.cs:101-169 -- ring counts/travel per grade (meh: 3
 * small at 0.3x travel; ok/good: 4 small at 0.6x; great/perfect: 4 small + 4
 * large at full travel; miss: none, RingExplosion is only added for hit
 * results). decision 7: lazer computes `RNG.NextSingle(0, 360)` and feeds it
 * straight into `MathF.Cos`/`MathF.Sin` (argonjudgementpiece.cs:153-163),
 * degrees where radians are expected -- that quirk is reproduced literally
 * below, not "fixed" to a proper degrees-to-radians conversion */
export function ringExplosion(grade: Grade, seed: number): RingSpec[] {
	const rng = mulberry32(seed);
	let travel = 52;
	let small = 0;
	let large = 0;
	if (grade === "meh") {
		small = 3;
		travel *= 0.3;
	} else if (grade === "ok") {
		small = 4;
		travel *= 0.6;
	} else if (grade === "great") {
		small = 4;
		large = 4;
	}
	const specs: RingSpec[] = [];
	for (let i = 0; i < small + large; i++) {
		const direction = rng() * 360; // degrees, used directly as radians below (the quirk)
		const distance = travel / 2 + rng() * (travel / 2);
		specs.push({
			size: i < small ? 9 : 14,
			dirX: Math.cos(direction),
			dirY: Math.sin(direction),
			distance
		});
	}
	return specs;
}

export interface TickMissTracks {
	alpha: Track[];
	scale: Track[];
}

/** argonjudgementpiecesslidertickmiss.cs:41-47 -- scale 1.4->1 over 150 out,
 * fade 600 linear */
export function tickMissTracks(spec: { time: number }): TickMissTracks {
	return {
		alpha: [tween(spec.time, 600, 1, 0)],
		scale: [tween(spec.time, 150, 1.4, 1, out)]
	};
}

export interface ResultTracks {
	containerAlpha: Track[];
	textAlpha: Track[];
	textScale: Track[];
	missScale: Track[];
	missDrop: Track[];
	missRotate: Track[];
	ringMove: Track[];
	ringAlpha: Track[];
}

/** argonjudgementpiece.cs:63-97 -- the text + ring-explosion popup's per-
 * property tracks, shared by hit and miss results */
export function resultTracks(spec: { time: number; grade: Grade }): ResultTracks {
	const missed = spec.grade === "miss";
	return {
		containerAlpha: [tween(spec.time, 800, 1, 0)],
		missScale: missed ? [tween(spec.time, 100, 1.6, 1, easeIn)] : [],
		missDrop: missed ? [tween(spec.time, 800, 0, 100, inQuint)] : [],
		missRotate: missed ? [tween(spec.time, 800, 0, 40, inQuint)] : [],
		textAlpha: missed ? [jump(spec.time, 1)] : [tween(spec.time, 300, 0, 1, outQuint)],
		textScale: missed ? [jump(spec.time, 1)] : [tween(spec.time, 1800, 1, 1.2, outQuint)],
		ringMove: [tween(spec.time, 600, 0.3, 1, outQuint)],
		ringAlpha: [tween(spec.time, 1000, 1, 0, outQuint)]
	};
}
