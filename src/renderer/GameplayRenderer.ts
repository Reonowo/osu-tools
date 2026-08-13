// the imperative pixi host: owns the application, playfield transform,
// layers, and per-object drawable lifecycles. all timing lives in the
// drawables' pure state tracks; this class only forwards t

// the release build runs under tauri.conf.json's csp, whose script-src has no
// 'unsafe-eval', so pixi's default new Function uniform-sync codegen throws in
// Application.init and nothing ever draws. this swap installs the static
// implementation and must be imported before any renderer init. tauri dev
// serves from the vite server where no csp is injected, so only the release
// build exercises this
import "pixi.js/unsafe-eval";
import { Application, Container, RenderLayer, type Renderer } from "pixi.js";
import { fromBytes, type Rgba } from "../engine/color";
import { HIT_FADE_OUT_TIME } from "../engine/argon";
import type { BrushRing, ChromeShape, PreviewSnapshot } from "../editor/preview";
import type { DerivedScene } from "../lib/derive";
import type { LoadedScene } from "../lib/scene-types";
import type { EffectSettings, OverlaySettings } from "../state/store";
import { DEFAULT_EFFECTS, DEFAULT_OVERLAYS, effectiveEffects } from "../state/defaults";
import { CircleDrawable } from "./drawables/circle";
import { CursorDrawable } from "./drawables/cursor";
import { FollowPointsDrawable } from "./drawables/follow-points";
import { JudgementsDrawable } from "./drawables/judgements";
import { SliderDrawable } from "./drawables/slider";
import { SpinnerDrawable } from "./drawables/spinner";
import { AnalysisDrawable } from "./overlays/analysis";
import { EditChromeDrawable } from "./overlays/edit-chrome";
import {
	ActiveSetTracker,
	clampViewportPan,
	DEFAULT_VIEWPORT_ZOOM,
	densityBucket,
	NO_VIEWPORT_PAN,
	objectLifetime,
	playfieldTransform,
	reconcileActiveDrawables,
	textureDensity,
	viewportTransform,
	type DensityBucket,
	type ViewportPan
} from "./playfield";
import * as textures from "./textures";

export interface ObjectDrawable {
	readonly view: Container;
	update(t: number): void;
	destroy(): void;
}

/** the drawing half of textures.ts. deliberately not the whole module: the
 * density bucket is the renderer's to set, and a drawable test that has to
 * stub textures should only ever have to stub the bake calls */
export type TextureBaker = Pick<
	typeof textures,
	| "canvasTexture"
	| "glowTexture"
	| "circleTexture"
	| "ringTexture"
	| "gradientCircleTexture"
	| "approachCircleTexture"
>;

/** live getters into the edit-mode chrome state: the frame selection from
 * the store, the gesture preview and shapes from the imperative preview
 * module. getters rather than values for the same reason getOverlays is --
 * every one changes mid-playback without a scene rebuild. null in watch
 * mode, which is what makes the chrome edit-mode-only */
export interface EditChromeSources {
	/** authoritative frame indices, ascending */
	selection(): readonly number[];
	preview(): PreviewSnapshot;
	shape(): ChromeShape | null;
	brush(): BrushRing | null;
}

export interface RenderContext {
	scene: LoadedScene;
	derived: DerivedScene;
	/** per-object accent colours (comboColours[comboColourIndex % len]) */
	accents: Rgba[];
	textures: TextureBaker;
	/** the pixi renderer, needed for the slider body's prepass render({ target }) calls */
	renderer: Renderer;
	/** the renderer's current overlay settings, read live (not snapshotted at
	 * scene-build time) since the analysis drawable's update() must reflect
	 * toggles made mid-playback */
	getOverlays(): OverlaySettings;
	/** the effect toggles with the master already folded in (setEffects runs
	 * defaults.ts's effectiveEffects once), read live for the same reason
	 * getOverlays is: a toggle made mid-playback has to reach the drawables
	 * without a scene rebuild. hitAnimations is the exception -- it feeds the
	 * precomputed timelines, so it is read at drawable construction and
	 * setEffects rebuilds the scene when it flips */
	getEffects(): EffectSettings;
	/** the edit-mode chrome sources, read live; null in watch mode */
	getEditChrome(): EditChromeSources | null;
	layers: {
		followPoints: Container;
		objects: Container;
		/** a RenderLayer, not a plain Container: drawables `attach()` proxied
		 * pieces here (eg. approach circles) while keeping their real Pixi
		 * parent under their own tracked `view`, so nothing is ever left
		 * attached outside a drawable's view for scene-reload cleanup to miss */
		approach: RenderLayer;
		judgements: Container;
		analysis: Container;
		cursor: Container;
		/** edit chrome sits above everything gameplay draws -- selection
		 * outline and shapes must never hide under the cursor or markers */
		editChrome: Container;
	};
}

