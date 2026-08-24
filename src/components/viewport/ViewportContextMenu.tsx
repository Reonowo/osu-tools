// the viewport's right-click surface: an overlay above the playfield (and
// below the floating chrome, which keeps its own clicks) whose contextmenu
// freezes the same context a gesture freezes -- the screen→osu!px inversion,
// the gesture base with every pending preview applied, and the trailing
// candidate window -- and asks the decision surface what the menu is. pixi
// is never consulted. mounted only in edit mode (Viewport.tsx): the menu is
// edit chrome, so watch mode has no trigger to reach

import { type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { EditContextMenu } from "@/components/EditContextMenu";
import { candidateWindow, selectionToDisplayed } from "@/editor/candidate-window";
import { frameEditGate } from "@/editor/gate";
import { gestureLive } from "@/editor/gesture-live";
import { HIT_THRESHOLD_SCREEN_PX } from "@/editor/gesture-controller";
import { gesturePreview, selectionToAuthoritative } from "@/editor/preview";
import { hitTestFrame } from "@/editor/selection-geometry";
import { viewportContextMenu, type EditMenuItem } from "@/lib/context-menu";
import { viewportPointToPlayfield, viewportTransform } from "@/renderer/playfield";
import { playbackClock } from "@/playback/instance";
import { effectiveOverlays } from "@/state/defaults";
import { viewerStore } from "@/state/store";

export function ViewportContextMenu({ containerRef }: { containerRef: RefObject<HTMLDivElement | null> }) {
	const resolve = (e: ReactMouseEvent<HTMLDivElement>): EditMenuItem[] | null => {
		const container = containerRef.current;
		if (container === null) return null;
		const state = viewerStore.getState();
		if (state.mode !== "edit") return null;
		const { scene, editor } = state;
		if (scene === null || editor === null) return null;
		// a live gesture owns the pointer: its frozen env and a menu's frozen
		// context cannot both stand, so mid-drag the right button does nothing
		if (gestureLive.active) return null;

		// the frozen inversion: the same screen→osu!px math a pointer-down
		// freezes, read once at the contextmenu instant
		const rect = container.getBoundingClientRect();
		const { viewportZoom, viewportPan } = state;
		const scale = viewportTransform(rect.width, rect.height, viewportZoom, viewportPan).scale;
		if (scale === 0) return null;
		const point = viewportPointToPlayfield(rect.width, rect.height, viewportZoom, viewportPan, {
			x: e.clientX - rect.left,
			y: e.clientY - rect.top
		});
		if (point === null) return null;

		// the gesture base and the shared candidate window: right-click obeys
		// the same hit rules as the selection tools, so only frames the
		// analysis overlay draws are targets
		const { frames, source } = gesturePreview.displayed(scene.frames);
		const displayLength = effectiveOverlays(state.overlays, state.mode).displayLength;
		const candidates = candidateWindow(frames, source, playbackClock.currentTime(), displayLength);
		const hit = hitTestFrame(frames, candidates, point, HIT_THRESHOLD_SCREEN_PX / scale);

		const plan = viewportContextMenu({
			hit,
			selection: selectionToDisplayed(editor.frameSelection, source),
			gate: frameEditGate(scene),
			hasLattice: editor.lattice !== null,
			keybinds: state.effectiveKeybinds
		});
		if (plan === null) return null;
		// the decision surface speaks displayed space; the shell owns the
		// translation back, exactly as the gesture shell does. selecting
		// never seeks
		if (plan.select !== null && plan.select.kind === "frames") {
			state.setFrameSelection(selectionToAuthoritative(plan.select.indices, source));
		}
		return plan.items;
	};

	return <EditContextMenu resolve={resolve} render={<div className="absolute inset-0" />} />;
}
