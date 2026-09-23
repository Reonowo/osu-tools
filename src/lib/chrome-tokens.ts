// the cited manifest behind index.css's chrome vocabulary (docs/adr/0011).
// chrome-tokens.test.ts pins the stylesheet to this file the same way
// easing-css.test.ts pins --ease-* to engine/easing.ts: every design token in
// index.css is listed here with the value it must declare and where the value
// comes from, and a hand-tweaked hex that claims to be one of them cannot slip
// through. this file is the one place in src/ outside engine/ and skin/ where
// raw values are written down -- it is the value list itself, the TS twin of
// the stylesheet, and chrome-tokens.test.ts exempts it from the raw-literal
// ban for that reason (index.css is exempt too, by virtue of not being ts).

import { OSU_COLOUR, GRADE_ON_COLOUR, GRADE_BAND_COLOUR, UNGRADED_COLOUR } from "@/engine/osu-colours";

export type ChromeToken = {
	/** the value index.css must declare, whitespace-collapsed */
	readonly value: string;
	/** where the number or colour comes from */
	readonly citation: string;
};

const inkRamp: Record<string, ChromeToken> = {
	"--foreground-bright": {
		value: "#f4f4f5",
		citation: "redesign pass ink ramp, loud end — emphasis values and big numbers"
	},
	"--foreground": { value: "#e4e4e7", citation: "redesign pass ink ramp — default text" },
	"--foreground-soft": { value: "#a1a1aa", citation: "redesign pass ink ramp — secondary labels, licence names" },
	"--muted-foreground": { value: "#8a8a93", citation: "redesign pass ink ramp — captions" },
	"--foreground-dim": { value: "#71717a", citation: "redesign pass ink ramp — tertiary, mono meta, inactive" },
	"--foreground-faint": { value: "#5a5a63", citation: "redesign pass ink ramp — keybind hints, timestamps" },
	"--foreground-ghost": { value: "#3f3f46", citation: "redesign pass ink ramp — the / in time readouts" },
	"--foreground-veil": { value: "#27272a", citation: "redesign pass ink ramp, quiet end — the │ glyph divider" },
	"--foreground-pending": {
		value: "#52525b",
		citation:
			"redesign pass ink ramp — a video-export step not reached yet; same value as --ring, two tokens (TODO.md)"
	}
};

const surfaces: Record<string, ChromeToken> = {
	"--surface-viewport": { value: "#08080a", citation: "redesign pass surface ramp — the playfield well" },
	"--surface-rail": { value: "#0a0a0c", citation: "redesign pass surface ramp — the tab rail" },
	"--surface-bar": {
		value: "#0c0c0f",
		citation: "redesign pass surface ramp — the top bar (also the HUD tile at /[.72])"
	},
	"--surface-panel": { value: "#0e0e11", citation: "redesign pass surface ramp — the side panel" },
	"--surface-strip": { value: "#101013", citation: "redesign pass surface ramp — the overview strip" },
	"--surface-card": { value: "#121215", citation: "redesign pass surface ramp — the card" },
	"--surface-sunken": { value: "#131316", citation: "redesign pass surface ramp — segmented-control tracks" },
	"--surface-hover": { value: "#16161a", citation: "redesign pass surface ramp — list-row hover" },
	"--surface-chip": { value: "#18181b", citation: "redesign pass surface ramp — small chip tracks" },
	"--surface-raised": {
		value: "#1c1c20",
		citation: "redesign pass surface ramp, raised end — progress tracks, top-bar chips"
	},
	"--border": { value: "#1e1e22", citation: "redesign pass surface ramp — default hairline" },
	"--border-strong": { value: "#2a2a30", citation: "redesign pass surface ramp — emphasised hairline" },
	"--border-faint": { value: "#17171b", citation: "redesign pass surface ramp — timeline lane hairlines" },
	"--border-subtle": {
		value: "#101013",
		citation:
			"redesign pass surface ramp — hold-lane hairlines; same value as --surface-strip, two tokens on purpose (ADR 0011)"
	}
};