function createDrawable(ctx: RenderContext, objectIndex: number): ObjectDrawable | null {
	const kind = ctx.scene.renderPlan.objects[objectIndex].kind;
	switch (kind.type) {
		case "circle":
			return new CircleDrawable(ctx, objectIndex);
		case "slider":
			return new SliderDrawable(ctx, objectIndex);
		case "spinner":
			return new SpinnerDrawable(ctx, objectIndex);
	}
}

/** scene-level drawables: unlike per-object drawables (createDrawable),
 * these live for the whole scene lifetime rather than an object's
 * appear/vanish window */
function createSceneDrawables(ctx: RenderContext): ObjectDrawable[] {
	return [
		new FollowPointsDrawable(ctx),
		new JudgementsDrawable(ctx),
		// analysis markers sit under the cursor layer in draw order too (both
		// are attached to their own dedicated ctx.layers container, already
		// positioned analysis-then-cursor in the root's child list)
		new AnalysisDrawable(ctx),
		new CursorDrawable(ctx),
		new EditChromeDrawable(ctx)
	];
}

/** long enough that a continuous ctrl+wheel zoom settles before anything
 * re-bakes, short enough that the sharper art lands while the user is still
 * looking at the same part of the replay */
const DENSITY_DEBOUNCE_MS = 250;

/** the slice of `window` the dpr watcher needs, injected rather than reached
 * for so the headless suite can drive a dpr change */
export interface DevicePixelRatioView {
	devicePixelRatio: number;
	matchMedia(query: string): {
		addEventListener(type: "change", listener: () => void): void;
		removeEventListener(type: "change", listener: () => void): void;
	};
}

/** calls back with the new ratio whenever the window's devicePixelRatio
 * changes -- dragging between monitors of different dpi, or a display-scale
 * change. a resolution media query can only ever test the one value it was
 * built with, so each change registers a fresh query against the new ratio
 * (the standard idiom); returns the unsubscribe */
export function watchDevicePixelRatio(view: DevicePixelRatioView, onChange: (dpr: number) => void): () => void {
	let stopCurrent: (() => void) | null = null;

	const register = (): void => {
		const query = view.matchMedia(`(resolution: ${view.devicePixelRatio}dppx)`);
		const listener = (): void => {
			// drop this query before arming the next: it was built against a
			// ratio that is no longer current and will never match again, and
			// leaving it attached leaks one listener per display change
			stopCurrent?.();
			// re-register before notifying: the callback re-runs layout, which
			// must see a watcher already armed against the ratio it is reading
			register();
			onChange(view.devicePixelRatio);
		};
		query.addEventListener("change", listener);
		stopCurrent = () => query.removeEventListener("change", listener);
	};

	register();
	return () => {
		stopCurrent?.();
		stopCurrent = null;
	};
}

export interface ResolutionTarget {
	resolution: number;
	resize(width: number, height: number): void;
}

/** what a dpr change costs the renderer: a new backing-store ratio, then a
 * resize at the unchanged css size so autoDensity re-derives the canvas'
 * pixel dimensions from it */
export function applyDevicePixelRatio(target: ResolutionTarget, dpr: number, widthPx: number, heightPx: number): void {
	target.resolution = dpr;
	target.resize(widthPx, heightPx);
}

export class GameplayRenderer {
	private app!: Application;
	private root = new Container();
	private layers = {
		followPoints: new Container(),
		objects: new Container(),
		approach: new RenderLayer(),
		judgements: new Container(),
		analysis: new Container(),
		cursor: new Container(),
		editChrome: new Container()
	};
	private ctx: RenderContext | null = null;
	private zoom = DEFAULT_VIEWPORT_ZOOM;
	private pan: ViewportPan = NO_VIEWPORT_PAN;
	private overlays: OverlaySettings | null = null;
	/** master already folded in; null until the first setEffects */
	private effects: EffectSettings | null = null;
	/** null in watch mode; set by PlayerView on mode changes */
	private editChromeSources: EditChromeSources | null = null;
	private tracker: ActiveSetTracker | null = null;
	private drawables = new Map<number, ObjectDrawable>();
	private sceneDrawables: ObjectDrawable[] = [];
	private host!: HTMLElement;
	private resizeObserver!: ResizeObserver;
	private devicePixelRatio = 1;
	private stopDprWatch: (() => void) | null = null;
	private densityTimer: ReturnType<typeof setTimeout> | null = null;

