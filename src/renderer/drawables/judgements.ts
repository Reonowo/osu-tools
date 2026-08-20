// pixi applier for judgement popups: builds the pieces judgement-tracks.ts's
// pure specs name and copies track values every frame. no timing logic lives
// here (decision 4) -- see judgement-tracks.ts for the animation math and its
// citations.
//
// three popups, one drawable: argon's grade text, argon's tick-miss dot, and a
// legacy skin's own grade texture. which of them a result gets is decided by
// `skin/pieces.ts` and read off the spec; nothing here re-decides it.
//
// hit lighting rides along with the popup rather than being its own drawable,
// which is lazer's own arrangement (drawableosujudgement.cs:29-36 adds it as a
// child of the judgement). it is behind the hit-effects preference like every
// other popup here, and independent of the show-300s one: a great lights its
// object whether or not it pops a "300"

import { Container, Sprite, Text } from "pixi.js";
import {
	HIT_LIGHTING_END_SCALE,
	HIT_LIGHTING_FADE_IN,
	HIT_LIGHTING_FADE_OUT,
	HIT_LIGHTING_HOLD,
	HIT_LIGHTING_SCALE_DURATION,
	HIT_LIGHTING_START_SCALE
} from "@/skin/legacy/constants";
import { toNumber } from "../../engine/color";
import { out } from "../../engine/easing";
import { trackValueAt, tween, type Track } from "../../engine/transforms";
import { ActiveSetTracker, reconcileActiveDrawables } from "../playfield";
import { SkinSprite } from "../skin-sprite";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";
import {
	GRADE_COLOURS,
	judgementSpecs,
	legacyJudgementTracks,
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

interface Popup {
	view: Container;
	update(t: number): void;
}

/** a spec that draws no popup of its own -- the lighting alone. the container
 * still exists so the lighting has a parent to hang from */
function emptyPopup(spec: JudgementSpec): Popup {
	const root = new Container();
	root.position.set(spec.x, spec.y);
	return { view: root, update: () => {} };
}

export class JudgementsDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly specs: JudgementSpec[];
	private readonly tracker: ActiveSetTracker;
	private readonly live = new Map<number, Popup>();
	private readonly scale: number;

	constructor(private readonly ctx: RenderContext) {
		this.specs = judgementSpecs(ctx.scene, ctx.pieces, ctx.accents);
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
		const texture = this.ctx.textures.circleTexture(TICK_MISS_SIZE);
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
				const texture = this.ctx.textures.ringTexture(ring.size, RING_THICKNESS);
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

	/** the popup the ACTIVE SKIN answered with, plus the lighting that rides
	 * behind it. the two are assembled together because lazer assembles them
	 * together, and because a spec can carry one without the other */
	private buildPopup(spec: JudgementSpec): Popup {
		const popup =
			spec.piece.kind === "textured"
				? this.buildLegacy(spec)
				: spec.piece.kind === "procedural" && spec.piece.style === "tickMiss"
					? this.buildTickMiss(spec)
					: spec.piece.kind === "procedural"
						? this.buildResult(spec)
						: emptyPopup(spec);
		if (!spec.lighting) return popup;
		const lighting = this.buildLighting(spec);
		// a SIBLING, not a child: both roots are positioned in playfield space
		// and the popup's own root also carries the object's scale, so nesting
		// the light inside it would offset and scale it twice over. depth
		// float.MaxValue in source, which is this order -- the light first, so
		// it sits behind the popup
		const root = new Container();
		root.addChild(lighting.view, popup.view);
		return {
			view: root,
			update: (t) => {
				popup.update(t);
				lighting.update(t);
			}
		};
	}

	/**
	 * drawableosujudgement.cs:73-87 -- the skin's `lighting` sprite, scaled
	 * 0.8 -> 1.2 over 600 and faded in over 200, held 200, then out over 1000.
	 *
	 * tinted with the OBJECT's accent (skinnablelighting.cs:46), which is why
	 * the spec carries one: the light is the colour of the thing that was hit,
	 * not of the grade it earned
	 */
	private buildLighting(spec: JudgementSpec): Popup {
		const sprite = new SkinSprite(this.ctx.skinTexture, this.ctx.pieces.hitLighting);
		sprite.drawable.tint = toNumber(spec.accent);
		sprite.drawable.blendMode = "add";
		const root = new Container();
		root.position.set(spec.x, spec.y);
		root.scale.set(this.scale);
		root.addChild(sprite.view);
		const alpha: Track[] = [
			tween(spec.time, HIT_LIGHTING_FADE_IN, 0, 1),
			tween(spec.time + HIT_LIGHTING_FADE_IN + HIT_LIGHTING_HOLD, HIT_LIGHTING_FADE_OUT, 1, 0)
		];
		const scale: Track[] = [
			tween(spec.time, HIT_LIGHTING_SCALE_DURATION, HIT_LIGHTING_START_SCALE, HIT_LIGHTING_END_SCALE, out)
		];
		return {
			view: root,
			update: (t) => {
				root.alpha = trackValueAt(alpha, t, 0);
				sprite.view.scale.set(trackValueAt(scale, t, HIT_LIGHTING_START_SCALE));
			}
		};
	}

	/** legacyjudgementpieceold.cs -- the skin's own grade texture, under one
	 * fade envelope and (unless the skin animated it itself) the era's own pop */
	private buildLegacy(spec: JudgementSpec): Popup {
		const sprite = new SkinSprite(this.ctx.skinTexture, spec.piece);
		const root = new Container();
		root.position.set(spec.x, spec.y);
		const tracks = legacyJudgementTracks(spec, {
			animated: sprite.animated,
			// a large tick's miss is the one "missed tick" this ruleset draws
			missedTick: spec.grade === "miss" && spec.piece.kind === "textured" && spec.piece.texture.name !== "hit0",
			skinVersion: this.ctx.skin.config.version
		});
		root.addChild(sprite.view);
		return {
			view: root,
			update: (t) => {
				root.alpha = trackValueAt(tracks.alpha, t, 0);
				// the popup is drawn at the object's own cs scale, exactly as
				// drawableosujudgement.cs:59 sets `Scale = HitObject.Scale`
				root.scale.set(this.scale * trackValueAt(tracks.scale, t, 1));
				root.y = spec.y + trackValueAt(tracks.moveY, t, 0) * this.scale;
				root.angle = trackValueAt(tracks.rotate, t, 0);
				sprite.setElapsed(t - spec.time);
			}
		};
	}

	update(t: number): void {
		// the hitEffects toggle covers everything this drawable builds -- the
		// judgement text, the ring explosion and the tick-miss piece. a pure
		// visibility flip, so the popups it hides stay live and correct for the
		// instant it is turned back on (AnalysisDrawable's precedent)
		this.view.visible = this.ctx.getEffects().hitEffects;
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
				const popup = this.buildPopup(spec);
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
