// the single source of the viewer preference defaults, shared by the store's
// initial state and the renderer's pre-first-setOverlays() fallback. these
// mirror settings.rs's OverlayPrefs::default / Settings::default, which is
// what a fresh (or legacy) settings.json hydrates to

import type { EditingSettings, EffectSettings, OverlaySettings, TimelineSettings } from "../lib/scene-types";

/** osurulesetconfigmanager.cs:27-31 */
export const DEFAULT_OVERLAYS: OverlaySettings = {
	cursorPath: false,
	clickMarkers: false,
	frameMarkers: false,
	hideCursor: false,
	keyOverlay: true,
	displayLength: 800
};

/** mirrors settings.rs EditingPrefs::default() */
export const DEFAULT_EDITING: EditingSettings = {
	snapToLattice: true,
	warnOnOverwrite: true
};

/** mirrors settings.rs EffectPrefs::default() -- the full-fat look */
export const DEFAULT_EFFECTS: EffectSettings = {
	enabled: true,
	hitAnimations: true,
	hitEffects: true,
	cursorGlow: true,
	cursorTrail: true,
	followPoints: true
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
		followPoints: false
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

/** linear amplitude percent */
export const DEFAULT_VOLUME = 100;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 100;

export const DISPLAY_LENGTH_MIN = 200;
export const DISPLAY_LENGTH_MAX = 2000;

/** rounds and clamps a volume percent; NaN is rejected by the callers */
export function clampVolume(volume: number): number {
	return Math.round(Math.min(Math.max(volume, VOLUME_MIN), VOLUME_MAX));
}

export function clampDisplayLength(ms: number): number {
	return Math.round(Math.min(Math.max(ms, DISPLAY_LENGTH_MIN), DISPLAY_LENGTH_MAX));
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