const primaryFamily: Record<string, ChromeToken> = {
	"--primary": { value: "#ff66ab", citation: "redesign pass accent — the brand pink" },
	"--primary-hover": {
		value: "#ff87bc",
		citation: "redesign pass accent — play-button hover, [version] tint in TopBar"
	},
	"--primary-foreground": { value: "#1b0c12", citation: "redesign pass accent — text on a filled primary" },
	"--primary-wash-faint": {
		value: "color-mix(in oklch, var(--primary) 3%, transparent)",
		citation: "redesign pass — drop-zone hover wash"
	},
	"--primary-wash-subtle": {
		value: "color-mix(in oklch, var(--primary) 5%, transparent)",
		citation: "redesign pass — overview strip's played fill"
	},
	"--primary-wash-soft": {
		value: "color-mix(in oklch, var(--primary) 7%, transparent)",
		citation: "redesign pass — selected centre, selection bracket"
	},
	"--primary-wash": {
		value: "color-mix(in oklch, var(--primary) 12%, transparent)",
		citation: "redesign pass — armed keybind, menu highlight"
	},
	"--primary-wash-strong": {
		value: "color-mix(in oklch, var(--primary) 13%, transparent)",
		citation: "redesign pass — the active nav/tab tint; near-dup of --primary-wash 12% (TODO.md)"
	},
	"--primary-wash-max": {
		value: "color-mix(in oklch, var(--primary) 16%, transparent)",
		citation: "redesign pass — selected row, pressed tool"
	}
};

const grades: Record<string, ChromeToken> = {
	"--grade-great": { value: OSU_COLOUR.blue, citation: "osucolour.cs Blue — 300 / SS-S tiles / lattice-on" },
	"--grade-ok": { value: OSU_COLOUR.green, citation: "osucolour.cs Green — 100 / A tiles" },
	"--grade-meh": { value: OSU_COLOUR.yellow, citation: "osucolour.cs:331 Yellow — 50 / B-C tiles" },
	"--grade-miss": {
		value: OSU_COLOUR.red,
		citation: "osucolour.cs Red — miss / D-F. NOT --destructive; see TODO.md (overview-strip fail mark)"
	},
	"--grade-ungraded": {
		value: UNGRADED_COLOUR,
		citation: "ObjectLane's UNGRADED_HEX — null grade; same value as --muted-foreground, two tokens"
	},
	"--grade-great-on": { value: GRADE_ON_COLOUR.great, citation: "text on the SS-S tile" },
	"--grade-ok-on": { value: GRADE_ON_COLOUR.ok, citation: "text on the A tile" },
	"--grade-meh-on": { value: GRADE_ON_COLOUR.meh, citation: "text on the B-C tiles" },
	"--grade-miss-on": { value: GRADE_ON_COLOUR.miss, citation: "text on the D-F tiles" },
	"--grade-meh-band": { value: GRADE_BAND_COLOUR.meh, citation: "DetailLanes meh band wash, existing alpha" },
	"--grade-ok-band": { value: GRADE_BAND_COLOUR.ok, citation: "DetailLanes ok band wash, existing alpha" },
	"--grade-great-band": { value: GRADE_BAND_COLOUR.great, citation: "DetailLanes great band wash, existing alpha" },
	"--graph-velocity": {
		value: OSU_COLOUR.pink2,
		citation: "osucolour.cs:411 Pink2 — velocity lane + analysis graph"
	},
	"--hud-key": { value: "#99ddff", citation: "watch-HUD key counter; near-dup of --grade-great (TODO.md)" },
	"--hud-rest": { value: "rgba(255, 255, 255, 0.92)", citation: "HP fill + combo counter at rest" },
	"--lattice-on": { value: OSU_COLOUR.blue, citation: "snap-to-lattice on; near-dup of --grade-great (TODO.md)" },
	"--lattice-off": { value: OSU_COLOUR.yellow, citation: "snap-to-lattice off; near-dup of --grade-meh (TODO.md)" },
	"--lattice-unknown": { value: "#71717a", citation: "no lattice inferred; near-dup of --foreground-dim (TODO.md)" },
	"--warning": { value: "#fbbf24", citation: "warning-pill text; near-dup of --grade-meh (TODO.md)" },
	"--warning-border": { value: "rgba(245, 158, 11, 0.35)", citation: "warning-pill border" },
	"--warning-wash": { value: "rgba(69, 26, 3, 0.55)", citation: "warning-pill background" },
	"--danger-soft": { value: "#ff8a90", citation: "heading on the destructive wash" },
	"--danger-detail": { value: "#f1c9cc", citation: "log body on the destructive wash" },
	"--hp-curve-wash": { value: "rgba(255, 255, 255, 0.06)", citation: "overview strip's HP curve fill" },
	"--hp-curve-line": { value: "rgba(255, 255, 255, 0.22)", citation: "overview strip's HP curve stroke" }
};

