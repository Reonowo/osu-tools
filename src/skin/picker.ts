// what the skin picker renders, as plain data and pure functions -- the same
// split `lib/open-menu.ts` makes for the open menu, so the decision surface is
// covered headlessly while the jsx around it stays untested.
//
// nothing here knows about the store or about ipc. it answers three questions:
// which rows are shown and in what order, which one is selected, and what each
// row's badge says.

import type { SkinEntry, SkinLocator, SkinManifest, SkinSource } from "@/lib/scene-types";

/** the badge each row carries, telling an imported skin from one the app found
 * in a stable install -- which is the difference a user cannot see from the
 * name alone */
export const SOURCE_LABELS: Record<SkinSource, string> = {
	bundled: "bundled",
	stable: "osu! install",
	folder: "folder",
	imported: "imported"
};

/**
 * THE DEVELOPMENT GATE.
 *
 * legacy skins become selectable only once every element the playfield draws
 * has a legacy implementation. the gate is per-element coverage rather than a
 * date or a slice boundary, and that is what makes any half-implemented state a
 * development state rather than a shipped one: a build where the cursor is
 * legacy and the hit circles are Argon shows a mixed-era playfield, which is
 * exactly the look the classic floor was vendored to prevent.
 *
 * flip this to `true` when the inventory is complete -- cursor, hit circle and
 * approach circle, slider ends, slider ball and follow circle, ticks and
 * reverses, slider body, spinner, follow points, judgements, hit lighting, and
 * the combo palette. removing the gate then means removing this constant and
 * its uses, NOT inverting it: a gate left in place reading `true` is a gate
 * someone will later wonder about.
 *
 * the sample CHAIN is not separately gated -- a legacy skin's hit samples
 * resolve and sound correct wherever a legacy skin is active, which is what
 * makes the sample half finished work rather than work behind this flag.
 *
 * what the gate withholds is the manifest itself, and therefore the samples
 * along with the playfield: `selectSkin` and `importSkin` refuse a legacy skin
 * outright, and `hydrateSettings` refuses one a dev build persisted (the two
 * builds share a settings file). that is deliberate -- the combo palette is
 * already a drawing decision keyed on the era, so a manifest left on the store
 * "for the samples only" would colour an Argon playfield with the classic four,
 * which is the mixed-era look this exists to prevent. a shipped build therefore
 * has no legacy skin at all rather than half of one
 */
export const LEGACY_SKINS_IMPLEMENTED = false;

/** the gate as a predicate, so every route into a selection reads ONE rule.
 * the row list is not the only way to pick a skin -- browse… and import both
 * reach `selectSkin`/`importSkin` directly with a locator the picker never
 * enumerated -- and a gate applied only to the rows would let a shipped build
 * load a legacy skin through either of them */
export function legacyAllowed(options: { legacyImplemented?: boolean; development?: boolean } = {}): boolean {
	return (options.legacyImplemented ?? LEGACY_SKINS_IMPLEMENTED) || (options.development ?? false);
}

/** the refusal a gated skin carries, wherever it was reached from */
export const LEGACY_GATE_REFUSAL = "legacy skins are not drawable yet in this build";

export interface SkinRow extends SkinEntry {
	/** whether this row is the active selection */
	selected: boolean;
	/** whether the row can be selected at all. a refused skin still SHOWS --
	 * omitting it would leave the user hunting for a skin they can see on disk
	 * -- but it cannot be picked, and its refusal says why */
	selectable: boolean;
}

/** two locators name the same skin when they agree on both the kind and the
 * path. comparing paths alone would let a folder skin and a stable one under
 * the same directory read as one row */
export function sameSkin(a: SkinLocator, b: SkinLocator): boolean {
	if (a.kind !== b.kind) return false;
	// the second test looks redundant -- the kinds already agree -- but it is
	// what narrows `b` for the path comparison below. typescript does not carry
	// the equality from one discriminant to the other, so dropping it makes
	// `b.path` an error rather than a simplification
	if (a.kind === "bundled" || b.kind === "bundled") return true;
	return a.path.toLowerCase() === b.path.toLowerCase();
}

/** whether a newly published manifest leaves nothing to redraw or re-resolve.
 *
 * true in exactly two cases:
 *
 * 1. **the same object.** nothing was published.
 * 2. **both sides resolve to the BUNDLED default**, `null` included. bundled
 *    art is procedural and bundled samples ship with the app, so there is no
 *    file on disk that could have changed underneath it -- and the startup
 *    `null -> bundled` flip is not a skin change at all, so treating it as one
 *    would drop every decoded sample and rebuild every drawable, possibly
 *    mid-playback, for a skin that never moved.
 *
 * a re-select or a re-import of the SAME locator is deliberately NOT the same:
 * a skin is referenced in place, so its files can be edited under the app, and
 * a re-import replaces them outright. re-picking it is exactly how a user asks
 * for that to be picked up, and comparing locators alone would silently ignore
 * them
 */
export function sameSelection(a: SkinManifest | null, b: SkinManifest | null): boolean {
	if (a === b) return true;
	const left = a?.locator ?? { kind: "bundled" as const };
	const right = b?.locator ?? { kind: "bundled" as const };
	return left.kind === "bundled" && right.kind === "bundled";
}

/**
 * the picker's rows.
 *
 * the order is the backend's, deliberately: bundled first, then whatever the
 * stable install holds, then the imported ones. sorting by name here would
 * scatter the imported skins through the stable ones and lose the grouping the
 * source badge exists to make visible.
 *
 * the ACTIVE skin is matched against the manifest's own locator rather than
 * against the persisted selection, because those two disagree in exactly the
 * case that matters: after a stale locator falls back, the persisted selection
 * still names a folder that is gone while the manifest names the bundled
 * default. highlighting the missing folder there would tell the user their
 * skin is loaded when it is not.
 */
export function skinRows(
	entries: readonly SkinEntry[],
	active: SkinManifest | null,
	options: { legacyImplemented?: boolean; development?: boolean } = {}
): SkinRow[] {
	// a development build may select a legacy skin so the elements can be built
	// against real ones; a shipped build may not, until the inventory is complete
	const allowed = legacyAllowed(options);
	return entries.map((entry) => {
		const gated = entry.era === "legacy" && !allowed;
		return {
			...entry,
			selected: active !== null && sameSkin(entry.locator, active.locator),
			selectable: entry.refusal === null && !gated,
			refusal: gated && entry.refusal === null ? LEGACY_GATE_REFUSAL : entry.refusal
		};
	});
}

/**
 * the notice shown when the app fell back to the bundled default.
 *
 * a skin that no longer resolves is a lookup miss, not an error -- the same
 * posture a stale beatmap association gets -- so the app opens anyway. but it
 * must SAY so, or the user is left wondering where their skin went
 */
export function fallbackNotice(active: SkinManifest | null): string | null {
	if (active?.fellBack == null) return null;
	const requested = active.fellBack.requested;
	const where = requested.kind === "bundled" ? "the bundled default" : requested.path;
	return `${where} could not be loaded, so the bundled default is in use`;
}

/** the label a row shows. the declared name where there is one, and the folder
 * name where there is not -- the folder-name fallback happens backend-side,
 * where the folder is, so this is only ever a last-resort guard */
export function rowLabel(row: SkinEntry): string {
	return row.name.trim() === "" ? "(unnamed skin)" : row.name;
}
