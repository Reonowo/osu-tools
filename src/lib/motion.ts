// interface motion's whole decision surface, pure: what the tri-state master
// resolves to, how the segmented control's three labels map onto the stored
// preference, and what the root attribute the styles read carries.
//
// interface motion is the APP CHROME's own animation — the combo counter's
// pop, the shell's regions moving on a mode or panel change, the popups'
// enter and exit, the shell's hover transitions. never the playfield's
// gameplay effects, which have their own master, and never the HP bar's damp,
// which is a reading of the play rather than motion of the chrome
// (`CONTEXT.md`).
//
// three rows sit under the master and each folds with it here: the combo pop,
// SHELL transitions and POPUP transitions. a transition belongs to a row by
// the SURFACE it happens in, not by what triggered it -- the settings
// dialog's nav column is a popup transition even though the shell opened the
// dialog

import type { InterfaceSettings } from "@/lib/scene-types";
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

/** whether one ROW under the master runs. the fold is the one every granular
 * flag under a master gets: both halves on, or nothing. the stored row is
 * never rewritten, so switching the master back on restores exactly what the
 * user had */
export function effectiveRow(row: boolean, master: boolean): boolean {
	return row && master;
}

/** the value a motion attribute carries on `<html>`. one attribute rather
 * than a class per animation: every existing Tailwind transition and
 * animation site is covered by one rule in `index.css` reading this, so a
 * future animation opts in by class rather than by having a prop plumbed to
 * it */
export function motionAttribute(enabled: boolean): "on" | "off" {
	return enabled ? "on" : "off";
}

/** the three attributes the app root writes on `<html>`, resolved together.
 * `data-motion` stays the MASTER's -- it is what the blanket rule and the
 * `motion:` variant key on -- and the two siblings carry the rows ALREADY
 * FOLDED with it, so no stylesheet rule has to and-together two attributes.
 * an element opts into a row by carrying `data-motion-row`, and the per-row
 * rules in `index.css` zero it under whichever sibling reads off */
export interface RootMotionAttributes {
	motion: "on" | "off";
	shell: "on" | "off";
	popup: "on" | "off";
}

export function rootMotionAttributes(prefs: InterfaceSettings, osReducesMotion: boolean): RootMotionAttributes {
	const master = effectiveMotion(prefs.motion, osReducesMotion);
	return {
		motion: motionAttribute(master),
		shell: motionAttribute(effectiveRow(prefs.shellTransitions, master)),
		popup: motionAttribute(effectiveRow(prefs.popupTransitions, master))
	};
}

/** the effective flag off the store, for the JS-driven animations that cannot
 * read a css attribute — the watch HUD's combo pop is the first. a plain
 * boolean, so useSyncExternalStore compares it by value and the selector is
 * safe to pass inline */
export const selectMotion = (s: ViewerState): boolean => effectiveMotion(s.interface.motion, s.osReducesMotion);

/** the shell row's fold, off the store. the presence helper reads this rather
 * than a computed style: a zero-duration css TRANSITION fires no end event, so
 * an exiting region with motion off has to be unmounted at once rather than
 * waited on (lib/presence.ts carries the same note at its own site).
 *
 * there is deliberately no popup twin: nothing in the popup half is driven
 * from JS -- base-ui unmounts a closing popup off animationend, which the
 * per-row rule leaves firing -- so a second selector would be a fold nobody
 * reads. `effectiveRow` is what a future one would be one line of */
export const selectShellMotion = (s: ViewerState): boolean =>
	effectiveRow(s.interface.shellTransitions, selectMotion(s));
