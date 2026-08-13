import { describe, expect, test } from "bun:test";
import { Container, RenderLayer, Sprite, Texture, type Renderer } from "pixi.js";
import { trackValueAt } from "../../engine/transforms";
import type { EffectSettings } from "../../lib/scene-types";
import { DEFAULT_EFFECTS, DEFAULT_OVERLAYS } from "../../state/defaults";
import { testScene } from "../../test/scene";
import type { RenderContext, TextureBaker } from "../GameplayRenderer";
import { CursorDrawable, expandTracks, holdIntervals } from "./cursor";

const frame = (time: number, buttons: number) => ({ time, x: 0, y: 0, buttons });

describe("hold intervals", () => {
	test("merges left/right holds into gameplay-press spans", () => {
		const intervals = holdIntervals([
			frame(0, 0),
			frame(10, 1),
			frame(20, 1 | 2),
			frame(30, 2),
			frame(40, 0),
			frame(50, 4),
			frame(60, 0)
		]);
		expect(intervals).toEqual([
			{ start: 10, end: 40 },
			{ start: 50, end: 60 }
		]);
	});

	test("a hold running to the last frame stays open-ended", () => {
		const intervals = holdIntervals([frame(0, 0), frame(10, 1)]);
		expect(intervals).toEqual([{ start: 10, end: Number.POSITIVE_INFINITY }]);
	});
});

describe("expand tracks (skinnablecursor.cs:9-30)", () => {
	test("press snaps to 1 then eases to 1.2; release eases back", () => {
		const tracks = expandTracks([{ start: 100, end: 600 }]);
		expect(trackValueAt(tracks, 99, 1)).toBe(1);
		expect(trackValueAt(tracks, 100, 1)).toBe(1);
		expect(trackValueAt(tracks, 500, 1)).toBeCloseTo(1.2, 3); // settled
		expect(trackValueAt(tracks, 1000, 1)).toBeCloseTo(1, 3); // released
	});

	test("a genuinely brief but non-zero hold still runs both the press and release tweens", () => {
		// 1ms hold: short, but start !== end, so this is the ordinary path, not
		// the degenerate same-instant case below. the press tween barely gets
		// going before the release tween (started at 101) takes over, so this
		// never reaches 1.2 -- it only needs to show real (if brief) motion,
		// unlike the zero-duration case, which stays pinned at exactly 1
		const tracks = expandTracks([{ start: 100, end: 101 }]);
		expect(trackValueAt(tracks, 99, 1)).toBe(1);
		expect(trackValueAt(tracks, 100, 1)).toBe(1);
		// mid-ramp, still driven by the press tween since the release tween's
		// start (101) hasn't been reached yet
		expect(trackValueAt(tracks, 100.5, 1)).toBeGreaterThan(1);
		// well after the release tween (101 + 400 = 501) has finished
		expect(trackValueAt(tracks, 600, 1)).toBeCloseTo(1, 6);
	});

	test("a release mid-expansion contracts from the sampled value, not from 1.2", () => {
		// contract()'s scaleto starts from the drawable's current value
		// (skinnablecursor.cs:21), so a 200ms hold releases from wherever the
		// 400ms elastic actually got to -- no pop to the completed 1.2
		const tracks = expandTracks([{ start: 100, end: 300 }]);
		const pressOnly = expandTracks([{ start: 100, end: Number.POSITIVE_INFINITY }]);
		const atRelease = trackValueAt(pressOnly, 300, 1);
		expect(trackValueAt(tracks, 300, 1)).toBeCloseTo(atRelease, 9);
		expect(trackValueAt(tracks, 800, 1)).toBeCloseTo(1, 9); // settled back after the 400ms contraction
	});

	test("a same-instant press and release (start === end) never visibly expands", () => {
		// holdIntervals produces exactly this shape from a duplicate-time frame
		// run: frame(10,1) pressed then frame(10,0) released, both at time 10
		// (interpolation.ts already treats this pairing as real input --
		// interpolation.test.ts:68). Expand()'s instant jump-to-1 is immediately
		// superseded by Contract()'s ScaleTo(1, ...) starting from that same
		// already-1 value (skinnablecursor.cs:14-23), so nothing ever ramps to
		// 1.2 -- unlike the naive 3-track push, which let the release tween
		// (tied at the same start) win and snap the value to 1.2
		const intervals = holdIntervals([frame(0, 0), frame(10, 1), frame(10, 0), frame(20, 0)]);
		expect(intervals).toEqual([{ start: 10, end: 10 }]);

		const tracks = expandTracks(intervals);
		expect(trackValueAt(tracks, 9, 1)).toBe(1);
		expect(trackValueAt(tracks, 10, 1)).toBe(1);
		expect(trackValueAt(tracks, 50, 1)).toBe(1);
		expect(trackValueAt(tracks, 500, 1)).toBe(1);
	});

	test("a same-instant blip cuts off an in-flight release tween from an earlier press, pinning to 1", () => {
		// interval1 releases at t=500 (mid-ramp back down at t=520); interval2
		// is a same-instant blip that reopens and immediately recloses at 520,
		// the same duplicate-time-run shape as above. Expand()'s unconditional
		// jump must win over interval1's still-in-flight release tween
		const tracks = expandTracks([
			{ start: 100, end: 500 },
			{ start: 520, end: 520 }
		]);
		expect(trackValueAt(tracks, 519, 1)).toBeGreaterThan(1); // interval1's release tween, still easing down
		expect(trackValueAt(tracks, 520, 1)).toBe(1);
		expect(trackValueAt(tracks, 521, 1)).toBe(1);
	});
});

