// the settings dialog's four categories: the ordered registry the nav column
// renders, the pref-key coverage map, and the open-target resolution every
// caller of the dialog goes through. plain data and one pure function, the
// same split TabRail makes with PANEL_TABS/railTabClick, so the seam is
// covered headlessly while the panels around it stay untested jsx

import { Activity, Gamepad2, PencilRuler, Settings2, type LucideIcon } from "lucide-react";
import type { EditingSettings, EffectSettings, OverlaySettings, TimelineSettings } from "@/state/store";

export type SettingsCategory = "general" | "gameplay" | "analysis" | "editing";

/** the nav column's order, mirroring PANEL_TABS in TabRail.tsx. `general`
 * must stay first: resolveOpenCategory falls back to the first entry, and the
 * start screen's settings button exists for the install path it holds. the
 * rest read as a stack -- what the replay looks like, what is drawn on top of
 * it, how you change it. the icon sits beside the label rather than replacing
 * it (the inverse of the rail), so it is decorative and rendered aria-hidden */
export const SETTINGS_CATEGORIES: { id: SettingsCategory; label: string; Icon: LucideIcon }[] = [
	{ id: "general", label: "general", Icon: Settings2 },
	{ id: "gameplay", label: "gameplay", Icon: Gamepad2 },
	{ id: "analysis", label: "analysis", Icon: Activity },
	{ id: "editing", label: "editing", Icon: PencilRuler }
];

/** a viewer pref, namespaced by the group that holds it. the namespace is not
 * decoration: the four groups are free to reuse a name (`effects.enabled` is
 * already a key another group could plausibly want), and a bare key map would
 * quietly collapse the two into one entry that reads as covered */
export type SettingsPrefKey =
	| `overlays.${keyof OverlaySettings}`
	| `timeline.${keyof TimelineSettings}`
	| `effects.${keyof EffectSettings}`
	| `editing.${keyof EditingSettings}`;

/** which category renders which prefs. nothing reads this at runtime -- it
 * exists so categories.test.ts can fail when a pref is wired into the store
 * and into settings.rs but never rendered, which is invisible otherwise.
 *
 * `general` covers no key on purpose: the install path is a bespoke control,
 * not a per-key setter. so are `Settings.osuStablePath` and `Settings.recents`,
 * and `Settings.volume` is a real persisted pref that Transport.tsx renders
 * rather than this dialog -- all three are outside this map by design, and a
 * naive "every Settings key has a category" assertion would fail on day one.
 * the four groups here are exactly the ones that grow by "add a toggle" */
export const CATEGORY_PREFS: Record<SettingsCategory, readonly SettingsPrefKey[]> = {
	general: [],
	gameplay: [
		"effects.backgroundDim",
		"effects.enabled",
		"effects.hitAnimations",
		"effects.hitEffects",
		"effects.cursorGlow",
		"effects.cursorTrail",
		"effects.followPoints"
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
	editing: ["editing.snapToLattice", "editing.warnOnOverwrite"]
};

/** which category an open request lands on: an explicit target from the call
 * site, else wherever the user last was this session, else the first entry */
export function resolveOpenCategory(
	target: SettingsCategory | null | undefined,
	lastUsed: SettingsCategory | null | undefined
): SettingsCategory {
	return target ?? lastUsed ?? SETTINGS_CATEGORIES[0].id;
}
