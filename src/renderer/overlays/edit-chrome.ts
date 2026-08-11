// the edit chrome: viewport visuals that exist only in edit mode -- the
// frame-selection highlight (enlarged cyan markers plus a thin time-ordered
// connecting outline), the marquee/lasso drag shapes, and the brush ring.
// cyan is the established editor-state accent (the tool palette's snap tile,
// the coordinate readout's on-lattice tint). everything reads through
// ctx.getEditChrome() live getters; watch mode wires them to null and the
// chrome vanishes without a scene rebuild

import { Container, Graphics } from "pixi.js";
import type { PlayfieldPoint } from "../../editor/preview";
import type { ObjectDrawable, RenderContext } from "../GameplayRenderer";

const CYAN = 0x66ccff;
/** slightly enlarged over the analysis frame markers (2.5/4 osu!px wide) */
const SELECTED_MARKER_RADIUS = 2.75;
const OUTLINE_WIDTH = 0.75;
const DASH_LENGTH = 3;
const GAP_LENGTH = 2;

/** manual dashes -- pixi's stroke has no dash pattern. walks the polyline
 * alternating pen-down/pen-up runs of DASH_LENGTH/GAP_LENGTH osu!px */
function drawDashedPolyline(g: Graphics, points: readonly PlayfieldPoint[], close: boolean): void {
	if (points.length < 2) return;
	const vertices = close ? [...points, points[0]] : points;
	let penDown = true;
	let remaining = DASH_LENGTH;
	g.moveTo(vertices[0].x, vertices[0].y);
	for (let i = 1; i < vertices.length; i++) {
		let from = vertices[i - 1];
		const to = vertices[i];
		let segment = Math.hypot(to.x - from.x, to.y - from.y);
		while (segment > remaining) {
			const t = remaining / segment;
			const cut = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
			if (penDown) g.lineTo(cut.x, cut.y);
			else g.moveTo(cut.x, cut.y);
			penDown = !penDown;
			remaining = penDown ? DASH_LENGTH : GAP_LENGTH;
			segment -= segment * t;
			from = cut;
		}
		remaining -= segment;
		if (penDown) g.lineTo(to.x, to.y);
		else g.moveTo(to.x, to.y);
	}
	g.stroke({ width: OUTLINE_WIDTH, color: CYAN, alpha: 0.9 });
}

export class EditChromeDrawable implements ObjectDrawable {
	readonly view = new Container();
	private readonly outline = new Graphics();
	private readonly markers = new Graphics();
	private readonly shape = new Graphics();
	/** topmost within the chrome, per the spec's layering rule */
	private readonly brush = new Graphics();
	private lastSelection: readonly number[] | null = null;
	private lastPreviewEpoch = -1;

	constructor(private readonly ctx: RenderContext) {
		this.view.addChild(this.outline, this.markers, this.shape, this.brush);
		ctx.layers.editChrome.addChild(this.view);
	}

	update(): void {
		const sources = this.ctx.getEditChrome();
		if (sources === null) {
			if (this.lastSelection !== null || this.lastPreviewEpoch !== -1) {
				this.outline.clear();
				this.markers.clear();
				this.lastSelection = null;
				this.lastPreviewEpoch = -1;
			}
			this.shape.clear();
			this.brush.clear();
			return;
		}

		const selection = sources.selection();
		const preview = sources.preview();
		if (selection !== this.lastSelection || preview.epoch !== this.lastPreviewEpoch) {
			this.lastSelection = selection;
			this.lastPreviewEpoch = preview.epoch;
			this.redrawSelection(selection);
		}

		// the shape and ring follow the pointer, so they redraw per frame while
		// present -- each is a handful of segments, nothing worth dirty-tracking
		this.shape.clear();
		const shape = sources.shape();
		if (shape !== null) {
			if (shape.kind === "marquee") {
				const { a, b } = shape;
				drawDashedPolyline(
					this.shape,
					[
						{ x: a.x, y: a.y },
						{ x: b.x, y: a.y },
						{ x: b.x, y: b.y },
						{ x: a.x, y: b.y }
					],
					true
				);
			} else {
				drawDashedPolyline(this.shape, shape.points, false);
			}
		}

		this.brush.clear();
		const ring = sources.brush();
		if (ring !== null) {
			// a soft white ring: a faint wide stroke under a crisp narrow one
			this.brush.circle(ring.x, ring.y, ring.radius).stroke({ width: 2.5, color: 0xffffff, alpha: 0.18 });
			this.brush.circle(ring.x, ring.y, ring.radius).stroke({ width: 1, color: 0xffffff, alpha: 0.8 });
		}
	}

	/** the selection highlight over displayed positions: pending previews move
	 * a marker with its frame, and a frame pending deletion drops out.
	 * deliberately NOT limited to the candidate window: the panel ops and
	 * Delete act on the whole selection, so the chrome must show everything
	 * the next operation will touch -- the window only bounds what selection
	 * gestures can grab */
	private redrawSelection(selection: readonly number[]): void {
		const sources = this.ctx.getEditChrome();
		const preview = sources?.preview();
		const frames = this.ctx.scene.frames;
		this.outline.clear();
		this.markers.clear();
		if (preview === undefined || selection.length === 0) return;

		const points: PlayfieldPoint[] = [];
		for (const index of selection) {
			const frame = frames[index];
			if (frame === undefined || preview.hidden.has(index)) continue;
			points.push(preview.moved.get(index) ?? { x: frame.x, y: frame.y });
		}
		if (points.length >= 2) {
			this.outline.moveTo(points[0].x, points[0].y);
			for (let i = 1; i < points.length; i++) this.outline.lineTo(points[i].x, points[i].y);
			this.outline.stroke({ width: OUTLINE_WIDTH, color: CYAN, alpha: 0.55 });
		}
		for (const point of points) {
			this.markers.circle(point.x, point.y, SELECTED_MARKER_RADIUS).fill({ color: CYAN, alpha: 0.95 });
		}
	}

	destroy(): void {
		// raw Graphics own their GraphicsContexts; context:true releases them
		// (same reasoning as AnalysisDrawable.destroy)
		this.view.destroy({ children: true, context: true });
	}
}
