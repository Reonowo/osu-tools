// the frame-editing gate, mirrored from the backend's NotEditable rules so
// panels can disable with the reason in a tooltip instead of surfacing a
// rejected command

import type { LoadedScene } from "../lib/scene-types";

/** legacyscoreencoder.cs:74 -- the first lazer-native replay version */
export const FIRST_LAZER_VERSION = 30_000_000;

export type FrameEditGate = { editable: true } | { editable: false; reason: string };

export function frameEditGate(scene: LoadedScene): FrameEditGate {
	if (scene.simulation.status !== "authoritative") {
		return {
			editable: false,
			reason: "this replay was not simulated, so frame and keypress edits cannot re-derive its results"
		};
	}
	if (scene.replay.version >= FIRST_LAZER_VERSION) {
		return {
			editable: false,
			reason: "lazer-native replays would re-derive their header under the wrong rules profile; metadata editing stays available"
		};
	}
	return { editable: true };
}
