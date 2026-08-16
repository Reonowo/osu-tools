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

/** the lazer `HitResult`s this viewer's judgement events map onto. the skin is
 * asked about a result, never about our own event kinds, exactly as
 * `SkinComponentLookup<HitResult>` is (hitresult.cs) */
export type JudgedResult = Grade | "largeTickHit" | "largeTickMiss";

/** what a skin answers when asked for a judgement piece. lazer's
 * `GetDrawableComponent` is three-valued and every value is load-bearing: a
 * drawable to show, `Drawable.Empty()` -- answered, with nothing -- and
 * `null`, declining so the next source answers instead. an empty answer is
 * NOT a decline: collapsing the two would resurrect exactly what a skin was
 * chosen to remove */
export type PieceAnswer = { answer: "piece"; style: "text" | "tickMiss" } | { answer: "empty" } | { answer: "none" };

/** osuargonskintransformer.cs:23-42, on the `isPro` branch -- argonpro is this
 * app's default skin throughout.
 *
 * :26-28 answers `Drawable.Empty()` for Great (and Perfect, which osu!std
 * never judges), which is why a 300 draws no popup here. the popup is missing
 * because THE SKIN ANSWERED EMPTY, not because the app decided a 300 is noisy:
 * when real skin loading lands, a legacy skin's 1x1 transparent `hit300.png`
 * must reach this same outcome through this same call, and a skin that draws
 * greats must get them back without this module changing. the app never
 * substitutes its own judgement for the skin's */
export function argonProJudgementPiece(result: JudgedResult): PieceAnswer {
	if (result === "great") return { answer: "empty" };
	switch (result) {
		// :32-34 -- large tick hits and slider tail hits get no piece at all
		case "largeTickHit":
			return { answer: "none" };
		// :36-38
		case "largeTickMiss":
			return { answer: "piece", style: "tickMiss" };
		// :40-41
		default:
			return { answer: "piece", style: "text" };
	}
}

/** drawableosujudgement.cs:39-71 -- popup position (slider tail for the
 * aggregate, playfield centre for spinners, the object itself otherwise). what
 * each result draws is not decided here: every candidate is put to the skin
 * (argonProJudgementPiece) and only a `piece` answer becomes a spec */
export function judgementSpecs(scene: LoadedScene): JudgementSpec[] {
	if (scene.simulation.status !== "authoritative") return [];
	const specs: JudgementSpec[] = [];
	scene.simulation.events.forEach((event, seed) => {
		const obj = scene.renderPlan.objects[event.objectIndex];
		const kind = event.kind;
		// what the skin is asked about, and where the piece it may return
		// would sit
		let result: JudgedResult;
		let x: number;
		let y: number;
		switch (kind.type) {
			case "circle":
				result = kind.grade;
				[x, y] = obj.position;
				break;
			case "sliderAggregate":
				result = kind.grade;
				[x, y] = obj.kind.type === "slider" ? obj.kind.endPosition : obj.position;
				break;
			case "spinnerFinal":
				result = kind.grade;
				x = 256;
				y = 192;
				break;
			case "sliderTick":
			case "sliderRepeat": {
				if (obj.kind.type !== "slider") return;
				const nested = nestedAt(obj.kind.nested, event.time, kind.type === "sliderTick" ? "tick" : "repeat");
				if (nested === null) return;
				result = kind.hit ? "largeTickHit" : "largeTickMiss";
				[x, y] = nested.position;
				break;
			}
			default:
				return;
		}
		const piece = argonProJudgementPiece(result);
		if (piece.answer !== "piece") return;
		specs.push({
			time: event.time,
			x,
			y,
			// the tick-miss piece is drawn in miss colours whichever result
			// produced it (argonjudgementpiecesslidertickmiss.cs)
			grade: result === "largeTickMiss" ? "miss" : (result as Grade),
			style: piece.style,
			seed
		});
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
