// pixi applier for the replay analysis overlays (cursor path, frame markers,
// click markers). citations: replayanalysisoverlay.cs (window/spawn rules),
// analysisframeentry.cs (lifetime = [time, time + displaylength)),
// analysismarker.cs (depth = -lifetimeend -- newer draws above older),
// clickmarker.cs / framemarker.cs (marker geometry+colour),
// cursorpathcontainer.cs (path radius/colour), osucolour.cs (hex values).
// all pinned to ppy/osu@83b8a64bec19e1463353645c2d6d10c75e275b43

import { Container, Graphics, Sprite, type Texture } from "pixi.js";
import { previewedPathPoints, snapshotIsEmpty, type PlayfieldPoint, type PreviewSnapshot } from "../../editor/preview";
import { isLeft, isRight } from "../../engine/buttons";
import { cursorStateAt, type Press } from "../../engine/interpolation";
import type { FrameDto } from "../../lib/scene-types";
import { countAtOrBefore } from "../../lib/timeline";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";

/** indices alive at t under the [time, time + displayLength) lifetime */
export function aliveWindow(times: number[], t: number, displayLength: number): { lo: number; hi: number } {
	return { lo: countAtOrBefore(times, t - displayLength), hi: countAtOrBefore(times, t) };
}

/** the authoritative cursor-path polyline for the window frames[lo..hi),
 * ending at the interpolated cursor sample for t itself rather than at the
 * newest whole frame. deliberate divergence from cursorpathcontainer.cs,
 * whose path stops at the last frame's position: in motion the missing
 * sub-frame segment is invisible, but a seek landing between frames (a
 * timeline click, an object double-click) leaves the path visibly detached
 * from the cursor the renderer draws -- and a paused viewer stares at that
 * gap until a frame step happens to land t exactly on a frame. the tail
 * keeps lazer's expiry untouched; only the head is extended, by exactly the
 * segment the cursor is mid-way along */
export function cursorPathPoints(frames: FrameDto[], lo: number, hi: number, t: number): PlayfieldPoint[] {
	if (hi <= lo) return [];
	const points: PlayfieldPoint[] = [];
	for (let i = lo; i < hi; i++) points.push({ x: frames[i].x, y: frames[i].y });
	const head = cursorStateAt(frames, t);
	const newest = points[points.length - 1];
	// a frame-exact t (a frame step, playback resting on a frame) resolves to
	// the newest frame's own position, where appending would only stack a
	// zero-length segment on the path's head
	if (head !== null && (head.x !== newest.x || head.y !== newest.y)) points.push({ x: head.x, y: head.y });
	return points;
}

/** the marker footprint every stroke below is written against
 * (clickmarker.cs's 16px box), in osu!px; the sprite's own width/height
 * rescales it to its final on-screen size */
const MARKER_SIZE = 16;
/** the canvas those strokes were originally measured on, back when the bake
 * was a fixed 2x. keeping the constants in that frame and scaling by `s`
 * leaves every number below directly comparable with its citation */
const MARKER_REFERENCE_CANVAS = MARKER_SIZE * 2;

/** ~65% brightness: multiplied onto the idle marker's pink2 it lands on
 * #992e5e, dark enough to read against the path's #eb4791 while staying in
 * its palette. a tint rather than a texture variant, so the cache keeps one
 * idle texture and the pref flips for free */
const IDLE_MARKER_TINT = 0xa6a6a6;

// marker textures: sizes/colours from clickmarker.cs:27-77 /
// framemarker.cs:25-63 / cursorpathcontainer.cs:24,30 -- gray5 #555 (osucolour.cs:388),
// gray4 #444 (osucolour.cs:387), pink2 #eb4791 (osucolour.cs:411), yellow
// #ffcc22 (osucolour.cs:331), half-arcs progress 0.5
function markerTexture(ctx: RenderContext, kind: string): Texture {
	return ctx.textures.canvasTexture(MARKER_SIZE, `analysis:${kind}`, (c, size) => {
		const s = size / MARKER_REFERENCE_CANVAS;
		const half = size / 2;
		const arc = (side: "left" | "right", inner: number, outer: number) => {
			c.fillStyle = "#ffcc22";
			c.beginPath();
			const from = side === "left" ? Math.PI / 2 : -Math.PI / 2;
			c.arc(half, half, outer * s, from, from + Math.PI);
			c.arc(half, half, inner * s, from + Math.PI, from, true);
			c.fill();
		};
		if (kind.startsWith("click")) {
			// clickmarker.cs:27-77 -- 16px marker box, so the reference canvas'
			// half (16) stands in for its full radius. centre dot: Size(0.125)
			// additive gray5
			c.fillStyle = "#555";
			c.beginPath();
			c.arc(half, half, 2 * s, 0, Math.PI * 2);
			c.fill();
			// white ring: circularcontainer border, 2.2px thickness
			c.strokeStyle = "#fff";
			c.lineWidth = 4.4 * s;
			c.beginPath();
			c.arc(half, half, 13.8 * s, 0, Math.PI * 2);
			c.stroke();
			// half-arc: Size(0.95) -> outer = 0.95*16 = 15.2; circularprogressdrawnode.cs:157-158
			// derives inner = outer*(1 - InnerRadius), InnerRadius(0.18) -> 15.2*0.82 = 12.464
			arc(kind === "click-left" ? "left" : "right", 12.464, 15.2);
		} else {
			const held = kind !== "frame-none";
			c.fillStyle = held ? "#444" : "#eb4791";
			c.beginPath();
			c.arc(half, half, half - 2 * s, 0, Math.PI * 2);
			c.fill();
			// half-arc: Size(0.8) -> outer = 0.8*16 = 12.8; InnerRadius(0.5) is its
			// own fixed point under the same formula -- inner = 12.8*0.5 = 6.4
			if (kind === "frame-left" || kind === "frame-both") arc("left", 6.4, 12.8);
			if (kind === "frame-right" || kind === "frame-both") arc("right", 6.4, 12.8);
		}
	});
}