	static async create(host: HTMLElement): Promise<GameplayRenderer> {
		const renderer = new GameplayRenderer();
		renderer.host = host;
		renderer.devicePixelRatio = window.devicePixelRatio;
		renderer.app = new Application();
		await renderer.app.init({
			backgroundAlpha: 0,
			antialias: true,
			resolution: renderer.devicePixelRatio,
			autoDensity: true,
			preference: "webgl",
			resizeTo: host,
			// adr 0001 (one render clock): pixi's own ticker never starts, so
			// render() below is the only thing that ever draws this stage
			autoStart: false
		});
		host.appendChild(renderer.app.canvas);

		// later objects render below earlier ones (osu approach order)
		renderer.layers.objects.sortableChildren = true;
		for (const layer of [
			renderer.layers.followPoints,
			renderer.layers.objects,
			renderer.layers.approach,
			renderer.layers.judgements,
			renderer.layers.analysis,
			renderer.layers.cursor,
			renderer.layers.editChrome
		]) {
			renderer.root.addChild(layer);
		}
		renderer.app.stage.addChild(renderer.root);

		renderer.resizeObserver = new ResizeObserver(() => renderer.layout());
		renderer.resizeObserver.observe(host);
		renderer.stopDprWatch = watchDevicePixelRatio(window, (dpr) => renderer.onDevicePixelRatio(dpr));
		renderer.layout();
		return renderer;
	}

	private onDevicePixelRatio(dpr: number): void {
		this.devicePixelRatio = dpr;
		applyDevicePixelRatio(this.app.renderer, dpr, this.host.clientWidth, this.host.clientHeight);
		this.layout();
	}

	private layout(): void {
		const hostW = this.host.clientWidth;
		const hostH = this.host.clientHeight;
		// re-clamped here rather than trusted as given: the store's pan was
		// clamped against the host box as it stood when the user set it, and
		// this also runs from the resize observer, where a shrunk viewport can
		// leave that same pan outside the bounds it was valid for
		const { scale, x, y } = viewportTransform(
			hostW,
			hostH,
			this.zoom,
			clampViewportPan(hostW, hostH, this.zoom, this.pan)
		);
		this.root.scale.set(scale);
		this.root.position.set(x, y);
		this.scheduleDensityBucket(
			densityBucket(textureDensity(this.devicePixelRatio, playfieldTransform(hostW, hostH).scale, this.zoom))
		);
	}

	/** every path that changes the on-screen density -- resize, zoom, pan
	 * clamp, a dpr change -- runs through layout(), so the debounce lives here
	 * rather than at each caller. a zoom gesture walks dozens of scales and
	 * only the one it lands on should cost a re-bake */
	private scheduleDensityBucket(bucket: DensityBucket): void {
		if (this.densityTimer !== null) clearTimeout(this.densityTimer);
		// nothing is baked before the first scene, so the opening layout takes
		// effect immediately instead of leaving the first build a bucket behind
		if (this.ctx === null) {
			this.densityTimer = null;
			this.applyDensityBucket(bucket);
			return;
		}
		this.densityTimer = setTimeout(() => {
			this.densityTimer = null;
			this.applyDensityBucket(bucket);
		}, DENSITY_DEBOUNCE_MS);
	}

	/** per-object drawables are created and destroyed continuously as objects
	 * come alive, so they pick the new bucket up on their own; the four
	 * scene-lifetime ones never would, and are rebuilt against the same scene */
	private applyDensityBucket(bucket: DensityBucket): void {
		if (!textures.setDensityBucket(bucket)) return;
		if (this.ctx === null) return;
		for (const drawable of this.sceneDrawables) drawable.destroy();
		this.sceneDrawables = createSceneDrawables(this.ctx);
	}

	setViewport(zoom: number, pan: ViewportPan): void {
		this.zoom = zoom;
		this.pan = pan;
		this.layout();
	}