/** --text-* with their Tailwind companions. leading/tracking omitted when the
 * role has none: an undefined companion leaves the property at `unset`, which
 * is exactly a size-only token's intent */
const type: Record<string, ChromeToken> = {
	"--text-section-label": {
		value: "9.5px",
		citation: "osu!lazer type ramp — uppercase panel heading (SectionLabel)"
	},
	"--text-section-label--letter-spacing": {
		value: "0.14em",
		citation: "osu!lazer type ramp — SectionLabel tracking"
	},
	"--text-mini-label": { value: "9.5px", citation: "osu!lazer type ramp — compact tracked label" },
	"--text-mini-label--letter-spacing": {
		value: "0.08em",
		citation: "osu!lazer type ramp — compact tracked label tracking"
	},
	"--text-history-detail": { value: "9.5px", citation: "osu!lazer type ramp — mono history detail" },
	"--text-history-detail--line-height": {
		value: "14px",
		citation: "osu!lazer type ramp — mono history detail leading"
	},
	"--text-mini": { value: "9.5px", citation: "osu!lazer type ramp — compact mono label (panel header trailing)" },
	"--text-micro": { value: "9px", citation: "osu!lazer type ramp, smallest step — micro badges" },
	"--text-caption": { value: "10.5px", citation: "osu!lazer type ramp — the workhorse body caption" },
	"--text-caption--line-height": { value: "1.55", citation: "osu!lazer type ramp — body caption leading" },
	"--text-caption-tight": {
		value: "10.5px",
		citation: "osu!lazer type ramp — dense footers; near-dup of --text-caption's leading (TODO.md)"
	},
	"--text-caption-tight--line-height": {
		value: "1.5",
		citation: "osu!lazer type ramp — dense footer leading, for a site that wrote leading-[1.5] beside its size"
	},
	"--leading-caption-tight": {
		value: "1.5",
		citation:
			"osu!lazer type ramp — the same leading as a standalone `leading-*`, for a site that inherits its size"
	},
	"--text-caption-plain": {
		value: "10.5px",
		citation:
			"osu!lazer type ramp — the caption size with no leading of its own: the line-height stays whatever the surrounding text sets, which is not 1.5 under a text-sm dialog or control"
	},
	"--text-meta": { value: "10px", citation: "osu!lazer type ramp — mono meta, hints" },
	"--text-meta-copy": { value: "10px", citation: "osu!lazer type ramp — small copy blocks" },
	"--text-meta-copy--line-height": { value: "1.55", citation: "osu!lazer type ramp — small copy leading" },
	"--text-meta-note": { value: "10px", citation: "osu!lazer type ramp — field notes" },
	"--text-meta-note--line-height": { value: "1.5", citation: "osu!lazer type ramp — field note leading" },
	"--text-kbd": { value: "10px", citation: "osu!lazer type ramp — keycap" },
	"--text-kbd--line-height": { value: "14px", citation: "osu!lazer type ramp — keycap leading" },
	"--text-menu-label": { value: "10px", citation: "osu!lazer type ramp — menu section header" },
	"--text-menu-label--letter-spacing": {
		value: "0.08em",
		citation: "osu!lazer type ramp — menu section header tracking"
	},
	"--text-hud-label": { value: "10px", citation: "osu!lazer type ramp — HUD labels" },
	"--text-hud-label--letter-spacing": { value: "0.1em", citation: "osu!lazer type ramp — HUD label tracking" },
	"--text-row": { value: "11px", citation: "osu!lazer type ramp — list / dl rows" },
	"--text-wordmark": { value: "11px", citation: "osu!lazer type ramp — top-bar wordmark" },
	"--text-wordmark--letter-spacing": { value: "0.1em", citation: "osu!lazer type ramp — wordmark tracking" },
	"--text-panel-title": { value: "11px", citation: "osu!lazer type ramp — side-panel h2" },
	"--text-panel-title--letter-spacing": { value: "0.14em", citation: "osu!lazer type ramp — side-panel h2 tracking" },
	"--text-lede": { value: "11.5px", citation: "osu!lazer type ramp — paragraphs" },
	"--text-lede--line-height": { value: "1.55", citation: "osu!lazer type ramp — paragraph leading" },
	"--text-lede-loose": {
		value: "11.5px",
		citation: "osu!lazer type ramp — consent body; near-dup of --text-lede's leading (TODO.md)"
	},
	"--text-lede-loose--line-height": { value: "1.6", citation: "osu!lazer type ramp — consent body leading" },
	"--text-lede-plain": {
		value: "11.5px",
		citation:
			"osu!lazer type ramp — the paragraph size with no leading of its own, like --text-caption-plain: a menu row, a dialog step, a top-bar control"
	},
	"--text-title": { value: "12px", citation: "osu!lazer type ramp — row titles" },
	"--text-value": { value: "13px", citation: "osu!lazer type ramp — values" },
	"--text-display-sm": { value: "13.5px", citation: "osu!lazer type ramp — secondary display" },
	"--text-display": { value: "15px", citation: "osu!lazer type ramp — start-screen headline" },
	"--text-hud-key-count": {
		value: "17px",
		citation: "osu!lazer type ramp — HUD key count; near-dup of --text-percent-suffix (TODO.md)"
	},
	"--text-percent-suffix": {
		value: "17px",
		citation: "osu!lazer type ramp — the % glyph; near-dup of --text-hud-key-count (TODO.md)"
	},
	"--text-stat": { value: "22px", citation: "osu!lazer type ramp — big stat" },
	"--text-accuracy": { value: "30px", citation: "osu!lazer type ramp — accuracy readout" },
	"--text-accuracy--letter-spacing": {
		value: "-0.02em",
		citation: "osu!lazer type ramp — accuracy readout tracking"
	},
	"--text-combo": { value: "34px", citation: "osu!lazer type ramp, largest step — combo counter" },
	"--text-combo--letter-spacing": { value: "-0.01em", citation: "osu!lazer type ramp — combo counter tracking" },
	"--text-button-sm": { value: "0.8rem", citation: 'shadcn Button size="sm"' },
	"--text-tiny": { value: "0.65rem", citation: "skin-author line" }
};

