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

import type { LoadedScene, RefusalReason, RulesProfile, SimulatedDto, SimulationDto } from "./scene-types";

/** why a scene carries no simulation at all */
export type NotSimulatedReason = RefusalReason;

/** lowercase prose for a refusal, so no surface leaks a raw discriminant like
 * "unsupportedMods" into a row that is otherwise all lowercase prose. no
 * default case -- the parameter's own union makes an unhandled reason a
 * typecheck failure (missing return, the same guarantee warningText gets
 * from its switch) rather than a silent raw-string fallback */
export function simulationReasonText(reason: NotSimulatedReason): string {
	switch (reason.kind) {
		case "unsupportedMods":
			// the play's effective mods are outside the matrix the engine
			// simulates (NoMod only so far), named so the user knows which
			return `mods not simulated (${reason.acronyms.join(" ")})`;
		case "beatmapMismatch":
			// the loaded beatmap's md5 doesn't match the replay's -- same fact
			// warningText's beatmapMismatch case reports, worded to fit inline
			return "beatmap mismatch";
		case "unreadableScoreInfo":
			// a lazer file whose score-info block could not be read, so its
			// mods cannot be resolved at all
			return "score-info block unreadable";
	}
}

/** the profile's name as the surfaces print it */
export function profileText(profile: RulesProfile): string {
	return profile === "stable" ? "stable profile" : "native profile";
}

/** whether the scene carries a judgement timeline to DISPLAY -- authoritative
 * or approximate. this is the predicate every viewing surface gates on (the
 * watch HUD, the overview strip, the object lane, the hitsound plan, the
 * hitsound rows); the surfaces that must be exact -- the tools, the keypress
 * panel, the frames panel's edit controls, the integrity section, the
 * regenerate path -- read the configuration's capabilities instead */
export function hasTimeline(simulation: SimulationDto): simulation is SimulatedDto {
	return simulation.status === "authoritative" || simulation.status === "approximate";
}

/** the timeline arm, or null: the shape most consumers want */
export function simulated(simulation: SimulationDto): SimulatedDto | null {
	return hasTimeline(simulation) ? simulation : null;
}

/** the profile the scene's timeline was judged under, or null when there is
 * none: the play's own when authoritative, the neighbouring one when
 * approximate. what the derive layer asks before reading a slider's grade off
 * its head (native, no aggregate) or off its aggregate (stable) */
export function simulatedProfile(scene: LoadedScene): RulesProfile | null {
	const support = scene.configuration.capabilities.simulate;
	return support.status === "refused" ? null : support.profile;
}
