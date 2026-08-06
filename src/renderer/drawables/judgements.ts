// pixi applier for argon judgement popups: builds Sprite/Text pieces from
// judgement-tracks.ts's pure specs/tracks and copies track values every
// frame. no timing logic lives here (decision 4) -- see judgement-tracks.ts
// for the animation math and its citations

import { Container, Sprite, Text } from "pixi.js";
import { toNumber } from "../../engine/color";
import { trackValueAt } from "../../engine/transforms";
import { ActiveSetTracker, reconcileActiveDrawables } from "../playfield";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import {
	GRADE_COLOURS,
	judgementSpecs,
	resultTracks,
	ringExplosion,
	tickMissTracks,
	type JudgementSpec,
	type RingSpec
} from "./judgement-tracks";

const POPUP_LIFETIME = 1800;
/** argonjudgementpiece.cs:107-110 -- ring stroke thickness */
const RING_THICKNESS = 4;
/** argonsliderscorepoint.cs:19 -- the tick-miss piece's diameter */
const TICK_MISS_SIZE = 12;
/** bake the stand-in ring/circle textures at 2x so their edges stay crisp
 * once scaled by the object's cs-scale */
const TEXTURE_SCALE = 2;

interface Popup {
	view: Container;
	update(t: number): void;
}

export class JudgementsDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly specs: JudgementSpec[];
	private readonly tracker: ActiveSetTracker;
	private readonly live = new Map<number, Popup>();
	private readonly scale: number;

	constructor(private readonly ctx: RenderContext) {
		this.specs = judgementSpecs(ctx.scene);
		this.scale = ctx.scene.renderPlan.scale;
		this.tracker = new ActiveSetTracker(
			this.specs.map((s) => ({
				appear: s.time,
				vanish: s.time + POPUP_LIFETIME
			}))
		);
		ctx.layers.judgements.addChild(this.view);
	}

	private buildTickMiss(spec: JudgementSpec): Popup {
		const colour = toNumber(GRADE_COLOURS[spec.grade]);
		const texture = this.ctx.textures.circleTexture(TICK_MISS_SIZE * TEXTURE_SCALE);
		const circle = new Sprite(texture);
		circle.anchor.set(0.5);
		circle.tint = colour;
		circle.blendMode = "add";

		const root = new Container();
		root.position.set(spec.x, spec.y);
		root.addChild(circle);

		const tracks = tickMissTracks(spec);
		return {
			view: root,
			update: (t) => {
				root.alpha = trackValueAt(tracks.alpha, t, 0);
				circle.scale.set((TICK_MISS_SIZE / texture.width) * this.scale * trackValueAt(tracks.scale, t, 1));
			}
		};
	}

	private buildResult(spec: JudgementSpec): Popup {
		const colour = toNumber(GRADE_COLOURS[spec.grade]);
		const root = new Container();
		root.position.set(spec.x, spec.y);
		root.scale.set(this.scale);

		// argonjudgementpiece.cs:46-54 -- additive, letter-spacing 5, bold 20px
		const text = new Text({
			text: spec.grade.toUpperCase(),
			style: {
				fontFamily: "Inter Variable",
				fontWeight: "700",
				fontSize: 20,
				letterSpacing: 5,
				fill: colour
			}
		});
		text.anchor.set(0.5);
		text.blendMode = "add";
		root.addChild(text);

		const rings: { sprite: Sprite; ring: RingSpec }[] = [];
		if (spec.grade !== "miss") {
			for (const ring of ringExplosion(spec.grade, spec.seed)) {
				const texture = this.ctx.textures.ringTexture(
					ring.size * TEXTURE_SCALE,
					RING_THICKNESS * TEXTURE_SCALE
				);
				const sprite = new Sprite(texture);
				sprite.anchor.set(0.5);
				sprite.tint = colour;
				sprite.blendMode = "add";
				sprite.scale.set(ring.size / texture.width);
				root.addChild(sprite);
				rings.push({ sprite, ring });
			}
		}

		const tracks = resultTracks(spec);
		return {
			view: root,
			update: (t) => {
				root.alpha = trackValueAt(tracks.containerAlpha, t, 0);
				text.alpha = trackValueAt(tracks.textAlpha, t, 0);
				const ts = trackValueAt(tracks.textScale, t, 1);
				const ms = spec.grade === "miss" ? trackValueAt(tracks.missScale, t, 1) : 1;
				text.scale.set(ts * ms);
				// missDrop/missRotate live on `root`, which is unscaled in its own
				// parent's space -- pre-multiply by this.scale so the offset lands
				// the same place a scaled child's local move would (root.scale only
				// covers root's *children*, not root's own position)
				root.y = spec.y + (spec.grade === "miss" ? trackValueAt(tracks.missDrop, t, 0) * this.scale : 0);
				root.angle = spec.grade === "miss" ? trackValueAt(tracks.missRotate, t, 0) : 0;
				const k = trackValueAt(tracks.ringMove, t, 0.3);
				const ra = trackValueAt(tracks.ringAlpha, t, 0);
				for (const { sprite, ring } of rings) {
					sprite.position.set(ring.dirX * ring.distance * k, ring.dirY * ring.distance * k);
					sprite.alpha = ra;
				}
			}
		};
	}

	update(t: number): void {
		// reconcileActiveDrawables guards against re-creating an index the map
		// already holds -- load-bearing on a backward seek, where the tracker's
		// rebuild reports a popup in `added` with no matching `removed` if it
		// was alive both before and after the seek (see playfield.ts). without
		// that guard the old popup's view/texture/rings stay orphaned as an
		// untracked child of this.view, frozen at its seek-instant alpha
		reconcileActiveDrawables(
			this.live,
			this.tracker.update(t),
			(index) => {
				const spec = this.specs[index];
				const popup = spec.style === "tickMiss" ? this.buildTickMiss(spec) : this.buildResult(spec);
				this.view.addChild(popup.view);
				return popup;
			},
			(popup) => popup.view.destroy({ children: true })
		);
		for (const popup of this.live.values()) popup.update(t);
	}

	destroy(): void {
		this.view.destroy({ children: true });
	}
}