const shape: Record<string, ChromeToken> = {
	"--border-width-hairline": { value: "1.5px", citation: "osu!lazer shape — the drop target's emphasis border" },
	"--radius-mark-tip": { value: "1.5px", citation: "osu!lazer type/shape — histogram bar tops" },
	"--radius-mark": { value: "1px", citation: "osu!lazer shape — timeline mark caps" },
	"--radius-bar": { value: "2px", citation: "osu!lazer shape — timeline bars" },
	"--radius-control": { value: "5px", citation: "osu!lazer shape — small controls, segment items" },
	"--radius-segment": { value: "7px", citation: "osu!lazer shape — segmented track, warning pill" },
	"--radius-card": { value: "9px", citation: "osu!lazer shape — the card radius" },
	"--radius-float": {
		value: "10px",
		citation: "osu!lazer shape — floating palettes; same value as shadcn --radius-lg, two tokens"
	},
	"--radius-dropzone": { value: "14px", citation: "osu!lazer shape — start-screen drop target" },
	"--radius-control-sm": { value: "min(var(--radius-md), 10px)", citation: "shadcn xs / icon-xs cap" },
	"--radius-control-md": { value: "min(var(--radius-md), 12px)", citation: "shadcn sm / icon-sm cap" },
	"--shadow-float": { value: "0 12px 24px -8px rgba(0, 0, 0, 0.6)", citation: "floating palettes" },
	"--shadow-mark-ring": { value: "0 0 0 1px #ffffff66", citation: "selected frame marks" },
	"--blur-float": { value: "8px", citation: "floating palettes" },
	"--blur-hud": { value: "6px", citation: "watch-HUD tile" },
	"--skew-brand": { value: "-11.3deg", citation: "osu!-logo slant (see TopBar)" },
	"--skew-brand-inverse": { value: "11.3deg", citation: "counter-skew keeping letters upright inside the slant" }
};

/** spacing rhythm and fixed dimensions share Tailwind's --spacing-* namespace
 * (ADR 0011, mechanism spike): one declaration generates every p/m/gap/inset/
 * w/h/size form used. role names carry the plan's --space- / --size- split */
