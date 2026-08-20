// the single source of the viewer preference defaults, shared by the store's
// initial state and the renderer's pre-first-setOverlays() fallback. these
// mirror settings.rs's OverlayPrefs::default / Settings::default, which is
// what a fresh (or legacy) settings.json hydrates to

import type {
	AudioSettings,
	EditingSettings,
	GameplaySettings,
	EffectSettings,
	OverlaySettings,
	SkinLocator,
	TimelineSettings
} from "../lib/scene-types";

/** osurulesetconfigmanager.cs:27-31 */
export const DEFAULT_OVERLAYS: OverlaySettings = {
	cursorPath: false,
	clickMarkers: false,
	frameMarkers: false,
	// off: the stock look stays lazer's, whose idle markers melt into the path
	tintIdleMarkers: false,
	hideCursor: false,
	keyOverlay: true,
	displayLength: 800,
	// off: a reference grid the user did not ask for must not appear over
	// their replay
	playfieldGrid: 0
};

/** mirrors settings.rs EditingPrefs::default() */
export const DEFAULT_EDITING: EditingSettings = {
	snapToLattice: true,
	warnOnOverwrite: true
};

/** the black scrim over the beatmap background, percent; 100 is fully black,
 * matching osu!'s own dim control. declared above DEFAULT_EFFECTS rather than
 * with the other numeric trios at the foot of this file because that object
 * reads it. the default is what the viewer drew hardcoded before the control
 * existed, so a fresh install looks the way it always did */
export const BACKGROUND_DIM_MIN = 0;
export const BACKGROUND_DIM_MAX = 100;
export const DEFAULT_BACKGROUND_DIM = 70;

/** rounds and clamps a dim percent; NaN is rejected by the callers, exactly
 * as it is for volume and display length */
export function clampBackgroundDim(percent: number): number {
	return Math.round(Math.min(Math.max(percent, BACKGROUND_DIM_MIN), BACKGROUND_DIM_MAX));
}

/** mirrors settings.rs EffectPrefs::default() -- the full-fat look */
export const DEFAULT_EFFECTS: EffectSettings = {
	enabled: true,
	hitAnimations: true,
	hitEffects: true,
	cursorGlow: true,
	cursorTrail: true,
	followPoints: true,
	// off: a mapset that ships its own art presents as its author intended
	ignoreBeatmapSkin: false,
	// the one effect that does NOT default on: a 300 popup on every great
	// buries the 100s and 50s a replay is opened to find
	show300Judgements: false,
	backgroundDim: DEFAULT_BACKGROUND_DIM
};

/** mirrors settings.rs TimelinePrefs::default() -- every layer visible */
export const DEFAULT_TIMELINE: TimelineSettings = {
	hitWindowBands: true,
	tethers: true,
	nestedMarks: true,
	severityTicks: true
};

/** the master folded into every granular flag, which is what the renderer
 * actually gates on: an effect is live only when both are on. the stored
 * values are never rewritten, so turning the master back on restores exactly
 * what the user had. the sole place that fold happens -- consumers read the
 * resolved flags and never re-check `enabled` themselves */
export function effectiveEffects(effects: EffectSettings): EffectSettings {
	if (effects.enabled) return effects;
	return {
		enabled: false,
		hitAnimations: false,
		hitEffects: false,
		cursorGlow: false,
		cursorTrail: false,
		followPoints: false,
		// NOT folded: refusing a beatmap's art is a source decision, not an
		// effect, and switching gameplay effects off must not silently start
		// drawing art the user turned down. it passes through untouched, the
		// same way the background dim does
		ignoreBeatmapSkin: effects.ignoreBeatmapSkin,
		show300Judgements: false,
		// the background dim is not an effect -- it rides on this group for
		// where it belongs in the settings dialog, and switching gameplay
		// effects off must not change the background. it passes through
		// untouched
		backgroundDim: effects.backgroundDim
	};
}

/** the viewer mode folded into what the renderer reads, the same pattern as
 * effectiveEffects: edit mode force-draws the cursor path and frame markers
 * (the frames the tools operate on must never be invisible) without ever
 * rewriting the stored preferences, so switching back to watch restores
 * exactly the configured view. click markers and cursor hiding follow their
 * stored values in both modes */
export function effectiveOverlays(overlays: OverlaySettings, mode: "watch" | "edit"): OverlaySettings {
	if (mode === "watch") return overlays;
	if (overlays.cursorPath && overlays.frameMarkers) return overlays;
	return { ...overlays, cursorPath: true, frameMarkers: true };
}

/** linear amplitude percent. the master; the two channels under it are in
 * DEFAULT_AUDIO below */
