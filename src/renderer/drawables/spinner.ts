// judgement-correct minimal spinner (spec: visual fidelity deferred, see
// TODO.md). rotation is a frontend-only integration of cursor angle deltas
// (spinnerrotationtracker.cs:63-111 without damping); progress prefers the
// simulation's spinnerspin events

import { Container, Graphics } from "pixi.js";
import { SPINNER_FADE_OUT_TIME } from "../../engine/game-constants";
import { isLeft, isRight } from "../../engine/buttons";
import { cursorStateAt } from "../../engine/interpolation";
import { jump, trackValueAt, tween, type Track } from "../../engine/transforms";
import type { FrameDto } from "../../lib/scene-types";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";

export function spinnerRotationSamples(
	frames: FrameDto[],
	startTime: number,
	endTime: number
): { times: number[]; cumulative: number[] } {
	const times: number[] = [];
	const cumulative: number[] = [];
	let total = 0;
	let lastAngle: number | null = null;
	for (const frame of frames) {
		const angle = -(Math.atan2(frame.x - 256, frame.y - 192) * 180) / Math.PI;
		const inWindow = frame.time >= startTime && frame.time < endTime;
		const holding = isLeft(frame.buttons) || isRight(frame.buttons);
		if (lastAngle !== null && inWindow && holding) {
			let delta = angle - lastAngle;
			if (delta > 180) delta -= 360;
			if (delta < -180) delta += 360;
			total += delta;
		}
		lastAngle = angle;
		times.push(frame.time);
		cumulative.push(Math.abs(total));
	}
	return { times, cumulative };
}

function sampleAt(samples: { times: number[]; cumulative: number[] }, t: number): number {
	let lo = 0,
		hi = samples.times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (samples.times[mid] <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo === 0 ? 0 : samples.cumulative[lo - 1];
}

export class SpinnerDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly disc: Graphics;
	private readonly fill: Graphics;
	private readonly alphaTrack: Track[];
	private readonly rotation: { times: number[]; cumulative: number[] };
	private readonly spinTimes: number[];
	private readonly spinsRequired: number;
	private readonly startTime: number;
	private readonly endTime: number;
	private readonly frames: FrameDto[];
	/** simulation.status === "authoritative" -- gates whether spinTimes (the
	 * simulator's spinnerSpin judgements) or the local rotation integration
	 * drives progress (decision 5) */
	private readonly simulated: boolean;

	constructor(ctx: RenderContext, objectIndex: number) {
		const obj = ctx.scene.renderPlan.objects[objectIndex];
		const kind = obj.kind;
		if (kind.type !== "spinner") throw new Error("not a spinner");
		this.startTime = obj.startTime;
		this.endTime = obj.endTime;
		this.spinsRequired = kind.spinsRequired;
		this.frames = ctx.scene.frames;
		this.simulated = ctx.scene.simulation.status === "authoritative";
		this.rotation = spinnerRotationSamples(ctx.scene.frames, obj.startTime, obj.endTime);
		this.spinTimes = ctx.derived.judgementsByObject[objectIndex]
			.filter((e) => e.kind.type === "spinnerSpin")
			.map((e) => e.time);

		this.disc = new Graphics().circle(0, 0, 192).stroke({ width: 3, color: 0xffffff });
		this.fill = new Graphics().circle(0, 0, 184).fill(0xffffff);
		const centre = new Graphics().circle(0, 0, 40).stroke({ width: 6, color: 0xffffff });
		this.view.addChild(this.fill, this.disc, centre);
		this.view.position.set(256, 192);
		this.alphaTrack = [jump(obj.startTime - obj.preempt, 1), tween(obj.endTime, SPINNER_FADE_OUT_TIME, 1, 0)];
		ctx.layers.objects.addChild(this.view);
	}

	private progressAt(t: number): number {
		// drawablespinner.cs:236-239: spinsRequired == 0 is unconditionally
		// complete, checked before any rotation/event data is consulted
		if (this.spinsRequired === 0) return 1;
		if (this.simulated) {
			const done = this.spinTimes.filter((time) => time <= t).length;
			return Math.min(1, done / this.spinsRequired);
		}
		return Math.min(1, sampleAt(this.rotation, t) / 360 / this.spinsRequired);
	}

	update(t: number): void {
		this.view.alpha = trackValueAt(this.alphaTrack, t, 0);
		const sample = cursorStateAt(this.frames, t);
		const holding = sample !== null && (isLeft(sample.buttons) || isRight(sample.buttons));
		const state = t >= this.startTime && t < this.endTime && holding;
		this.disc.alpha = state ? 0.4 : 0.2;
		this.fill.alpha = state ? 0.4 : 0.2;
		this.fill.scale.set(0.1 + 0.88 * this.progressAt(t));
		this.view.rotation = (sampleAt(this.rotation, t) * Math.PI) / 180;
	}

	destroy(): void {
		// disc/fill/centre are raw Graphics with their own owned GraphicsContext;
		// {children: true} alone does not free it (Graphics.destroy() in
		// scene/graphics/shared/Graphics.js only calls context.destroy() when
		// options === true or options?.context === true), so context: true is
		// required here too -- the same leak class task 15 shipped
		this.view.destroy({ children: true, context: true });
	}
}