	setScene(scene: LoadedScene | null, derived: DerivedScene | null): void {
		for (const drawable of this.drawables.values()) drawable.destroy();
		this.drawables.clear();
		for (const drawable of this.sceneDrawables) drawable.destroy();
		this.sceneDrawables = [];
		for (const layer of Object.values(this.layers)) {
			// a RenderLayer never owns children directly (they stay parented under
			// their drawable's view); detachAll just forgets its proxy references,
			// the destroy() calls above already released the actual objects
			if (layer instanceof RenderLayer) layer.detachAll();
			else layer.removeChildren();
		}
		this.ctx = null;
		this.tracker = null;
		if (scene === null || derived === null) return;

		const palette = scene.renderPlan.comboColours;
		this.ctx = {
			scene,
			derived,
			accents: scene.renderPlan.objects.map((o) => fromBytes(palette[o.comboColourIndex % palette.length])),
			textures,
			renderer: this.app.renderer,
			getOverlays: () => this.overlays ?? DEFAULT_OVERLAYS,
			getEffects: () => this.effects ?? DEFAULT_EFFECTS,
			getEditChrome: () => this.editChromeSources,
			layers: this.layers
		};
		this.tracker = new ActiveSetTracker(
			scene.renderPlan.objects.map((o, i) =>
				objectLifetime(o, derived.judgementsByObject[i] ?? [], HIT_FADE_OUT_TIME)
			)
		);
		this.sceneDrawables = createSceneDrawables(this.ctx);
	}

	setOverlays(overlays: OverlaySettings): void {
		this.overlays = overlays;
		this.layers.cursor.visible = !overlays.hideCursor;
	}

	/** wires (or unwires, with null) the edit-mode chrome. sources are live
	 * getters, so this is called on mode changes only -- per-frame reads go
	 * through them on the next update() */
	setEditChromeSources(sources: EditChromeSources | null): void {
		this.editChromeSources = sources;
	}

	/** the four live effects reach their drawables through ctx.getEffects() on
	 * the next update(); hitAnimations is baked into the per-object timelines
	 * at construction, so flipping it rebuilds the object drawables against the
	 * same scene. only a user toggle can reach that branch -- the first call
	 * has no previous value to differ from, and every later one runs off a
	 * store write */
	setEffects(effects: EffectSettings): void {
		const resolved = effectiveEffects(effects);
		const rebuild = this.effects !== null && resolved.hitAnimations !== this.effects.hitAnimations;
		this.effects = resolved;
		if (rebuild && this.ctx !== null) {
			const { scene, derived } = this.ctx;
			this.setScene(scene, derived);
		}
	}

	/** the one render clock (adr 0001): the update pass, then the draw, always
	 * in that order and from nowhere else. with pixi's automatic tick off, a
	 * mutation arriving between two loop turns -- the debounced density rebake
	 * destroying and recreating the scene-lifetime drawables, a react effect
	 * rebuilding the scene after an edit -- can no longer reach the screen
	 * before the pass that positions it has run. drawing unconditionally, even
	 * with no scene installed, because the stage still holds whatever the last
	 * one left behind until setScene clears it.
	 *
	 * the one draw this is not: pixi's resize plugin renders once itself after
	 * a window resize. that is safe -- a resize rebuilds no drawables (the
	 * density rebake it may schedule is debounced past it), so the worst it
	 * can show is a complete scene one frame behind on the transform */
	render(t: number): void {
		this.update(t);
		this.app.render();
	}

	private update(t: number): void {
		if (this.ctx === null || this.tracker === null) return;
		const ctx = this.ctx;
		// reconcileActiveDrawables guards against re-creating an index the map
		// already holds -- load-bearing on a backward seek, where the tracker's
		// rebuild reports an object in `added` with no matching `removed` if it
		// was alive both before and after the seek (see playfield.ts)
		reconcileActiveDrawables(
			this.drawables,
			this.tracker.update(t),
			(index) => {
				const drawable = createDrawable(ctx, index);
				if (drawable !== null) drawable.view.zIndex = -ctx.scene.renderPlan.objects[index].startTime;
				return drawable;
			},
			(drawable) => drawable.destroy()
		);
		for (const drawable of this.drawables.values()) drawable.update(t);
		for (const drawable of this.sceneDrawables) drawable.update(t);
	}

	destroy(): void {
		this.resizeObserver.disconnect();
		this.stopDprWatch?.();
		this.stopDprWatch = null;
		if (this.densityTimer !== null) clearTimeout(this.densityTimer);
		this.densityTimer = null;
		for (const drawable of this.drawables.values()) drawable.destroy();
		for (const drawable of this.sceneDrawables) drawable.destroy();
		this.app.destroy(true, { children: true, texture: false });
	}
}