export const DEFAULT_VOLUME = 100;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;

/** mirrors settings.rs AudioPrefs::default(). the master keeps its own
 * top-level `volume` key so no existing settings file needs migrating; these
 * are the channels under it, each starting where a user who has never opened
 * the audio category expects them -- full, so the product is the master */
export const DEFAULT_AUDIO: AudioSettings = {
	musicVolume: 100,
	hitsoundVolume: 100,
	offsetMs: 0,
	ignoreBeatmapHitsounds: false
};

/** mirrors settings.rs GameplayPrefs::default() -- lazer's own defaults */
export const DEFAULT_GAMEPLAY: GameplaySettings = {
	positionalHitsoundLevel: 0.2,
	alwaysPlayFirstComboBreak: true
};

/** the positional level is a 0-1 ratio; a blank field centres everything
 * rather than poisoning the balance samples are panned with */
export function clampPositionalLevel(level: number): number {
	if (!Number.isFinite(level)) return 0;
	return Math.min(Math.max(level, 0), 1);
}

/** lazer's own AudioOffset range and step (OsuConfigManager.cs:109) */
export const AUDIO_OFFSET_MIN = -500;
export const AUDIO_OFFSET_MAX = 500;

/** rounds and clamps an offset; a blank field arrives as NaN and falls back to
 * no offset rather than to a bound, since neither bound is a neutral value */
export function clampAudioOffset(ms: number): number {
	if (!Number.isFinite(ms)) return 0;
	return Math.round(Math.min(Math.max(ms, AUDIO_OFFSET_MIN), AUDIO_OFFSET_MAX));
}

export const DISPLAY_LENGTH_MIN = 200;
export const DISPLAY_LENGTH_MAX = 2000;

/** rounds and clamps a volume percent; NaN is rejected by the callers */
export function clampVolume(volume: number): number {
	return Math.round(Math.min(Math.max(volume, VOLUME_MIN), VOLUME_MAX));
}

export function clampDisplayLength(ms: number): number {
	return Math.round(Math.min(Math.max(ms, DISPLAY_LENGTH_MIN), DISPLAY_LENGTH_MAX));
}

/** the playfield grid's spacings, in osu!px, `0` meaning off. one preference
 * rather than a boolean plus a size, so it cannot reach an incoherent state.
 * the four sizes are the ones osu!'s own beatmap editor offers */
export const PLAYFIELD_GRID_SPACINGS = [0, 4, 8, 16, 32] as const;
export type PlayfieldGridSpacing = (typeof PLAYFIELD_GRID_SPACINGS)[number];

/** anything outside the allowed set means a hand-edited or newer settings
 * file; off is the inert answer, mirroring how a non-finite display length
 * falls back to its own default */
export function clampPlayfieldGridSpacing(spacing: number): PlayfieldGridSpacing {
	return PLAYFIELD_GRID_SPACINGS.find((allowed) => allowed === spacing) ?? 0;
}

/** the move tool's feather window, ms (parent design spec: default 40).
 * session-only, like rate: it belongs to the replay being edited, not the app */
export const DEFAULT_FEATHER_MS = 40;
export const FEATHER_MIN_MS = 0;
export const FEATHER_MAX_MS = 1000;

export function clampFeather(ms: number): number {
	if (!Number.isFinite(ms)) return DEFAULT_FEATHER_MS;
	return Math.round(Math.min(Math.max(ms, FEATHER_MIN_MS), FEATHER_MAX_MS));
}

/** the smooth tool's original->smoothed blend, percent. session-only */
export const DEFAULT_SMOOTH_STRENGTH = 100;

export function clampStrength(value: number): number {
	if (!Number.isFinite(value)) return DEFAULT_SMOOTH_STRENGTH;
	return Math.round(Math.min(Math.max(value, 0), 100));
}

/** the detail tier's visible span, ms. the floor matches timeline-view's
 * MIN_SPAN_MS; the ceiling is a comfortable "whole phrase" view */
export const DETAIL_SPAN_MIN = 250;
export const DETAIL_SPAN_MAX = 120_000;
export const DEFAULT_DETAIL_SPAN = 20_000;

export function clampDetailSpan(spanMs: number): number {
	if (!Number.isFinite(spanMs)) return DETAIL_SPAN_MAX;
	return Math.min(Math.max(spanMs, DETAIL_SPAN_MIN), DETAIL_SPAN_MAX);
}

/** mirrors settings.rs `SkinLocator::default()`.
 *
 * the app's own look is a selectable ROW rather than a "nothing selected"
 * state, which is what makes "no skin" and "Argon" one concept rather than two */
export const DEFAULT_SKIN: SkinLocator = { kind: "bundled" };
