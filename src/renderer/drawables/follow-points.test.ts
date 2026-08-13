import { describe, expect, test } from "bun:test";
import { Container, RenderLayer, Texture, type Renderer } from "pixi.js";
import { fromBytes } from "../../engine/color";
import { deriveScene } from "../../lib/derive";
import type { RenderObject } from "../../lib/scene-types";
import { DEFAULT_EFFECTS, effectiveEffects } from "../../state/defaults";
import { testScene } from "../../test/scene";
import type { RenderContext, TextureBaker } from "../GameplayRenderer";
import { FollowPointsDrawable, generateFollowPoints } from "./follow-points";

function circle(startTime: number, x: number, y: number, comboIndex: number): RenderObject {
	return {
		startTime,
		endTime: startTime,
		position: [x, y],
		stackHeight: 0,
		comboColourIndex: comboIndex,
		comboIndex,
		indexInCombo: 0,
		preempt: 600,
		fadeIn: 400,
		kind: { type: "circle" }
	};
}

describe("follow point generation (followpointconnection.cs)", () => {
	test("a 300px pair emits points at 48..240 step 32", () => {
		const specs = generateFollowPoints([circle(1000, 0, 0, 1), circle(2000, 300, 0, 1)], 0.5);
		expect(specs).toHaveLength(7);
		const first = specs[0];
		// fraction 0.16: slides from 6% to 16% along the vector
		expect(first.toX).toBeCloseTo(48, 9);
		expect(first.fromX).toBeCloseTo(48 - 0.1 * 300, 9);
		expect(first.rotation).toBeCloseTo(0, 9);
		// fadeout at 1000 + 0.16*1000, fadein preempt=800 earlier
		expect(first.fadeOutTime).toBeCloseTo(1160, 9);
		expect(first.fadeInTime).toBeCloseTo(360, 9);
		expect(first.fadeDuration).toBe(400);
	});

	test("new combos and spinners suppress the connection", () => {
		expect(generateFollowPoints([circle(1000, 0, 0, 1), circle(2000, 300, 0, 2)], 0.5)).toHaveLength(0);
		const spinner: RenderObject = {
			...circle(1000, 0, 0, 1),
			kind: { type: "spinner", duration: 500, spinsRequired: 1, maxBonusSpins: 1 }
		};
		expect(generateFollowPoints([spinner, circle(2000, 300, 0, 1)], 0.5)).toHaveLength(0);
	});

	test("sliders connect from their stacked end position", () => {
		const slider: RenderObject = {
			...circle(1000, 0, 0, 1),
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
				endPosition: [100, 0],
				snakeInDuration: 200,
				nested: []
			}
		};
		const specs = generateFollowPoints([slider, circle(2500, 400, 0, 1)], 0.5);
		// vector runs 100 -> 400 (length 300), times run 1500 -> 2500
		expect(specs[0].toX).toBeCloseTo(100 + 48, 9);
		expect(specs[0].fadeOutTime).toBeCloseTo(1500 + 0.16 * 1000, 9);
	});

	test("short gaps emit nothing", () => {
		expect(generateFollowPoints([circle(1000, 0, 0, 1), circle(1200, 70, 0, 1)], 0.5)).toHaveLength(0);
	});
});

/** ctx.textures.canvasTexture routes to a real `document`, which bun test
 * doesn't provide -- see judgements.test.ts's stubContextWithoutCanvas for
 * the same substitution reasoning. Texture.WHITE needs no canvas at all */
function stubContext(scene: ReturnType<typeof testScene>, effects = DEFAULT_EFFECTS): RenderContext {
	const palette = scene.renderPlan.comboColours;
	const noCanvas: TextureBaker = {
		canvasTexture: () => Texture.WHITE,
		glowTexture: () => Texture.WHITE,
		circleTexture: () => Texture.WHITE,
		ringTexture: () => Texture.WHITE,
		gradientCircleTexture: () => Texture.WHITE,
		approachCircleTexture: () => Texture.WHITE
	};
	return {
		scene,
		derived: deriveScene(scene),
		accents: scene.renderPlan.objects.map((o) => fromBytes(palette[o.comboColourIndex % palette.length])),
		textures: noCanvas,
		renderer: {} as unknown as Renderer,
		getOverlays: () => ({
			cursorPath: false,
			clickMarkers: false,
			frameMarkers: false,
			hideCursor: false,
			keyOverlay: true,
			displayLength: 800,
			playfieldGrid: 0
		}),
		getEffects: () => effects,
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

describe("FollowPointsDrawable, backward-seek orphan regression (playfield.ts's reconcileActiveDrawables)", () => {
	test("a chevron alive both before and after a backward seek is reused, not orphaned as a second child", () => {
		// a 100px pair one apart in x produces exactly one connecting chevron
		// (d=48 is the only offset satisfying 48 < distance-32=68), with window
		// [680, 1880) (see the hand-worked comment on the generation test above
		// for the fadeIn/fadeOut/preempt arithmetic this mirrors)
		const scene = testScene({
			renderPlan: {
				...testScene().renderPlan,
				scale: 0.5,
				objects: [circle(1000, 0, 0, 1), circle(2000, 100, 0, 1)]
			}
		});
		const ctx = stubContext(scene);
		const drawable = new FollowPointsDrawable(ctx);

		drawable.update(1200);
		expect(drawable.view.children.length).toBe(1);
		const original = drawable.view.children[0];

		drawable.update(900); // backward seek, still inside [680, 1880)
		// before the fix, follow-points.ts unconditionally built a fresh sprite
		// for every `added` index and overwrote `this.sprites`' entry, so the
		// original chevron stayed parented under this.view as an untracked,
		// additively-blended second child, frozen at its seek-instant pose
		expect(drawable.view.children.length).toBe(1);
		expect(drawable.view.children[0]).toBe(original);
	});
});

describe("FollowPointsDrawable, the followPoints effect", () => {
	function sceneWithOneChevron() {
		return testScene({
			renderPlan: {
				...testScene().renderPlan,
				scale: 0.5,
				objects: [circle(1000, 0, 0, 1), circle(2000, 100, 0, 1)]
			}
		});
	}

	test("the effect hides the view but keeps the chevrons pooled and positioned", () => {
		// a visibility flip, not a teardown: the chevron stays live so the
		// instant the effect returns it shows the current frame, not a stale one
		const off = { ...DEFAULT_EFFECTS, followPoints: false };
		const drawable = new FollowPointsDrawable(stubContext(sceneWithOneChevron(), off));

		drawable.update(1200);
		expect(drawable.view.visible).toBe(false);
		expect(drawable.view.children.length).toBe(1);
	});

	test("the view is visible with the effect on", () => {
		const drawable = new FollowPointsDrawable(stubContext(sceneWithOneChevron()));
		drawable.update(1200);
		expect(drawable.view.visible).toBe(true);
	});

	test("the master switch alone hides it, without the granular flag moving", () => {
		// effectiveEffects is what the renderer hands the drawable, so the
		// drawable itself never re-checks `enabled`
		const stored = { ...DEFAULT_EFFECTS, enabled: false };
		const drawable = new FollowPointsDrawable(stubContext(sceneWithOneChevron(), effectiveEffects(stored)));
		drawable.update(1200);
		expect(drawable.view.visible).toBe(false);
		expect(stored.followPoints).toBe(true);
	});
});
