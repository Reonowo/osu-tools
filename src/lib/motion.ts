// interface motion's whole decision surface, pure: what the tri-state master
// resolves to, how the segmented control's three labels map onto the stored
// preference, and what the root attribute the styles read carries.
//
// interface motion is the APP CHROME's own animation — the combo counter's
// pop, the dialogs' enter and exit, the shell's hover transitions. never the
// playfield's gameplay effects, which have their own master, and never the HP
// bar's damp, which is a reading of the play rather than motion of the chrome
// (`CONTEXT.md`)

import type { ViewerState } from "@/state/store";

/** the master as it persists: an explicit choice, or `null` for "follow the
 * OS". stored unresolved on purpose — resolving it at write time would freeze
 * whatever the OS said that moment */
export type MotionPreference = boolean | null;

/** the three states the segmented control shows */
export type MotionChoice = "system" | "on" | "off";

/** whether app-chrome motion runs: an explicit choice wins, and an unset one
 * follows the OS's reduce-motion query — which the app root tracks live, so a
 * user flipping the system setting sees the app follow without a restart */
export function effectiveMotion(pref: MotionPreference, osReducesMotion: boolean): boolean {
	if (pref !== null) return pref;
	return !osReducesMotion;
}

/** which segment is selected for a stored preference */
export function motionChoice(pref: MotionPreference): MotionChoice {
	if (pref === null) return "system";
	return pref ? "on" : "off";
}

/** what a segment stores. the inverse of motionChoice, so the control round
 * trips: picking the segment a preference shows leaves it unchanged */
export function motionPreference(choice: MotionChoice): MotionPreference {
	if (choice === "system") return null;
	return choice === "on";
}

/** the value `data-motion` carries on `<html>`. one attribute rather than a
 * class per animation: every existing Tailwind transition and animation site
 * is covered by one rule in `index.css` reading this, so a future animation
 * opts in by class rather than by having a prop plumbed to it */
export function motionAttribute(enabled: boolean): "on" | "off" {
	return enabled ? "on" : "off";
}

/** the effective flag off the store, for the JS-driven animations that cannot
 * read a css attribute — the watch HUD's combo pop is the first. a plain
 * boolean, so useSyncExternalStore compares it by value and the selector is
 * safe to pass inline */
export const selectMotion = (s: ViewerState): boolean => effectiveMotion(s.interface.motion, s.osReducesMotion);