const spacing: Record<string, ChromeToken> = {
	"--spacing-hairline": { value: "1.5px", citation: "osu!lazer spacing rhythm — sub-pixel insets" },
	"--spacing-micro": { value: "2px", citation: "osu!lazer spacing rhythm — tight gaps" },
	"--spacing-inset": { value: "3px", citation: "osu!lazer spacing rhythm — dense row padding, mark insets" },
	"--spacing-nudge": { value: "3.5px", citation: "osu!lazer spacing rhythm — mark centre nudge" },
	"--spacing-tight": { value: "5px", citation: "osu!lazer spacing rhythm — control padding, small gaps" },
	"--spacing-stack": { value: "7px", citation: "osu!lazer spacing rhythm — section stack gap" },
	"--spacing-card": { value: "9px", citation: "osu!lazer spacing rhythm — card block padding" },
	"--spacing-card-loose": { value: "11px", citation: "osu!lazer spacing rhythm — loose card padding" },
	"--spacing-mark-thin": { value: "1.5px", citation: "osu!lazer marks — meh/ok tick width" },
	"--spacing-mark": { value: "2px", citation: "osu!lazer marks — miss tick, object mark" },
	"--spacing-mark-dot": { value: "3px", citation: "osu!lazer marks — drop / fail cap" },
	"--spacing-mark-cap": { value: "5px", citation: "osu!lazer marks — fail / drop cap width" },
	"--spacing-slider-drop-cap-offset": {
		value: "0.75px",
		citation: "overview slider-drop cap — centres its 3px width over the 1.5px severity tick"
	},
	"--spacing-circle-marker-inset": {
		value: "4px",
		citation: "object-lane circle marker — vertical inset within the 17px lane"
	},
	"--spacing-dot": { value: "5px", citation: "status dots" },
	"--spacing-swatch": { value: "7px", citation: "colour swatches, history dots" },
	"--spacing-playhead-cap": { value: "9px", citation: "playhead cap height" },
	"--spacing-playhead-line-offset": { value: "1px", citation: "shared timeline playhead — half its 2px stem width" },
	"--spacing-playhead-cap-offset": { value: "4px", citation: "shared timeline playhead — half its 8px cap width" },
	"--spacing-lane-hold": { value: "13px", citation: "hold-lane height" },
	"--spacing-lane-key": { value: "17px", citation: "object / key-lane height" },
	"--spacing-lane-velocity": { value: "34px", citation: "velocity-lane height" },
	"--spacing-lane-gutter": {
		value: "74px",
		citation: "lane label column width; same value as --spacing-histogram, two tokens"
	},
	"--spacing-histogram": {
		value: "74px",
		citation: "histogram height; same value as --spacing-lane-gutter, two tokens"
	},
	"--spacing-strip": { value: "26px", citation: "overview-strip height" },
	"--spacing-control": { value: "26px", citation: "segmented-control height" },
	"--spacing-rail-indicator": { value: "18px", citation: "tab-rail indicator" },
	"--spacing-rail-tile": { value: "38px", citation: "tab-rail button" },
	"--spacing-rail": { value: "46px", citation: "tab-rail width" },
	"--spacing-btn-jump": { value: "22px", citation: "transport jump buttons" },
	"--spacing-btn-tool": { value: "26px", citation: "tool-palette buttons" },
	"--spacing-btn-flank": { value: "30px", citation: "transport flank buttons" },
	"--spacing-tile-grade": { value: "42px", citation: "grade tiles" },
	"--spacing-readout": { value: "30px", citation: "numeric readout column" },
	"--spacing-slider-col": { value: "110px", citation: "settings slider column" },
	"--spacing-key-tile": { value: "50px", citation: "watch-HUD key tile" },
	"--spacing-time-col": { value: "86px", citation: "transport time column" },
	"--spacing-nav-col": { value: "160px", citation: "settings nav column" },
	"--spacing-menu-w": { value: "220px", citation: "top-bar menu" },
	"--spacing-open-menu-w": { value: "340px", citation: "open menu" },
	"--spacing-dropzone-w": { value: "420px", citation: "drop zone" },
	"--spacing-dialog-export-w": { value: "452px", citation: "export dialog" },
	"--spacing-dialog-video-w": { value: "520px", citation: "video dialog" },
	"--spacing-dialog-max-w": { value: "calc(100% - 2rem)", citation: "shadcn Dialog viewport width cap" },
	"--spacing-dialog-max-h": {
		value: "calc(100dvh - 2rem)",
		citation: "help and settings dialog viewport height cap"
	},
	"--spacing-dialog-tall-max-h": {
		value: "calc(100dvh - 4rem)",
		citation: "video export dialog viewport height cap"
	},
	"--spacing-dialog-taller-max-h": { value: "calc(100dvh - 5rem)", citation: "open menu viewport height cap" },
	"--spacing-browser-dialog-w": {
		value: "min(760px, calc(100vw - 4rem))",
		citation: "replay browser width and viewport margin"
	},
	"--spacing-browser-dialog-h": {
		value: "min(680px, calc(100dvh - 4rem))",
		citation: "replay browser height and viewport margin"
	},
	"--spacing-side-panel": { value: "400px", citation: "shell's right column" },
	"--spacing-switch-h": { value: "18.4px", citation: "shadcn Switch default height" },
	"--spacing-switch-w": { value: "32px", citation: "shadcn Switch default width" },
	"--spacing-switch-sm-h": { value: "14px", citation: "shadcn Switch sm height" },
	"--spacing-switch-sm-w": { value: "24px", citation: "shadcn Switch sm width" },
	"--spacing-rail-indicator-rest": {
		value: "4px",
		citation: "tab-rail indicator, inactive (docs/adr/0010's rail states)"
	},
	"--spacing-chip": { value: "19px", citation: "top-bar version chips" },
	"--spacing-row-loose": { value: "6px", citation: "analysis-panel stat rows" },
	"--spacing-zoom-readout": { value: "52px", citation: "zoom-controls numeric readout min-width" },
	"--spacing-settings-frame": { value: "26rem", citation: "settings dialog category frame height" },
	"--spacing-keybind-capture": { value: "7.5rem", citation: "keybinds capture button min-width" },
	"--spacing-history": { value: "236px", citation: "open-menu recents max-height" },
	"--spacing-arrow-centre": {
		value: "calc(-50% - var(--spacing-micro))",
		citation: "tooltip arrow — half its height back, then --spacing-micro under the popup edge"
	},
	"--spacing-tab-fill": {
		value: "calc(100% - 1px)",
		citation: "shadcn Tabs trigger — its list's height less the 1px the list inset leaves"
	}
};

