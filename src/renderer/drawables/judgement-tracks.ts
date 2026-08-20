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
import {
	LEGACY_JUDGEMENT_FADE_IN,
	LEGACY_JUDGEMENT_FADE_OUT_DELAY,
	LEGACY_JUDGEMENT_FADE_OUT_LENGTH
} from "@/skin/legacy/constants";
import type { JudgementPieceSpec, JudgedResult, SkinPieces } from "@/skin/pieces";
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
	/** what the ACTIVE SKIN draws for this result -- argon's text popup, its
	 * tick-miss dot, a legacy skin's own grade texture, or nothing. resolved
	 * once by `skin/pieces.ts` and read here; this module decides no part of it */
	piece: JudgementPieceSpec;
	/**
	 * whether hit lighting plays behind this popup.
	 *
	 * drawableosujudgement.cs:73-87 -- lighting is applied on the HIT animation
	 * path only, and skinnablelighting.cs:46 colours it transparent for a miss
	 * or a tick, which is the same statement as not drawing it. deliberately
	 * independent of whether a popup is drawn at all: a great lights the object
	 * even with the show-300s preference off, because the lighting is what the
	 * hit-effects toggle owns and the popup is what the show-300s one does
	 */
	lighting: boolean;
	/** the object's own combo colour, which is what the lighting is tinted with */
	accent: Rgba;
	seed: number;
}

function nestedAt(nested: RenderNested[], time: number, kind: RenderNested["kind"]): RenderNested | null {
	return nested.find((n) => n.kind === kind && Math.abs(n.time - time) <= 1) ?? null;
}

/** drawableosujudgement.cs:39-71 -- popup position (slider tail for the
 * aggregate, playfield centre for spinners, the object itself otherwise). what
 * each result draws is not decided here: every candidate is put to the skin
 * (argonProJudgementPiece) and only a `piece` answer becomes a spec */
export function judgementSpecs(scene: LoadedScene, pieces: SkinPieces, accents: readonly Rgba[]): JudgementSpec[] {
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
		const piece = pieces.judgements[result];
		// lighting is the object's own, not the popup's: a hit that is not a tick
		// lights whatever the skin answered about the popup
		const grade = result === "largeTickMiss" ? "miss" : result === "largeTickHit" ? "great" : (result as Grade);
		const lighting =
			pieces.hitLighting.kind !== "hidden" &&
			grade !== "miss" &&
			result !== "largeTickHit" &&
			result !== "largeTickMiss";
		// a spec with neither a popup nor a light is nothing to draw at all
		if (piece.kind === "hidden" && !lighting) return;
		specs.push({
			time: event.time,
			x,
			y,
			// the tick-miss piece is drawn in miss colours whichever result
			// produced it (argonjudgementpiecesslidertickmiss.cs)
			grade,
			piece,
			lighting,
			accent: accents[event.objectIndex] ?? GRADE_COLOURS.great,
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

export interface LegacyJudgementTracks {
	/** the whole popup's fade, which every legacy judgement shares */
	alpha: Track[];
	scale: Track[];
	/** the miss drop, in osu!px */
	moveY: Track[];
	/** the miss tumble, in degrees */
	rotate: Track[];
}

/**
 * legacyjudgementpieceold.cs:38-97 -- one envelope for every grade, and three
 * different bodies inside it.
 *
 * `animated` is load-bearing and easy to miss: **a legacy judgement that is an
 * animation plays no transforms at all** (:52). a skin that ships `hit100-0`,
 * `hit100-1`, ... has already authored the motion it wants, and lazer refuses
 * to add its own on top -- so the popup only fades.
 *
 * the miss rotation is `RNG.NextSingle(-8.6, 8.6)`, which is per-popup and
 * random; it is drawn from the same deterministic per-event seed the argon
 * ring explosion uses, so re-seeking never reshuffles a popup
 */
export function legacyJudgementTracks(
	spec: { time: number; grade: Grade; seed: number },
	options: { animated: boolean; missedTick: boolean; skinVersion: number }
): LegacyJudgementTracks {
	const t = spec.time;
	const tracks: LegacyJudgementTracks = {
		// :48-49 -- FadeInFromZero(120), then Delay(500).FadeOut(600)
		alpha: [
			tween(t, LEGACY_JUDGEMENT_FADE_IN, 0, 1),
			tween(t + LEGACY_JUDGEMENT_FADE_OUT_DELAY, LEGACY_JUDGEMENT_FADE_OUT_LENGTH, 1, 0)
		],
		scale: [jump(t, 1)],
		moveY: [jump(t, 0)],
		rotate: [jump(t, 0)]
	};
	if (options.animated) return tracks;

	if (spec.grade === "miss") {
		if (options.missedTick) {
			// :62-65 -- a missed tick pops smaller and fades from halfway
			tracks.scale = [jump(t, 1.2), tween(t, 100, 1.2, 1, easeIn)];
			tracks.alpha = [
				tween(t, LEGACY_JUDGEMENT_FADE_IN, 0, 1),
				tween(t + LEGACY_JUDGEMENT_FADE_OUT_DELAY / 2, LEGACY_JUDGEMENT_FADE_OUT_LENGTH, 1, 0)
			];
			return tracks;
		}
		// :69-70
		tracks.scale = [jump(t, 1.6), tween(t, 100, 1.6, 1, easeIn)];
		const total = LEGACY_JUDGEMENT_FADE_OUT_DELAY + LEGACY_JUDGEMENT_FADE_OUT_LENGTH;
		if (options.skinVersion > 1) {
			// :74-75 -- a version 2 skin's miss starts 5px high and falls 80
			tracks.moveY = [jump(t, -5), tween(t, total, -5, 75, easeIn)];
		}
		// :78-82 -- rotate to r over the fade-in, then on to 2r over the rest
		const rotation = -8.6 + mulberry32(spec.seed)() * 17.2;
		tracks.rotate = [
			tween(t, LEGACY_JUDGEMENT_FADE_IN, 0, rotation),
			tween(t + LEGACY_JUDGEMENT_FADE_IN, total - LEGACY_JUDGEMENT_FADE_IN, rotation, rotation * 2, easeIn)
		];
		return tracks;
	}

	// :87-95 -- the hit pop, written as stable's own four-step sequence. the
	// comment there explains the 0.95 hard-set: stable dictates 0.9 -> 1 over
	// t=1.0..1.4 but the sequence is already at t=1.2, so the value is forced
	// to the halfway point and the second half of the transform completes
	const step = LEGACY_JUDGEMENT_FADE_IN * 0.2;
	tracks.scale = [
		jump(t, 0.6),
		tween(t, LEGACY_JUDGEMENT_FADE_IN * 0.8, 0.6, 1.1),
		tween(t + LEGACY_JUDGEMENT_FADE_IN, step, 1.1, 0.9),
		tween(t + LEGACY_JUDGEMENT_FADE_IN + step, step, 0.95, 1)
	];
	return tracks;
}
