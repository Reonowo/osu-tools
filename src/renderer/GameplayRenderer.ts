// the imperative pixi host: owns the application, playfield transform,
// layers, and per-object drawable lifecycles. all timing lives in the
// drawables' pure state tracks; this class only forwards t

import { Application, Container, RenderLayer, type Renderer } from "pixi.js";
import { fromBytes, type Rgba } from "../engine/color";
import { HIT_FADE_OUT_TIME } from "../engine/argon";
import type { DerivedScene } from "../lib/derive";
import type { LoadedScene } from "../lib/scene-types";
import type { OverlaySettings } from "../state/store";
import { DEFAULT_OVERLAYS } from "../state/defaults";
import { CircleDrawable } from "./drawables/circle";
import { CursorDrawable } from "./drawables/cursor";
import { FollowPointsDrawable } from "./drawables/follow-points";
import { JudgementsDrawable } from "./drawables/judgements";
import { SliderDrawable } from "./drawables/slider";
import { SpinnerDrawable } from "./drawables/spinner";
import { AnalysisDrawable } from "./overlays/analysis";
import { ActiveSetTracker, objectLifetime, playfieldTransform, reconcileActiveDrawables } from "./playfield";
import * as textures from "./textures";

export interface ObjectDrawable {
  readonly view: Container;
  update(t: number): void;
  destroy(): void;
}

export interface RenderContext {
  scene: LoadedScene;
  derived: DerivedScene;
  /** per-object accent colours (comboColours[comboColourIndex % len]) */
  accents: Rgba[];
  textures: typeof textures;
  /** the pixi renderer, needed for the slider body's prepass render({ target }) calls */
  renderer: Renderer;
  /** the renderer's current overlay settings, read live (not snapshotted at
   * scene-build time) since the analysis drawable's update() must reflect
   * toggles made mid-playback */
  getOverlays(): OverlaySettings;
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
    new FollowPointsDrawable(ctx), new JudgementsDrawable(ctx),
    // analysis markers sit under the cursor layer in draw order too (both
    // are attached to their own dedicated ctx.layers container, already
    // positioned analysis-then-cursor in the root's child list)
    new AnalysisDrawable(ctx), new CursorDrawable(ctx),
  ];
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
  };
  private ctx: RenderContext | null = null;
  private overlays: OverlaySettings | null = null;
  private tracker: ActiveSetTracker | null = null;
  private drawables = new Map<number, ObjectDrawable>();
  private sceneDrawables: ObjectDrawable[] = [];
  private host!: HTMLElement;
  private resizeObserver!: ResizeObserver;

  static async create(host: HTMLElement): Promise<GameplayRenderer> {
    const renderer = new GameplayRenderer();
    renderer.host = host;
    renderer.app = new Application();
    await renderer.app.init({
      backgroundAlpha: 0,
      antialias: true,
      resolution: window.devicePixelRatio,
      autoDensity: true,
      preference: "webgl",
      resizeTo: host,
    });
    host.appendChild(renderer.app.canvas);

    // later objects render below earlier ones (osu approach order)
    renderer.layers.objects.sortableChildren = true;
    for (const layer of [
      renderer.layers.followPoints, renderer.layers.objects, renderer.layers.approach,
      renderer.layers.judgements, renderer.layers.analysis, renderer.layers.cursor,
    ]) {
      renderer.root.addChild(layer);
    }
    renderer.app.stage.addChild(renderer.root);

    renderer.resizeObserver = new ResizeObserver(() => renderer.layout());
    renderer.resizeObserver.observe(host);
    renderer.layout();
    return renderer;
  }

  private layout(): void {
    const { scale, offsetX, offsetY } = playfieldTransform(this.host.clientWidth, this.host.clientHeight);
    this.root.scale.set(scale);
    this.root.position.set(offsetX, offsetY);
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
      layers: this.layers,
    };
    this.tracker = new ActiveSetTracker(scene.renderPlan.objects.map((o, i) =>
      objectLifetime(o, derived.judgementsByObject[i] ?? [], HIT_FADE_OUT_TIME),
    ));
    this.sceneDrawables = createSceneDrawables(this.ctx);
  }

  setOverlays(overlays: OverlaySettings): void {
    this.overlays = overlays;
    this.layers.cursor.visible = !overlays.hideCursor;
  }

  render(t: number): void {
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
      (drawable) => drawable.destroy(),
    );
    for (const drawable of this.drawables.values()) drawable.update(t);
    for (const drawable of this.sceneDrawables) drawable.update(t);
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    for (const drawable of this.drawables.values()) drawable.destroy();
    for (const drawable of this.sceneDrawables) drawable.destroy();
    this.app.destroy(true, { children: true, texture: false });
  }
}