export const CHROME_TOKENS: Record<string, ChromeToken> = {
	...inkRamp,
	...surfaces,
	...primaryFamily,
	...grades,
	...type,
	...shape,
	...spacing
};

/** every --grade-* / --graph-* / lattice token this manifest claims, mapped to
 * the OsuColour port entry it must equal. chrome-tokens.test.ts reads this to
 * pin the stylesheet to osu-colours.ts, so a hand-tweaked hex that claims to
 * be a grade colour cannot slip through */
export const OSU_COLOUR_PINS: Record<string, string> = {
	"--grade-great": OSU_COLOUR.blue,
	"--grade-ok": OSU_COLOUR.green,
	"--grade-meh": OSU_COLOUR.yellow,
	"--grade-miss": OSU_COLOUR.red,
	"--grade-ungraded": UNGRADED_COLOUR,
	"--grade-great-on": GRADE_ON_COLOUR.great,
	"--grade-ok-on": GRADE_ON_COLOUR.ok,
	"--grade-meh-on": GRADE_ON_COLOUR.meh,
	"--grade-miss-on": GRADE_ON_COLOUR.miss,
	"--grade-meh-band": GRADE_BAND_COLOUR.meh,
	"--grade-ok-band": GRADE_BAND_COLOUR.ok,
	"--grade-great-band": GRADE_BAND_COLOUR.great,
	"--graph-velocity": OSU_COLOUR.pink2,
	"--lattice-on": OSU_COLOUR.blue,
	"--lattice-off": OSU_COLOUR.yellow,
	"--lattice-unknown": "#71717a"
};

/** prefixes whose declarations in index.css are design tokens and must be in
 * the manifest. a new token family joins this list the day it is written */
export const DESIGN_TOKEN_PREFIXES = [
	"--foreground",
	"--muted-foreground",
	"--surface-",
	"--border",
	"--primary",
	"--grade-",
	"--graph-",
	"--hud-",
	"--lattice-",
	"--warning",
	"--danger-",
	"--hp-",
	"--text-",
	"--leading-",
	"--radius-",
	"--shadow-",
	"--blur-",
	"--skew-",
	"--spacing-"
] as const;
