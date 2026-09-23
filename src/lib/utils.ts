import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge, getDefaultConfig, type DefaultClassGroupIds } from "tailwind-merge";

// match index.css's roles so font sizes merge independently of ink, and every
// renamed measurement still replaces the primitive default it stands in for.
// a role missing from a scale below is not an error tailwind-merge can report:
// the class is simply unknown, both survive the merge, and whichever rule the
// stylesheet emits LAST silently wins -- which is how sm:max-w-sm outlived the
// export dialogs' own widths, and how a base rounded-lg outlived every role
// radius. utils.test.ts walks chrome-tokens.ts so the lists below cannot fall
// behind the vocabulary, and ships no citations of its own. max-w-dialog and
// the max-h-dialog* caps are @utility names rather than scale values, so they
// are class groups instead
const defaultConflicts: Partial<Record<DefaultClassGroupIds, readonly DefaultClassGroupIds[]>> =
	getDefaultConfig().conflictingClassGroups;
const withSides = (...groups: DefaultClassGroupIds[]) =>
	groups.flatMap((group) => [group, ...(defaultConflicts[group] ?? [])]);

const twMerge = extendTailwindMerge<"segmented">({
	extend: {
		classGroups: {
			"max-w": [{ "max-w": ["dialog"] }],
			"max-h": [{ "max-h": ["dialog", "dialog-tall", "dialog-taller"] }],
			"border-w": [{ border: ["hairline"] }],
			"skew-x": [{ "skew-x": ["brand", "brand-inverse"] }],
			// a recipe laid over a component's own styles: tailwind emits the
			// recipe before the single-property utilities, so without this the
			// base (ToggleGroup's rounded-lg) wins whatever the call site says
			segmented: ["segmented"]
		},
		conflictingClassGroups: {
			segmented: withSides("rounded", "border-w", "border-color", "bg-color", "p")
		},
		theme: {
			radius: [
				"mark-tip",
				"mark",
				"bar",
				"control",
				"segment",
				"card",
				"float",
				"dropzone",
				"control-sm",
				"control-md"
			],
			shadow: ["float", "mark-ring"],
			blur: ["float", "hud"],
			leading: ["caption-tight"],
			spacing: [
				"hairline",
				"micro",
				"inset",
				"nudge",
				"tight",
				"stack",
				"card",
				"card-loose",
				"mark-thin",
				"mark",
				"mark-dot",
				"mark-cap",
				"slider-drop-cap-offset",
				"circle-marker-inset",
				"dot",
				"swatch",
				"playhead-cap",
				"playhead-line-offset",
				"playhead-cap-offset",
				"lane-hold",
				"lane-key",
				"lane-velocity",
				"lane-gutter",
				"histogram",
				"strip",
				"control",
				"rail-indicator",
				"rail-tile",
				"rail",
				"btn-jump",
				"btn-tool",
				"btn-flank",
				"tile-grade",
				"readout",
				"slider-col",
				"key-tile",
				"time-col",
				"nav-col",
				"menu-w",
				"open-menu-w",
				"dropzone-w",
				"dialog-export-w",
				"dialog-video-w",
				"dialog-max-w",
				"dialog-max-h",
				"dialog-tall-max-h",
				"dialog-taller-max-h",
				"browser-dialog-w",
				"browser-dialog-h",
				"side-panel",
				"switch-h",
				"switch-w",
				"switch-sm-h",
				"switch-sm-w",
				"rail-indicator-rest",
				"chip",
				"row-loose",
				"zoom-readout",
				"settings-frame",
				"keybind-capture",
				"history",
				"arrow-centre",
				"tab-fill"
			],
			text: [
				"section-label",
				"mini-label",
				"history-detail",
				"mini",
				"micro",
				"caption",
				"caption-tight",
				"caption-plain",
				"meta",
				"meta-copy",
				"meta-note",
				"kbd",
				"menu-label",
				"hud-label",
				"row",
				"wordmark",
				"panel-title",
				"lede",
				"lede-loose",
				"lede-plain",
				"title",
				"value",
				"display-sm",
				"display",
				"hud-key-count",
				"percent-suffix",
				"stat",
				"accuracy",
				"combo",
				"button-sm",
				"tiny"
			]
		}
	}
});

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