describe("CursorDrawable, the cursorGlow and cursorTrail effects", () => {
	// a straight left-to-right sweep, far enough per step to spawn trail parts
	// (TRAIL_INTERVAL is ~10.24 osu!px)
	const frames = Array.from({ length: 12 }, (_, i) => ({ time: i * 16, x: i * 40, y: 100, buttons: 0 }));

	// a getter, not a value: the renderer reads the effects live, and the
	// disable path below has to flip them between two update() calls
	function stubContext(getEffects: () => EffectSettings, sceneFrames = frames): RenderContext {
		const noCanvas: TextureBaker = {
			canvasTexture: () => Texture.WHITE,
			glowTexture: () => Texture.WHITE,
			circleTexture: () => Texture.WHITE,
			ringTexture: () => Texture.WHITE,
			gradientCircleTexture: () => Texture.WHITE,
			approachCircleTexture: () => Texture.WHITE
		};
		return {
			scene: { ...testScene(), frames: sceneFrames },
			derived: {} as RenderContext["derived"],
			accents: [],
			textures: noCanvas,
			renderer: {} as unknown as Renderer,
			getOverlays: () => DEFAULT_OVERLAYS,
			getEffects,
			getEditChrome: () => null,
			layers: {
				followPoints: new Container(),
				objects: new Container(),
				approach: new RenderLayer(),
				judgements: new Container(),
				analysis: new Container(),
				cursor: new Container(),
				editChrome: new Container()
			}
		};
	}

	/** the trail parts live under the drawable's second child (the ring/dot
	 * container is the first); a part counts as live while it is visible */
	function liveTrailParts(drawable: CursorDrawable): number {
		const trailLayer = drawable.view.children[0] as Container;
		return trailLayer.children.filter((c) => c.visible).length;
	}

	/** the ring/dot container is the drawable's second child; inside it the
	 * order is expandTarget (ring), glow, dot */
	function cursorPieces(drawable: CursorDrawable) {
		const [expandTarget, glow, dot] = (drawable.view.children[1] as Container).children;
		return { expandTarget, glow, dot };
	}

	test("both on: the glow shows and the trail draws parts", () => {
		const drawable = new CursorDrawable(stubContext(() => DEFAULT_EFFECTS));
		for (const frame of frames) drawable.update(frame.time);
		expect(liveTrailParts(drawable)).toBeGreaterThan(0);
		expect(cursorPieces(drawable).glow.visible).toBe(true);
	});

	test("a fresh drawable draws the same trail as one that has played all the way there", () => {
		// what a density rebake does mid-replay: the scene-lifetime drawables are
		// destroyed and rebuilt, and the rebuilt cursor must land on exactly the
		// scene the old one was showing -- paused, where no later update() would
		// ever refill an emptied trail
		const t = frames[frames.length - 1].time;
		const played = new CursorDrawable(stubContext(() => DEFAULT_EFFECTS));
		for (const frame of frames) played.update(frame.time);
		const rebuilt = new CursorDrawable(stubContext(() => DEFAULT_EFFECTS));
		rebuilt.update(t);

		const describeParts = (drawable: CursorDrawable) =>
			(drawable.view.children[0] as Container).children
				.filter((c) => c.visible)
				.map((c) => [c.x, c.y, c.alpha, (c as Sprite).width]);
		expect(describeParts(rebuilt)).toEqual(describeParts(played));
		expect(describeParts(rebuilt).length).toBeGreaterThan(0);
	});

	test("a part is drawn at the press expansion the cursor had when it passed", () => {
		// the same sweep with a press held through it: the trail widens with the
		// expansion instead of staying at the resting part size
		const t = frames[frames.length - 1].time;
		const held = frames.map((f) => ({ ...f, buttons: 1 }));
		const pressed = new CursorDrawable(stubContext(() => DEFAULT_EFFECTS, held));
		pressed.update(t);
		const resting = new CursorDrawable(stubContext(() => DEFAULT_EFFECTS));
		resting.update(t);

		const partWidths = (drawable: CursorDrawable) =>
			(drawable.view.children[0] as Container).children.filter((c) => c.visible).map((c) => (c as Sprite).width);
		expect(partWidths(resting).length).toBeGreaterThan(0);
		expect(partWidths(pressed)).toHaveLength(partWidths(resting).length);
		for (const [i, width] of partWidths(pressed).entries()) {
			expect(width).toBeGreaterThan(partWidths(resting)[i]);
		}
	});

	test("cursorGlow off hides only the glow -- the ring and dot stay", () => {
		const drawable = new CursorDrawable(stubContext(() => ({ ...DEFAULT_EFFECTS, cursorGlow: false })));
		drawable.update(0);
		const { expandTarget, glow, dot } = cursorPieces(drawable);
		expect(glow.visible).toBe(false);
		expect(expandTarget.visible).toBe(true);
		expect(dot.visible).toBe(true);
		expect(drawable.view.visible).toBe(true);
	});

	test("cursorTrail off hides the layer and every part with it", () => {
		// the parts are recomputed from the frames each update, so re-enabling
		// picks the trail back up behind wherever the cursor is by then -- what
		// must not survive is a part still drawn while the effect is off
		let effects: EffectSettings = DEFAULT_EFFECTS;
		const drawable = new CursorDrawable(stubContext(() => effects));
		for (const frame of frames) drawable.update(frame.time);
		expect(liveTrailParts(drawable)).toBeGreaterThan(0);

		effects = { ...DEFAULT_EFFECTS, cursorTrail: false };
		drawable.update(frames[frames.length - 1].time + 16);
		expect((drawable.view.children[0] as Container).visible).toBe(false);
		expect(liveTrailParts(drawable)).toBe(0);
	});
});
