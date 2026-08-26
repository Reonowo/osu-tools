// the export dialog's danser section, as data: each control is a label and
// the path it reads/writes inside the danser blob's `settings` subtree --
// which the backend merges into the per-invocation patch verbatim. this is
// deliberately the ONE frontend file that names danser settings keys; the
// defaults mirror danser 0.11.0's own (captured from the pinned release's
// generated settings file), so an untouched control changes nothing in the
// patch's effect

/** the backend id the seam keys this blob by, and the id the dialog matches
 * to decide whether this section belongs on screen. it lives here so the
 * name stays written in exactly one frontend file -- a consumer comparing
 * against a literal is the seam leaking one string at a time */
export const DANSER_BACKEND_ID = "danser";

/** the subtree key inside the blob whose contents are danser settings paths;
 * everything the section writes lives under it */
export const DANSER_SETTINGS_SUBTREE = "settings";

export interface DanserToggle {
	label: string;
	/** the tooltip line; what the control changes in the rendered video */
	description: string;
	path: readonly string[];
	default: boolean;
}

/** the boolean controls: motion blur, the hud toggles, the cursor options */
export const DANSER_TOGGLES: readonly DanserToggle[] = [
	{
		label: "motion blur",
		description: "smooths fast cursor motion by blending frames; slower to render",
		path: [DANSER_SETTINGS_SUBTREE, "Recording", "MotionBlur", "Enabled"],
		default: false
	},
	{
		label: "score & accuracy",
		description: "danser's score, accuracy and grade display",
		path: [DANSER_SETTINGS_SUBTREE, "Gameplay", "Score", "Show"],
		default: true
	},
	{
		label: "health bar",
		description: "danser's health bar",
		path: [DANSER_SETTINGS_SUBTREE, "Gameplay", "HpBar", "Show"],
		default: true
	},
	{
		label: "key overlay",
		description: "danser's pressed-keys column",
		path: [DANSER_SETTINGS_SUBTREE, "Gameplay", "KeyOverlay", "Show"],
		default: true
	},
	{
		label: "hit error meter",
		description: "danser's early/late hit bar",
		path: [DANSER_SETTINGS_SUBTREE, "Gameplay", "HitErrorMeter", "Show"],
		default: true
	},
	{
		label: "pp counter",
		description: "danser's live pp estimate",
		path: [DANSER_SETTINGS_SUBTREE, "Gameplay", "PPCounter", "Show"],
		default: true
	},
	{
		label: "cursor ripples",
		description: "a ripple on every click",
		path: [DANSER_SETTINGS_SUBTREE, "Cursor", "CursorRipples"],
		default: false
	},
	{
		label: "cursor scales with CS",
		description: "sizes the cursor relative to the map's circle size",
		path: [DANSER_SETTINGS_SUBTREE, "Cursor", "ScaleToCS"],
		default: false
	}
];

/** the encoder rows the dialog offers, under vendor labels. these ids are
 * ffmpeg encoder names -- danser's bundled ffmpeg is what probes and accepts
 * them, and the probe order in `video/danser/probe.rs` is the same list --
 * so they belong to this backend even though the id they land in
 * (`Settings.video.encoder`) is a renderer-agnostic core pref. a second
 * backend brings its own list rather than inheriting ffmpeg's vocabulary,
 * which is why the dialog renders these only for this backend */
export const DANSER_ENCODER_CHOICES = [
	{ id: "auto", label: "auto" },
	{ id: "h264_nvenc", label: "nvidia" },
	{ id: "h264_qsv", label: "intel" },
	{ id: "h264_amf", label: "amd" },
	{ id: "libx264", label: "software" }
] as const;

/** the background dim, stored as danser stores it (0-1, 1 fully black) and
 * shown as the percent slider every dim control in this app uses */
export const DANSER_BACKGROUND_DIM = {
	label: "background dim",
	path: [DANSER_SETTINGS_SUBTREE, "Playfield", "Background", "Dim", "Normal"] as readonly string[],
	default: 0.95
};
