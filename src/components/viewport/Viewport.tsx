// the docked viewport: hosts the pixi playfield plus every viewport-scoped
// overlay -- watch mode's hud, the zoom cluster, and edit mode's tool
// palette and coordinate readout. the overlays implement themselves; what
// this file owns beyond composition is the framing gestures, because they are
// the only thing that needs the host box in css pixels. all of their maths is
// pure and lives in renderer/playfield.ts -- this is the dom half (the edit
// tools' dom half lives next door in use-edit-tools.ts)

import { useEffect, useRef } from "react";
import { PlayerView } from "@/components/PlayerView";
import { spacePan } from "@/playback/space-pan";
import {
	anchoredZoomPan,
	clampViewportPan,
	clampViewportZoom,
	NO_VIEWPORT_PAN,
	steppedViewportZoom,
	wheelZoomFactor,
	type ViewportPan
} from "@/renderer/playfield";
import { useViewerStore, viewerStore } from "@/state/store";
import { CoordinateReadout, ToolPalette } from "./ToolPalette";
import { useEditTools } from "./use-edit-tools";
import { WatchHud } from "./WatchHud";
import { ZoomControls } from "./ZoomControls";

export function Viewport() {
	const mode = useViewerStore((s) => s.mode);
	const containerRef = useRef<HTMLDivElement>(null);

	// the cursor-path tools: pointer capture and event translation only; the
	// decisions live in editor/gesture-controller.ts. left-drags reach it only
	// while space is not arming a pan, so navigating and editing never fight
	useEditTools(containerRef);

	useEffect(() => {
		const container = containerRef.current;
		if (container === null) return;

		// the pointer position and the pan a drag started from; re-read on every
		// pointerdown, so these initialisers are only ever placeholders
		let dragPointer: number | null = null;
		let originX = 0;
		let originY = 0;
		let originPan: ViewportPan = NO_VIEWPORT_PAN;

		// arrow consts rather than function declarations: a hoisted declaration
		// is checked against the flow state at the top of the block, where
		// `container` is still nullable
		const applyCursor = () => {
			if (dragPointer !== null) container.style.cursor = "grabbing";
			else container.style.cursor = spacePan.armed ? "grab" : "";
		};

		// non-passive and element-scoped, unlike the global frame-stepping wheel
		// listener: ctrl+wheel is the webview's own page zoom, which App.tsx
		// also suppresses app-wide -- the preventDefault here predates that and
		// stays so this element's zoom never depends on a listener elsewhere
		const onWheel = (e: WheelEvent) => {
			if (!e.ctrlKey) return;
			e.preventDefault();
			const rect = container.getBoundingClientRect();
			const { viewportZoom, viewportPan, setViewportZoom } = viewerStore.getState();
			const nextZoom = clampViewportZoom(viewportZoom * wheelZoomFactor(e.deltaY, e.deltaMode));
			const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
			const pan = anchoredZoomPan(rect.width, rect.height, viewportZoom, viewportPan, nextZoom, anchor);
			setViewportZoom(nextZoom, clampViewportPan(rect.width, rect.height, nextZoom, pan));
		};

		const onPointerDown = (e: PointerEvent) => {
			if (dragPointer !== null) return;
			// middle-drag always pans; left-drag only while space arms it, so an
			// ordinary left-click stays available to the edit tools
			if (e.button !== 1 && !(e.button === 0 && spacePan.armed)) return;
			// suppresses the text selection a drag would otherwise start, and the
			// middle-click autoscroll the compatibility mouse events would
			e.preventDefault();
			dragPointer = e.pointerId;
			originX = e.clientX;
			originY = e.clientY;
			originPan = viewerStore.getState().viewportPan;
			container.setPointerCapture(e.pointerId);
			applyCursor();
		};

		const onPointerMove = (e: PointerEvent) => {
			if (e.pointerId !== dragPointer) return;
			const dx = e.clientX - originX;
			const dy = e.clientY - originY;
			// a press that never moved is not a drag, so a space-tap that happened
			// to land on the viewport still toggles playback on release
			if (dx === 0 && dy === 0) return;
			spacePan.noteDrag();
			const rect = container.getBoundingClientRect();
			const { viewportZoom, panViewport } = viewerStore.getState();
			// against the pan the drag started from rather than the last frame's:
			// accumulating deltas would let a drag held past the clamp lose the
			// overshoot and stop tracking the pointer on the way back
			const target = { x: originPan.x + dx, y: originPan.y + dy };
			panViewport(clampViewportPan(rect.width, rect.height, viewportZoom, target));
		};

		// a space keyup delivered to another window never reaches this document,
		// so without this the arm latch sticks: the viewport would keep its grab
		// cursor and plain left-drags would pan with no space held
		const onBlur = () => spacePan.cancel();

		// every gesture above clamps against the host box as it stood when it
		// ran, so shrinking that box -- a window resize, or the side panel
		// opening -- leaves the stored pan outside the bounds it was valid for.
		// the renderer re-clamps what it draws, but the authoritative pan has to
		// follow it: a drag starting from an out-of-range origin sticks against
		// the edge until the pointer works off the overshoot, and a
		// pointer-anchored zoom computes from a position that is not the one on
		// screen and so jumps
		const resizeObserver = new ResizeObserver(() => {
			const { viewportZoom, viewportPan, panViewport } = viewerStore.getState();
			const clamped = clampViewportPan(container.clientWidth, container.clientHeight, viewportZoom, viewportPan);
			if (clamped.x !== viewportPan.x || clamped.y !== viewportPan.y) panViewport(clamped);
		});
		resizeObserver.observe(container);

		const onPointerEnd = (e: PointerEvent) => {
			if (e.pointerId !== dragPointer) return;
			dragPointer = null;
			if (container.hasPointerCapture(e.pointerId)) container.releasePointerCapture(e.pointerId);
			applyCursor();
		};

		container.addEventListener("wheel", onWheel, { passive: false });
		container.addEventListener("pointerdown", onPointerDown);
		container.addEventListener("pointermove", onPointerMove);
		container.addEventListener("pointerup", onPointerEnd);
		container.addEventListener("pointercancel", onPointerEnd);
		window.addEventListener("blur", onBlur);
		const unsubscribe = spacePan.subscribe(applyCursor);
		return () => {
			container.removeEventListener("wheel", onWheel);
			container.removeEventListener("pointerdown", onPointerDown);
			container.removeEventListener("pointermove", onPointerMove);
			container.removeEventListener("pointerup", onPointerEnd);
			container.removeEventListener("pointercancel", onPointerEnd);
			window.removeEventListener("blur", onBlur);
			resizeObserver.disconnect();
			unsubscribe();
		};
	}, []);

	// the +/- buttons re-clamp the pan against the zoom they land on, so
	// stepping back down to 100% recentres instead of leaving the playfield
	// stranded wherever a 400% pan had pushed it
	function stepZoom(direction: 1 | -1) {
		const container = containerRef.current;
		if (container === null) return;
		const { viewportZoom, viewportPan, setViewportZoom } = viewerStore.getState();
		const nextZoom = steppedViewportZoom(viewportZoom, direction);
		setViewportZoom(
			nextZoom,
			clampViewportPan(container.clientWidth, container.clientHeight, nextZoom, viewportPan)
		);
	}

	return (
		<div ref={containerRef} className="relative min-w-0 flex-1 overflow-hidden bg-surface-viewport">
			<PlayerView />
			<WatchHud />
			<ZoomControls onStep={stepZoom} />
			{mode === "edit" && (
				<>
					<ToolPalette />
					<CoordinateReadout />
				</>
			)}
		</div>
	);
}
