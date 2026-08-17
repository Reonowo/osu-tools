// what an absent simulation is called on screen. lifted out of StatusBar,
// whose own comment claimed the status bar was its only reader: the
// transport's severity-jump cluster explains its disabled state with exactly
// these words, and two surfaces naming one fact differently is the drift a
// shared vocabulary exists to prevent.
//
// deliberately not folded into lib/warnings.ts, which reports a different
// fact: a warning is something the backend attached to the loaded scene, and
// warningText spells its modsNotSimulated case as a sentence naming the mods
// and what they cost. these are the two-word noun phrases an inline status
// segment and a tooltip can carry

import type { SimulationDto } from "./scene-types";

/** why a scene carries no authoritative simulation */
export type NotSimulatedReason = Extract<SimulationDto, { status: "notSimulated" }>["reason"];

/** lowercase prose for a notSimulated reason, so no surface leaks a raw
 * discriminant like "unsupportedMods" into a row that is otherwise all
 * lowercase prose. no default case -- the parameter's own literal union makes
 * an unhandled reason a typecheck failure (missing return, the same guarantee
 * warningText gets from its switch) rather than a silent raw-string fallback */
export function simulationReasonText(reason: NotSimulatedReason): string {
	switch (reason) {
		case "unsupportedMods":
			// the replay uses mods the engine's simulator doesn't implement yet
			// (mods.rs is NoMod-only so far), so nothing was simulated at all
			return "mods not simulated";
		case "beatmapMismatch":
			// the loaded beatmap's md5 doesn't match the replay's -- same fact
			// warningText's beatmapMismatch case reports, worded to fit inline
			return "beatmap mismatch";
	}
}
