// osucolours.cs — the osu!framework palette the chrome and the analysis
// overlay both draw. values are pinned against index.css's --grade-*,
// --graph-* and lattice tokens by lib/chrome-tokens.test.ts, the same way
// --ease-* is pinned against engine/easing.ts. do not "tidy" these hexes.
export const OSU_COLOUR = {
	blue: "#66ccff", // great / 300 / SS-S tiles / lattice-on
	green: "#88b300", // ok / 100 / A tiles
	yellow: "#ffcc22", // osucolour.cs:331 — meh / 50 / B-C tiles
	red: "#ed1121", // miss / D-F tiles. NOT --destructive; see TODO.md
	pink2: "#eb4791", // osucolour.cs:411 — velocity + analysis graph
	gray4: "#444", // osucolour.cs:387
	gray5: "#555", // osucolour.cs:388
	gray6: "#a6a6a6" // analysis idle-marker tint
} as const;

export type Grade = "great" | "ok" | "meh" | "miss";

/** what each judgement grade is drawn with, on the timeline and the strip */
export const GRADE_COLOUR: Record<Grade, string> = {
	great: OSU_COLOUR.blue,
	ok: OSU_COLOUR.green,
	meh: OSU_COLOUR.yellow,
	miss: OSU_COLOUR.red
};

/** text on a filled grade tile */
export const GRADE_ON_COLOUR: Record<Grade, string> = {
	great: "#0a1218",
	ok: "#11170a",
	meh: "#1a1400",
	miss: "#1b0505"
};

/** a null grade on the object lane — same value as --muted-foreground, its
 * own token so a theme can separate the two (see TODO.md near-duplicates) */
export const UNGRADED_COLOUR = "#8a8a93";

/** the detail lanes' grade band washes, at the alphas they already carry */
export const GRADE_BAND_COLOUR: Record<"meh" | "ok" | "great", string> = {
	meh: "#ffcc2226",
	ok: "#88b30038",
	great: "#66ccff52"
};
