// the frame-editing gate: the play configuration's own answer, read off the
// scene so panels can disable with the reason in a tooltip instead of
// surfacing a rejected command. the backend's NotEditable carries the same
// string, because both read the same engine-authored field -- there is no
// version check and no second rule on this side

import type { LoadedScene } from "../lib/scene-types";

export type FrameEditGate = { editable: true } | { editable: false; reason: string };

export function frameEditGate(scene: LoadedScene): FrameEditGate {
	const capability = scene.configuration.capabilities.editFrames;
	return capability.allowed ? { editable: true } : { editable: false, reason: capability.reason };
}