export class AnalysisDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly path = new Graphics();
	private readonly frameLayer = new Container();
	private readonly clickLayer = new Container();
	private readonly frames: FrameDto[];
	private readonly frameTimes: number[];
	private readonly presses: Press[];
	private readonly pressTimes: number[];
	private readonly framePool = new Map<number, Sprite>();
	private readonly clickPool = new Map<number, Sprite>();
	/** markers for pending boundary frames; rebuilt while an erase previews */
	private readonly insertedLayer = new Container();
	/** pooled marker positions were overridden by a preview and need one
	 * restore pass when the preview ends */
	private markersPreviewed = false;
	/** the tint pref the pooled markers were last styled under; null forces
	 * the first update through the restyle pass */
	private lastTintIdleMarkers: boolean | null = null;

	constructor(private readonly ctx: RenderContext) {
		this.frames = ctx.scene.frames;
		this.frameTimes = this.frames.map((f) => f.time);
		this.presses = ctx.derived.presses;
		this.pressTimes = this.presses.map((p) => p.time);
		// newer markers draw above older (analysismarker.cs:25 -- depth = -lifetimeend)
		this.frameLayer.sortableChildren = true;
		this.clickLayer.sortableChildren = true;
		this.view.addChild(this.path, this.frameLayer, this.insertedLayer, this.clickLayer);
		ctx.layers.analysis.addChild(this.view);
	}

	/** the buttons-derived half of a frame marker's look, applied at spawn and
	 * re-applied while a preview rewrites a survivor's pattern */
	private applyMarkerStyle(sprite: Sprite, buttons: number): void {
		const left = isLeft(buttons);
		const right = isRight(buttons);
		const variant = left && right ? "frame-both" : left ? "frame-left" : right ? "frame-right" : "frame-none";
		sprite.texture = markerTexture(this.ctx, variant);
		// framemarker.cs:61 -- 4px held, 2.5px idle
		sprite.width = sprite.height = left || right ? 4 : 2.5;
		// deliberate divergence behind a default-off pref: framemarker.cs paints
		// an idle marker the same pink2 as the path, so it vanishes into the line
		sprite.tint = variant === "frame-none" && this.ctx.getOverlays().tintIdleMarkers ? IDLE_MARKER_TINT : 0xffffff;
	}

	private markerSpriteFor(frame: FrameDto): Sprite {
		const sprite = new Sprite();
		sprite.anchor.set(0.5);
		this.applyMarkerStyle(sprite, frame.buttons);
		sprite.position.set(frame.x, frame.y);
		sprite.zIndex = frame.time;
		return sprite;
	}

	private clickSprite(index: number): Sprite {
		const press = this.presses[index];
		const frame = this.frames[press.frameIndex];
		const sprite = new Sprite(markerTexture(this.ctx, press.action === "left" ? "click-left" : "click-right"));
		sprite.anchor.set(0.5);
		sprite.width = sprite.height = 16;
		sprite.position.set(frame.x, frame.y);
		sprite.zIndex = press.time;
		return sprite;
	}

	/** hard-window pooling: create on entering [lo, hi), destroy on leaving.
	 * aliveWindow is recomputed fresh from the raw time array every call, so
	 * this is idempotent under seeking in either direction -- there is no
	 * persistent "was this dead before" state for a stale window to resurrect */
	private syncPool(
		pool: Map<number, Sprite>,
		layer: Container,
		times: number[],
		t: number,
		length: number,
		make: (index: number) => Sprite
	): void {
		const { lo, hi } = aliveWindow(times, t, length);
		for (const [index, sprite] of pool) {
			if (index < lo || index >= hi) {
				sprite.destroy();
				pool.delete(index);
			}
		}
		for (let i = lo; i < hi; i++) {
			if (!pool.has(i)) {
				const sprite = make(i);
				layer.addChild(sprite);
				pool.set(i, sprite);
			}
		}
	}

	update(t: number): void {
		const overlays = this.ctx.getOverlays();
		this.path.visible = overlays.cursorPath;
		this.frameLayer.visible = overlays.frameMarkers;
		this.insertedLayer.visible = overlays.frameMarkers;
		this.clickLayer.visible = overlays.clickMarkers;
		const length = overlays.displayLength;

		// the gesture preview reaches the path and frame markers here: edit
		// chrome previews, and this window *is* what the tools operate on.
		// click markers stay authoritative -- presses are preserved by the
		// hybrid rule, not previewed
		const snapshot = this.ctx.getEditChrome()?.preview() ?? null;
		const previewing = snapshot !== null && !snapshotIsEmpty(snapshot);

		if (overlays.cursorPath) {
			const { lo, hi } = aliveWindow(this.frameTimes, t, length);
			this.path.clear();
			// the preview path deliberately keeps its frame-vertex head: a live
			// gesture previews the frames, not the cursor drawable, and grafting
			// the authoritative interpolated sample onto previewed geometry would
			// streak a line to a cursor the preview is intentionally not moving
			const points = previewing
				? previewedPathPoints(this.frames, lo, hi, snapshot, t - length, t)
				: cursorPathPoints(this.frames, lo, hi, t);
			if (points.length >= 2) {
				this.path.moveTo(points[0].x, points[0].y);
				for (let i = 1; i < points.length; i++) this.path.lineTo(points[i].x, points[i].y);
				// cursorpathcontainer.cs:24,30 -- pathradius 1 (2px total width), pink2
				this.path.stroke({ width: 2, color: 0xeb4791, join: "round", cap: "round" });
			}
		}
		if (overlays.frameMarkers) {
			this.syncPool(this.framePool, this.frameLayer, this.frameTimes, t, length, (i) =>
				this.markerSpriteFor(this.frames[i])
			);
			// a tint pref flip restyles the survivors: syncPool styles only the
			// sprites it spawns, and a paused player would otherwise show both
			// looks at once until the window churned them out
			if (overlays.tintIdleMarkers !== this.lastTintIdleMarkers) {
				this.lastTintIdleMarkers = overlays.tintIdleMarkers;
				for (const [index, sprite] of this.framePool) this.applyMarkerStyle(sprite, this.frames[index].buttons);
			}
			this.applyMarkerPreview(previewing ? snapshot : null, t - length, t);
		}
		if (overlays.clickMarkers)
			this.syncPool(this.clickPool, this.clickLayer, this.pressTimes, t, length, (i) => this.clickSprite(i));
	}

	/** overrides pooled marker positions from the preview (hidden frames go
	 * invisible, moved frames follow their previewed positions) and draws
	 * markers for pending boundary frames. a null snapshot restores the pool
	 * to authoritative positions -- once, flagged, since restoring is only
	 * needed after a preview actually touched them */
	private applyMarkerPreview(snapshot: PreviewSnapshot | null, windowStart: number, windowEnd: number): void {
		if (snapshot === null) {
			if (this.markersPreviewed) {
				this.markersPreviewed = false;
				for (const [index, sprite] of this.framePool) {
					const frame = this.frames[index];
					sprite.visible = true;
					sprite.position.set(frame.x, frame.y);
					this.applyMarkerStyle(sprite, frame.buttons);
				}
				this.clearInsertedMarkers();
			}
			return;
		}
		this.markersPreviewed = true;
		for (const [index, sprite] of this.framePool) {
			if (snapshot.hidden.has(index)) {
				sprite.visible = false;
				continue;
			}
			sprite.visible = true;
			const override = snapshot.moved.get(index);
			const frame = this.frames[index];
			sprite.position.set(override?.x ?? frame.x, override?.y ?? frame.y);
			this.applyMarkerStyle(sprite, snapshot.buttons.get(index) ?? frame.buttons);
		}
		// boundary frames are few (one per preserved press edge), so rebuilding
		// their sprites each frame while a preview is live costs less than
		// tracking staleness across epoch, window, and discard paths
		this.clearInsertedMarkers();
		for (const frame of snapshot.inserted) {
			if (frame.time <= windowStart || frame.time > windowEnd) continue;
			this.insertedLayer.addChild(this.markerSpriteFor(frame));
		}
	}

	private clearInsertedMarkers(): void {
		for (const sprite of this.insertedLayer.removeChildren()) sprite.destroy();
	}

	destroy(): void {
		// this.path is a raw Graphics with its own GraphicsContext, which a
		// {children:true} cascade alone does not free (Graphics.destroy() in
		// pixi's scene/graphics/shared/Graphics.js only calls context.destroy()
		// when explicitly told to) -- context:true releases it alongside every
		// pooled sprite (still a plain Sprite over a cached texture, so this
		// does not, and must not, touch textures.ts's cache)
		this.view.destroy({ children: true, context: true });
	}
}
