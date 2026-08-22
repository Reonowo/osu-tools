// the settings dialog's seven categories: the ordered registry the nav column
// renders, the pref-key coverage map, and the open-target resolution every
// caller of the dialog goes through. plain data and one pure function, the
// same split TabRail makes with PANEL_TABS/railTabClick, so the seam is
// covered headlessly while the panels around it stay untested jsx

import { Activity, Gamepad2, Keyboard, Palette, PencilRuler, Settings2, Volume2, type LucideIcon } from "lucide-react";
import type {
	AudioSettings,
	EditingSettings,
	EffectSettings,
	GameplaySettings,
	OverlaySettings,
	TimelineSettings
} from "@/state/store";

export type SettingsCategory = "general" | "gameplay" | "skin" | "audio" | "analysis" | "editing" | "keybinds";

/** the nav column's order, mirroring PANEL_TABS in TabRail.tsx. `general`
 * must stay first: resolveOpenCategory falls back to the first entry, and the
 * start screen's settings button exists for the install path it holds. the
 * rest read as a stack -- what the replay looks like, what it sounds like,
 * what is drawn on top of it, how you change it, and last the keyboard that
 * reaches all of it. the icon sits beside the label rather than replacing it
 * (the inverse of the rail), so it is decorative and rendered aria-hidden */
export const SETTINGS_CATEGORIES: { id: SettingsCategory; label: string; Icon: LucideIcon }[] = [
	{ id: "general", label: "general", Icon: Settings2 },
	{ id: "gameplay", label: "gameplay", Icon: Gamepad2 },
	{ id: "skin", label: "skin", Icon: Palette },
	{ id: "audio", label: "audio", Icon: Volume2 },
	{ id: "analysis", label: "analysis", Icon: Activity },
	{ id: "editing", label: "editing", Icon: PencilRuler },
	{ id: "keybinds", label: "keybinds", Icon: Keyboard }
];

/** a viewer pref, namespaced by the group that holds it. the namespace is not
 * decoration: the groups are free to reuse a name (`effects.enabled` is
 * already a key another group could plausibly want), and a bare key map would
 * quietly collapse the two into one entry that reads as covered */
export type SettingsPrefKey =
	| `audio.${keyof AudioSettings}`
	| `gameplay.${keyof GameplaySettings}`
	| `overlays.${keyof OverlaySettings}`
	| `timeline.${keyof TimelineSettings}`
	| `effects.${keyof EffectSettings}`
	| `editing.${keyof EditingSettings}`;

/** which category renders which prefs. nothing reads this at runtime -- it
 * exists so categories.test.ts can fail when a pref is wired into the store
 * and into settings.rs but never rendered, which is invisible otherwise.
 *
 * `general` and `skin` cover no key on purpose: the install path and the skin
 * selection are bespoke controls,
 * not a per-key setter. so are `Settings.osuStablePath` and `Settings.recents`
 * -- both outside this map by design, and a naive "every Settings key has a
 * category" assertion would fail on day one. `keybinds` covers none for the
 * same reason: `Settings.keybinds` is one sparse map behind a bespoke capture
 * control, not a set of per-key setters.
 *
 * `Settings.volume` -- the master -- is deliberately absent too, but for a
 * different reason than it used to be. it is not "rendered elsewhere instead":
 * it is rendered in BOTH places, on the transport where it is one drag away
 * and in the audio category beside the channels it multiplies, which is what
 * lazer does (VolumeSettings.cs). a key in this map means "exactly one
 * category owns it", and the master owns none */
export const CATEGORY_PREFS: Record<SettingsCategory, readonly SettingsPrefKey[]> = {
	general: [],
	// the two `gameplay.*` keys are not a typo: the audio category renders
	// them, and the prefs group they persist under was left alone so no
	// settings file needs migrating (AudioCategory.tsx says why they moved).
	// this map is keyed on where a control APPEARS, which is exactly the
	// question a prefix cannot answer
	audio: [
		"audio.musicVolume",
		"audio.hitsoundVolume",
		"audio.offsetMs",
		"audio.ignoreBeatmapHitsounds",
		"gameplay.positionalHitsoundLevel",
		"gameplay.alwaysPlayFirstComboBreak"
	],
	gameplay: [
		"effects.backgroundDim",
		// the snaking toggles persist under `gameplay` (settings.rs
		// GameplayPrefs) and render here, in their own sliders section --
		// GameplayCategory.tsx carries the placement reasoning
		"gameplay.snakingInSliders",
		"gameplay.snakingOutSliders",
		"effects.enabled",
		"effects.hitAnimations",
		"effects.hitEffects",
		"effects.cursorGlow",
		"effects.cursorTrail",
		"effects.followPoints",
		"effects.ignoreBeatmapSkin",
		"effects.show300Judgements"
	],
	analysis: [
		"overlays.clickMarkers",
		"overlays.frameMarkers",
		"overlays.tintIdleMarkers",
		"overlays.cursorPath",
		"overlays.hideCursor",
		"overlays.keyOverlay",
		"overlays.displayLength",
		"overlays.playfieldGrid",
		"timeline.hitWindowBands",
		"timeline.tethers",
		"timeline.nestedMarks",
		"timeline.severityTicks"
	],
	// `skin` covers no per-key pref for the same reason `general` does not:
	// the selection is one discriminated locator behind a bespoke picker, not a
	// set of per-key setters, and `Settings.skin` is deliberately outside this
	// map on those terms
	skin: [],
	editing: ["editing.snapToLattice", "editing.warnOnOverwrite"],
	keybinds: []
};

/** which category an open request lands on: an explicit target from the call
 * site, else wherever the user last was this session, else the first entry */
export function resolveOpenCategory(
	target: SettingsCategory | null | undefined,
	lastUsed: SettingsCategory | null | undefined
): SettingsCategory {
	return target ?? lastUsed ?? SETTINGS_CATEGORIES[0].id;
}
