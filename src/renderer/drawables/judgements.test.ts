// JudgementsDrawable itself is a pixi applier; the pure logic it draws from
// (judgementSpecs/ringExplosion/tickMissTracks/resultTracks/GRADE_COLOURS)
// is tested directly in judgement-tracks.test.ts. this file only covers what
// requires an actual JudgementsDrawable instance: decision 5's notSimulated
// path, which -- because judgementSpecs returns [] before any Sprite/Text is
// ever built -- never touches `document` and so can run headlessly here,
// unlike every authoritative-path popup build (which needs a canvas 2d
// context textures.ts doesn't have under bun test)

import { describe, expect, test } from "bun:test";
import { Container, RenderLayer, Texture, type Renderer } from "pixi.js";
import { fromBytes } from "../../engine/color";
import { deriveScene } from "../../lib/derive";
import { DEFAULT_EFFECTS } from "../../state/defaults";
import { testScene } from "../../test/scene";
import type { RenderContext, TextureBaker } from "../GameplayRenderer";
import * as textures from "../textures";
import { JudgementsDrawable } from "./judgements";

function stubContext(scene: ReturnType<typeof testScene>): RenderContext {
	const palette = scene.renderPlan.comboColours;
	return {
		scene,
		derived: deriveScene(scene),
		accents: scene.renderPlan.objects.map((o) => fromBytes(palette[o.comboColourIndex % palette.length])),
		textures,
		// never touched by JudgementsDrawable; no headless renderer is available to construct here
		renderer: {} as unknown as Renderer,
		// never touched by JudgementsDrawable either -- only AnalysisDrawable reads this
		getOverlays: () => ({
			cursorPath: false,
			clickMarkers: false,
			frameMarkers: false,
			hideCursor: false,
			keyOverlay: true,
			displayLength: 800
		}),
		getEffects: () => DEFAULT_EFFECTS,
		layers: {
			followPoints: new Container(),
			objects: new Container(),
			approach: new RenderLayer(),
			judgements: new Container(),
			analysis: new Container(),
			cursor: new Container()
		}
	};
}

/** ctx.textures.circleTexture/ringTexture route through canvasTexture, which
 * needs a real `document` that bun test doesn't provide (see the notSimulated
 * comment above). Texture.WHITE is a pixi-internal 1x1 texture that needs no
 * canvas at all, so swapping it in lets the authoritative popup-build path
 * (buildResult/buildTickMiss) run headlessly for the orphan regression below */
function stubContextWithoutCanvas(scene: ReturnType<typeof testScene>): RenderContext {
	const ctx = stubContext(scene);
	const noCanvas: TextureBaker = {
		canvasTexture: () => Texture.WHITE,
		glowTexture: () => Texture.WHITE,
		circleTexture: () => Texture.WHITE,
		ringTexture: () => Texture.WHITE,
		gradientCircleTexture: () => Texture.WHITE,
		approachCircleTexture: () => Texture.WHITE
	};
	return { ...ctx, textures: noCanvas };
}

describe("JudgementsDrawable, notSimulated (decision 5)", () => {
	test("constructs and updates across a wide time range without throwing or ever building a popup", () => {
		const scene = testScene({ simulation: { status: "notSimulated", reason: "unsupportedMods" } });
		const ctx = stubContext(scene);
		const drawable = new JudgementsDrawable(ctx);

		for (const t of [-1000, 0, 500, 980, 1000, 1500, 2000, 5000]) {
			expect(() => drawable.update(t)).not.toThrow();
			expect(drawable.view.children.length).toBe(0);
		}

		expect(() => drawable.destroy()).not.toThrow();
	});
});

describe("JudgementsDrawable, backward-seek orphan regression (playfield.ts's reconcileActiveDrawables)", () => {
	function sceneWithOneGreatHit() {
		return testScene({
			simulation: {
				status: "authoritative",
				events: [
					{
						time: 1000,
						objectIndex: 0,
						kind: { type: "circle", grade: "great" },
						comboAfter: 1,
						accuracyAfter: 1
					}
				],
				totals: { count300: 1, count100: 0, count50: 0, countMiss: 0, maxCombo: 1 }
			}
		});
	}

	test("a popup alive both before and after a backward seek is reused, not orphaned as a second child", () => {
		// the popup's window is [1000, 2800) (POPUP_LIFETIME=1800). t=2000 lands
		// inside it, so it's already active by the time we seek backward to
		// t=1200, which still lands inside the same window -- ActiveSetTracker's
		// rebuild branch reports it in `added` again with no matching `removed`
		const ctx = stubContextWithoutCanvas(sceneWithOneGreatHit());
		const drawable = new JudgementsDrawable(ctx);

		drawable.update(2000);
		expect(drawable.view.children.length).toBe(1);
		const original = drawable.view.children[0];

		drawable.update(1200);
		// before the fix, judgements.ts unconditionally built a fresh popup for
		// every `added` index and overwrote `this.live`'s entry, so the original
		// popup's view stayed parented under this.view as an untracked second
		// child, never destroyed and never updated again
		expect(drawable.view.children.length).toBe(1);
		expect(drawable.view.children[0]).toBe(original);
	});

	test("the same scenario holds for the tickMiss popup shape", () => {
		const scene = testScene({
			renderPlan: {
				...sceneWithOneGreatHit().renderPlan,
				objects: [
					{
						startTime: 1000,
						endTime: 1500,
						position: [100, 100],
						stackHeight: 0,
						comboColourIndex: 1,
						comboIndex: 1,
						indexInCombo: 0,
						preempt: 600,
						fadeIn: 400,
						kind: {
							type: "slider",
							vertices: [100, 100, 200, 100],
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
									time: 1000,
									position: [100, 100],
									pathProgress: 0,
									preempt: 600,
									fadeIn: 400
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
						kind: { type: "sliderTick", hit: false },
						comboAfter: 0,
						accuracyAfter: 1
					}
				],
				totals: { count300: 0, count100: 0, count50: 0, countMiss: 1, maxCombo: 0 }
			}
		});
		const ctx = stubContextWithoutCanvas(scene);
		const drawable = new JudgementsDrawable(ctx);

		drawable.update(1500);
		expect(drawable.view.children.length).toBe(1);
		const original = drawable.view.children[0];

		// still inside the shared [1000, 1000+POPUP_LIFETIME) tracker window (the
		// tickMiss piece's own 150-600ms alpha/scale tweens are unrelated to it)
		drawable.update(1100);
		expect(drawable.view.children.length).toBe(1);
		expect(drawable.view.children[0]).toBe(original);
	});
});
