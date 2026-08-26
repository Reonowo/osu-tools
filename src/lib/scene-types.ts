// the typescript mirror of the loadedscene json contract. field names are
// frozen by the rust serialization tests (scene.rs, render_plan.rs,
// error.rs); this file is the only frontend declaration of these shapes

export interface LoadedScene {
	/// session identity; increments on each load, invalidates prior edits
	epoch: number;
	beatmap: BeatmapMeta;
	replay: ReplayMeta;
	frames: FrameDto[];
	renderPlan: RenderPlan;
	simulation: SimulationDto;
	audioPath: string | null;
	backgroundPath: string | null;
	/// the beatmap's OWN hit-sample files, keyed by the lookup name the chain
	/// asks for (a lowercased stem, or a full file name for an explicit
	/// `hitSample`). empty for a map that ships none, which is most of them --
	/// the bundled default set answers those. values are absolute paths for
	/// tauri's convertFileSrc
	sampleFiles: Record<string, string>;
	/** mirrors scene.rs `texture_files`: the beatmap's OWN image files, keyed by
	 * lowercased file NAME (extension included) rather than by lookup name --
	 * which of `hitcircle@2x.png` and `hitcircle.png` answers a `hitcircle`
	 * lookup is an era rule, and era rules live in `playback/lookup-chain.ts`.
	 * the same shape `SkinManifest.files` has, for the same reason */
	textureFiles: Record<string, string>;
	warnings: LoadedSceneWarning[];
	/// shipped only for pre-lazer authoritative scenes; always describes the
	/// loaded file, never in-session edits
	integrity: IntegrityReport | null;
	/// present when the play ended early: the header judged fewer objects
	/// than the map has. the integrity report then annotates instead of
	/// rendering verdicts, and the export dialog states what a regenerating
	/// export will contain. withheld on a consented beatmap mismatch
	incompleteness: Incompleteness | null;
}

/// judged-vs-total identity computed at load from the header counts alone;
/// judged < total by construction
export interface Incompleteness {
	judged: number;
	total: number;
}

export interface IntegrityReport {
	rows: IntegrityRow[];
	crossCheck: {
		sections: number;
		gekiKatsu: number;
		/// sections − (geki + katu): the sections that ended without a burst
		/// (stable awards neither geki nor katu to a section containing a
		/// miss or a 50). signed, so an impossible header reads as the
		/// inconsistency it is
		sectionsWithoutBurst: number;
		countMiss: number;
		count50: number;
	};
	lifeBarPresent: boolean;
}

/// one compared field; `perfect` rides as 0/1 under the shared shape
export interface IntegrityRow {
	field: string;
	header: number;
	simulated: number;
	match: boolean;
}

export interface BeatmapMeta {
	title: string;
	artist: string;
	creator: string;
	version: string;
	beatmapId: number;
	beatmapSetId: number;
	formatVersion: number;
	audioLeadIn: number;
	circleSize: number;
	approachRate: number;
	overallDifficulty: number;
	hpDrainRate: number;
	md5: string;
}

export interface ReplayMeta {
	playerName: string | null;
	version: number;
	mods: number;
	count300: number;
	count100: number;
	count50: number;
	countGeki: number;
	countKatsu: number;
	countMiss: number;
	totalScore: number;
	maxCombo: number;
	perfect: boolean;
	/// .net ticks as a decimal string (exceeds 2^53)
	timestampTicks: string;
	onlineScoreId: string;
	beatmapMd5: string | null;
}

export interface FrameDto {
	time: number;
	x: number;
	y: number;
	/// raw bitfield: m1=1, m2=2, k1=4, k2=8, smoke=16
	buttons: number;
}

export type EditOp =
	| { kind: "moveFrames"; moves: { index: number; x: number; y: number }[] }
	| { kind: "insertFrames"; frames: FrameDto[] }
	| { kind: "deleteFrames"; indices: number[] }
	| { kind: "setButtons"; sets: { index: number; buttons: number }[] }
	| { kind: "setPlayerName"; name: string | null }
	| { kind: "setTimestamp"; ticks: string };

export interface IndexedFrame {
	index: number;
	frame: FrameDto;
}

/// export_replay's answer: where the file landed, its size, and -- for
/// regenerating exports only -- the nine values the written header claims
export interface ExportResult {
	path: string;
	bytes: number;
	regenerated: RegeneratedFields | null;
}

export interface RegeneratedFields {
	count300: number;
	count100: number;
	count50: number;
	countGeki: number;
	countKatsu: number;
	countMiss: number;
	maxCombo: number;
	perfect: boolean;
	totalScore: number;
}

export type FrameChanges =
	| { updated: IndexedFrame[]; inserted: IndexedFrame[]; removed: number[] }
	| { fullFrames: FrameDto[] };

export interface EditDelta {
	revision: number;
	frames: FrameChanges | null;
	playerName: string | null;
	timestampTicks: string;
	/// the union of the two split flags, kept for the dirty chip
	dirty: boolean;
	/// the document's dirty split: the export dialog keys its path
	/// expectation off which kind of dirty the session is
	framesDirty: boolean;
	metadataDirty: boolean;
	canUndo: boolean;
	canRedo: boolean;
	history: { labels: string[]; cursor: number };
	simulation: SimulationDto | null;
}

export type Grade = "great" | "ok" | "meh" | "miss";

export type JudgementKindDto =
	| { type: "circle"; grade: Grade }
	| { type: "sliderHead"; hit: boolean }
	| { type: "sliderTick"; hit: boolean }
	/** `repeatIndex` is 0-based: the repeat that ends span `repeatIndex`, which
	 * is lazer's node `repeatIndex + 1`. it rides on the event so a consumer
	 * picking this repeat's samples never has to recover the node by counting
	 * repeat events -- a positional join goes silently wrong the first time
	 * emission order changes */
	| { type: "sliderRepeat"; hit: boolean; repeatIndex: number }
	| { type: "sliderTail"; hit: boolean }
	| { type: "sliderAggregate"; grade: Grade }
	| { type: "spinnerSpin" }
	| { type: "spinnerBonus" }
	| { type: "spinnerFinal"; grade: Grade };

export interface JudgementEventDto {
	time: number;
	objectIndex: number;
	kind: JudgementKindDto;
	comboAfter: number;
	accuracyAfter: number;
}

export interface TotalsDto {
	count300: number;
	count100: number;
	count50: number;
	countMiss: number;
	maxCombo: number;
}

export type SimulationDto =
	| { status: "authoritative"; events: JudgementEventDto[]; totals: TotalsDto }
	| { status: "notSimulated"; reason: "unsupportedMods" | "beatmapMismatch" };

export interface RenderPlan {
	playfield: { width: number; height: number };
	/** the BEATMAP's own declared palette, or null when it declared none.
	 *
	 * nullable because the engine stopped substituting: picking a palette is a
	 * skin decision and that layer has no concept of a skin. `skin/combo-colours.ts`
	 * is where a null is filled -- the skin's declared colours, else that skin's
	 * era default. per-object data is unaffected by the length, since the index is
	 * offset-based and the modulo is applied by the consumer */
	comboColours: [number, number, number, number][] | null;
	hitWindows: { great: number; ok: number; meh: number; miss: number };
	scale: number;
	preempt: number;
	fadeIn: number;
	objects: RenderObject[];
}

export interface RenderObject {
	startTime: number;
	endTime: number;
	/// stacked playfield coordinates
	position: [number, number];
	stackHeight: number;
	comboColourIndex: number;
	comboIndex: number;
	indexInCombo: number;
	preempt: number;
	fadeIn: number;
	/// what this object sounds when its own judgement lands. a circle and a
	/// spinner sound these; a slider is always empty, because a slider never
	/// sounds as a unit -- its head, repeats, tail and ticks each sound their
	/// own (see RenderNested.samples)
	samples: SampleLookup[];
	kind: RenderKind;
}

/** one skin-independent sample lookup: lazer's `HitSampleInfo` after its sample
 * control point has been applied, which is exactly what `ISkin.GetSample` is
 * handed. deliberately carries no path, no extension and no source -- resolving
 * those is the lookup chain's job, and keeping that split is what makes the
 * skin substitutable */
export interface SampleLookup {
	bank: "normal" | "soft" | "drum" | "none";
	name: "hitnormal" | "hitwhistle" | "hitfinish" | "hitclap" | "slidertick" | "spinnerbonus";
	/** the custom sample bank index when >= 2; the suffixed lookup name is
	 * tried first and falls back to the unsuffixed one */
	suffix: number | null;
	/** 0-100. the per-sample floor (`max(volume, 5)`) is a playback rule
	 * applied where playback happens, not here */
	volume: number;
	/** a `hitnormal` that plays UNDER this object's additions rather than
	 * instead of them */
	layered: boolean;
	/** set when the object named an explicit `hitSample` file. lazer models
	 * that as a normal-bank `hitnormal` that prepends the filename and its
	 * extension-stripped form to its lookup names, which is why `bank` and
	 * `name` still read as that pair */
	filename: string | null;
}

export type RenderKind =
	| { type: "circle" }
	| RenderSlider
	| {
			type: "spinner";
			duration: number;
			spinsRequired: number;
			maxBonusSpins: number;
			/** what a BONUS spin sounds: the spinner's own sample under the
			 * `spinnerbonus` name. an ordinary spin carries no samples at all
			 * and is silent, as it is in lazer */
			bonusSamples: SampleLookup[];
	  };

export interface RenderSlider {
	type: "slider";
	/// head-relative flat polyline [x0, y0, x1, y1, ...]
	vertices: number[];
	cumulativeLengths: number[];
	distance: number;
	segmentEnds: number[];
	repeatCount: number;
	spanCount: number;
	spanDuration: number;
	duration: number;
	/// stacked
	endPosition: [number, number];
	snakeInDuration: number;
	nested: RenderNested[];
}

export interface RenderNested {
	kind: "head" | "tick" | "repeat" | "tail";
	spanIndex: number;
	time: number;
	/// stacked
	position: [number, number];
	pathProgress: number;
	preempt: number;
	fadeIn: number;
	/// what this piece sounds when its own judgement lands: the head takes
	/// node 0, a repeat takes node `spanIndex + 1`, the tail takes the last
	/// node, and a tick takes the slider's own sample renamed to `slidertick`
	samples: SampleLookup[];
}

export type LoadedSceneWarning =
	| { kind: "audioMissing" }
	| { kind: "modsNotSimulated"; mods: number }
	| { kind: "beatmapMismatch"; expectedMd5: string; actualMd5: string };

export type IpcError =
	| { kind: "replayParse"; message: string }
	| { kind: "beatmapParse"; message: string }
	| { kind: "beatmapNotFound"; md5: string }
	| { kind: "beatmapMismatch"; expectedMd5: string; actualMd5: string }
	| { kind: "osuDbNotFound"; searched: string[] }
	| { kind: "unsupportedMode"; mode: string }
	| { kind: "resourceLimit"; cap: string; limit: number; actual: number }
	| { kind: "io"; message: string }
	| { kind: "internal"; message: string }
	| { kind: "invalidEdit"; message: string }
	| { kind: "staleSession" }
	| { kind: "notEditable"; reason: string }
	| { kind: "fileExists"; path: string }
	| { kind: "exportOverflow"; field: string }
	| { kind: "rendererNotInstalled" }
	| { kind: "stagingFailed"; message: string }
	| { kind: "renderFailed"; detail: string }
	| { kind: "cancelled" }
	| { kind: "exportBusy" };

/** mirrors settings.rs OverlayPrefs */
export interface OverlaySettings {
	cursorPath: boolean;
	clickMarkers: boolean;
	frameMarkers: boolean;
	/** darkens idle (no-button) frame markers so they read against the cursor
	 * path -- this viewer's own pref, no lazer counterpart */
	tintIdleMarkers: boolean;
	hideCursor: boolean;
	keyOverlay: boolean;
	/** ms; lazer's ReplayAnalysisDisplayLength (200-2000, default 800) */
	displayLength: number;
	/** the playfield grid's spacing in osu!px, `0` meaning off. a plain
	 * number rather than a literal union: json can keep no such promise, so
	 * the allowed set is enforced by clampPlayfieldGridSpacing and by sanitize() */
	playfieldGrid: number;
}

/** mirrors settings.rs RecentReplay. the beatmap association is what every
 * open resolves through; it belongs to the `.osr` and this entry is only where
 * rust stores it (docs/adr/0005), so openReplay sends nothing but the path back
 * across the boundary. every association field is absent on entries written
 * before it existed */
export interface RecentReplay {
	osrPath: string;
	title: string;
	version: string;
	playerName: string | null;
	/** 0-1 */
	accuracy: number;
	maxCombo: number;
	/** unix milliseconds */
	openedAtMs: number;
	/** the .osu or .osz the last open resolved */
	beatmapPath: string | null;
	/** the folder that source sits in -- never an .osz cache lease */
	beatmapDir: string | null;
	beatmapMd5: string | null;
	/** the user's recorded consent to a hash mismatch, tied to beatmapMd5 */
	allowMismatch: boolean;
}

/** mirrors settings.rs EditingPrefs. governs the (future) replay-editing
 * surface -- kept separate from OverlaySettings, which these are not */
export interface EditingSettings {
	snapToLattice: boolean;
	warnOnOverwrite: boolean;
}

/** mirrors settings.rs EffectPrefs. `enabled` is the master: an effect is
 * live only when the master and its own flag are both on (state/defaults.ts's
 * effectiveEffects is the one place that fold happens), so switching the
 * master off never rewrites the granular values */
export interface EffectSettings {
	enabled: boolean;
	hitAnimations: boolean;
	hitEffects: boolean;
	cursorGlow: boolean;
	cursorTrail: boolean;
	followPoints: boolean;
	/**
	 * lazer's `BeatmapSkin` (beatmapskinprovidingcontainer.cs:25), inverted so
	 * the stored default is `false` -- a mapset designed around its own look
	 * presents as its author intended unless the user says otherwise.
	 *
	 * drops the beatmap's own IMAGE files from the texture lookup chain, and
	 * nothing else. deliberately independent of `ignoreBeatmapHitsounds` beside
	 * it in the audio settings: lazer splits the two for the same reason, so a
	 * map's hitsounding can be kept while its art is refused.
	 *
	 * it lives with the effects rather than with the audio group because it is a
	 * visual decision, and it is shown in the gameplay category beside the other
	 * things that decide what the playfield looks like
	 */
	ignoreBeatmapSkin: boolean;
	/** whether a great draws a judgement popup at all, DEFAULT OFF.
	 *
	 * greats drew none before any skin could be loaded, and a legacy skin ships
	 * a `hit300` that will answer found -- so without an explicit preference,
	 * picking any legacy skin would reintroduce a popup on every 300, which is
	 * the thing that hides the 100s and 50s a replay is opened to find. the
	 * choice is the user's rather than a side effect of which skin is loaded;
	 * the skin still owns what a 300 looks like when it is shown */
	show300Judgements: boolean;
	/** percent 0-100, 100 fully black; matches osu!'s own dim control. rides
	 * on this group for where it belongs in the settings dialog, NOT because
	 * the master gates it -- it is not an effect and effectiveEffects passes
	 * it through untouched */
	backgroundDim: number;
}

/** mirrors settings.rs TimelinePrefs. which of the timeline dock's layers
 * draw: the object lane's decorations and the overview strip's severity
 * ticks. the selected press's extended tether is selection chrome and
 * deliberately not gated here */
export interface TimelineSettings {
	hitWindowBands: boolean;
	tethers: boolean;
	nestedMarks: boolean;
	severityTicks: boolean;
}

/** one key an action answers to, as it is persisted. the hotkey string is the
 * @tanstack/hotkeys canonical form -- what a registration takes verbatim -- and
 * the physical codes ride alongside it unconditionally, because the entry's
 * matcher (printed character or physical key) is what decides which half is
 * matched against; see docs/adr/0002-keybindings-store-key-and-code.md */
export interface KeybindBinding {
	hotkey: string;
	codes: readonly string[];
}

/** mirrors settings.rs KeybindOverrides: sparse, action -> its ordered binding
 * slots. only actions the user actually changed appear; an absent action
 * follows the app's default and a present-but-empty one is deliberately
 * unbound. rust stores it opaquely, so this is the only declaration of what an
 * action or a binding is */
export type KeybindOverrides = Record<string, readonly KeybindBinding[]>;

/** mirrors settings.rs AudioPrefs: everything the audio category holds except
 * the master, which keeps its own top-level `Settings.volume` key so no
 * existing settings file needs migrating. these are grouped rather than
 * flattened because they cross the ipc boundary as one argument -- a row of
 * loose numbers there is a silent-swap waiting to happen */
export interface AudioSettings {
	/** linear amplitude percent 0-100; the effective gain is master x this */
	musicVolume: number;
	hitsoundVolume: number;
	/** ms, -500..500. positive moves the playfield, judgements and hit samples
	 * ahead of the music -- equivalently, delays the music against everything
	 * else. a plain number rather than a bounded type: json can keep no such
	 * promise, so clampAudioOffset and sanitize() are the validation */
	offsetMs: number;
	/** lazer's `BeatmapHitsounds`, inverted so the stored default is false.
	 * drops the beatmap's own sample FILES from the lookup chain; the map's
	 * design -- which bank each object draws from, which additions fire,
	 * per-object volume -- is object data and keeps applying */
	ignoreBeatmapHitsounds: boolean;
}

/** mirrors settings.rs GameplayPrefs: the gameplay preferences that are not
 * render effects. they persist beside the effects rather than with the volumes
 * because that is lazer's own split -- `Sections/Gameplay/AudioSettings` holds
 * these two while `Sections/Audio` holds the levels and the offset. that is
 * where they are STORED, not where they are shown: both render in the audio
 * category, and the keys stayed here so no settings file needs migrating
 * (AudioCategory.tsx argues the placement) */
export interface GameplaySettings {
	/** 0-1; osuconfigmanager.cs:144 PositionalHitsoundsLevel, default 0.2 */
	positionalHitsoundLevel: number;
	/** comboeffects.cs:59 -- whether the play's FIRST combo break sounds even
	 * when the combo lost was small. lazer defaults it on */
	alwaysPlayFirstComboBreak: boolean;
	/** osurulesetconfigmanager.cs:20, default on -- whether the body snakes in
	 * over preempt/3 while approaching (snakingsliderbody.cs:84). off also
	 * lifts drawableosuhitobject.cs:163's preempt/3 fade-in delay on each
	 * span's first end circle, which exists only to wait for that snake */
	snakingInSliders: boolean;
	/** osurulesetconfigmanager.cs:21, default on -- whether the body retracts
	 * behind the ball once the head is hit (snakingsliderbody.cs:91,95). off
	 * also drops drawableslider.cs:360's short body fade at the slider's end,
	 * whose whole job is to smooth that retract away */
	snakingOutSliders: boolean;
}

/** mirrors skin.rs SkinSource */
export type SkinSource = "bundled" | "stable" | "folder" | "imported";

/** mirrors skin.rs SkinEra -- the rule set a skin's lookups and drawing obey.
 * a property of the skin, never a setting */
export type SkinEra = "lazer" | "legacy";

/** mirrors skin.rs SkinLocator: both the KIND of location and the path, so a
 * folder skin and a stable one that happen to share a path still resolve
 * through their own rules */
export type SkinLocator =
	| { kind: "bundled" }
	| { kind: "stable"; path: string }
	| { kind: "folder"; path: string }
	| { kind: "imported"; path: string };

/** mirrors skin.rs SkinConfigDto. a null field means the skin did not answer,
 * which is distinct from a declared false or 0 -- the drawables' own defaults
 * apply only to a null, and each is cited at its draw site */
export interface SkinConfigDto {
	/** what a LegacySetting.Version lookup answers: the declared version or the
	 * latest. every version fork in the drawing code compares against this */
	version: number;
	isLatestVersion: boolean;
	/** the DECLARED palette, empty when the skin declared none */
	comboColours: [number, number, number, number][];
	sliderBorder: [number, number, number, number] | null;
	sliderTrackOverride: [number, number, number, number] | null;
	/** `[Colours] SliderBall` -- the ball's BASE colour (legacysliderball.cs:47),
	 * which the combo accent replaces only when the tint permission is on */
	sliderBall: [number, number, number, number] | null;
	/** `[Colours] SpinnerBackground` -- the old-style background's tint
	 * (legacyoldstylespinner.cs:44), else the drawable's flat grey */
	spinnerBackground: [number, number, number, number] | null;
	animationFramerate: number | null;
	layeredHitSounds: boolean | null;
	allowSliderBallTint: boolean | null;
	comboPrefix: string | null;
	comboOverlap: number | null;
	hitCirclePrefix: string | null;
	hitCircleOverlap: number | null;
	cursorCentre: boolean | null;
	cursorExpand: boolean | null;
	cursorRotate: boolean | null;
	cursorTrailRotate: boolean | null;
	hitCircleOverlayAboveNumber: boolean | null;
	spinnerFrequencyModulate: boolean | null;
	spinnerNoBlink: boolean | null;
	settings: Record<string, string>;
}

/** mirrors skin.rs SkinEntry -- one row in the picker */
export interface SkinEntry {
	locator: SkinLocator;
	name: string;
	author: string;
	source: SkinSource;
	era: SkinEra;
	/** a named reason this skin cannot load, or null. a refused skin still
	 * appears: omitting it would leave the user hunting for a skin they can see
	 * on disk */
	refusal: string | null;
}

/** mirrors skin.rs SkinFallback */
export interface SkinFallback {
	requested: SkinLocator;
	reason: string;
}

/** mirrors skin.rs SkinManifest: the resolved file map plus the decoded
 * configuration. held BESIDE the scene rather than on it, because a skin is
 * app-wide and changes without a scene reload */
export interface SkinManifest {
	locator: SkinLocator;
	name: string;
	author: string;
	source: SkinSource;
	era: SkinEra;
	/** lowercased relative path (extension included, `/`-joined for a file in a
	 * subdirectory) -> absolute path. the file map, not a lookup map: which of
	 * `cursor@2x.png` and `cursor.png` answers a `cursor` lookup is an era
	 * rule, and era rules live in the lookup chain. subdirectory keys are what
	 * a skin.ini prefix such as `HitCirclePrefix: Assets/default/default`
	 * resolves through */
	files: Record<string, string>;
	/** the file names whose image is 1x1 or smaller. shipping a blank asset is
	 * the standard way a skinner REMOVES an element, so this is a decision and
	 * not an absence -- it is what lets a texture lookup answer `empty` rather
	 * than `found`, keeping "the skin drew nothing" decidable without a canvas */
	blank: string[];
	config: SkinConfigDto;
	/** set when the requested locator did not resolve and the bundled default
	 * answered instead -- the miss posture, surfaced rather than swallowed */
	fellBack: SkinFallback | null;
}

/** mirrors settings.rs Settings */
export interface Settings {
	osuStablePath: string | null;
	/** the MASTER volume, linear amplitude percent 0-100. its own top-level key
	 * since before the other channels existed, and left there so a settings
	 * file written by an older build keeps its level */
	volume: number;
	audio: AudioSettings;
	gameplay: GameplaySettings;
	overlays: OverlaySettings;
	recents: RecentReplay[];
	editing: EditingSettings;
	effects: EffectSettings;
	timeline: TimelineSettings;
	keybinds: KeybindOverrides;
	/** app-wide, and deliberately NOT carried on a recents entry the way a
	 * beatmap association is: opening a recent replay must never silently change
	 * the app's whole appearance */
	skin: SkinLocator;
	/** the renderer-agnostic video export core; the per-backend half lives in
	 * rendererOptions beside it */
	video: VideoSettings;
	/** opaque per-backend blobs keyed by renderer id, persisted like keybind
	 * overrides: the blob dies with its backend on a swap, the typed core
	 * survives. one conventional key inside each blob is generic --
	 * `probedEncoder`, the cached encoder-probe winner */
	rendererOptions: RendererOptionsMap;
}

/** mirrors settings.rs VideoResolution: the closed preset set, serialized as
 * the `WIDTHxHEIGHT` string the dialog shows */
export type VideoResolution = "1280x720" | "1920x1080" | "2560x1440" | "3840x2160";

/** mirrors settings.rs SkinPolicy: whose skin the rendered video wears */
export type VideoSkinPolicy = "followApp" | "rendererDefault";

/** mirrors settings.rs VideoExportPrefs */
export interface VideoSettings {
	resolution: VideoResolution;
	/** 30 or 60; a plain number since json can keep no such promise --
	 * sanitize() is the validation */
	fps: number;
	/** `"auto"` (the probed winner decides, backend-side) or an explicit id */
	encoder: string;
	skinPolicy: VideoSkinPolicy;
	/** where the save dialog starts; the last directory a video landed in */
	lastVideoDir: string | null;
}

/** mirrors settings.rs RendererOptionsMap: backend id -> that backend's
 * opaque settings blob. this file declares no blob vocabulary on purpose:
 * the renderer-specific keys live only in lib/danser-section.ts, and the one
 * generic key (the probe cache) is lib/video-export-flow.ts's
 * PROBED_ENCODER_KEY */
export type RendererOptionsMap = Record<string, Record<string, unknown>>;

/** mirrors video::LicenseNote: one entry of the consent dialog's expando */
export interface RendererLicenseNote {
	name: string;
	detail: string;
}

/** mirrors video::RendererMetadata: everything the consent dialog renders,
 * supplied by the backend so nothing renderer-specific is hardcoded here */
export interface RendererMetadata {
	id: string;
	name: string;
	version: string;
	downloadBytes: number;
	source: string;
	notice: string;
	licenses: RendererLicenseNote[];
}

/** mirrors video::RendererStatus */
export interface VideoRendererStatus {
	installed: boolean;
	metadata: RendererMetadata;
	/** the backend's own log file when it keeps one -- the failure panel's
	 * "show the renderer log" affordance */
	logPath: string | null;
}

/** mirrors video::VideoStage. an export job's stream is staging -> rendering
 * -> moving; `installing` is the install operation's own stage on the same
 * channel */
export type VideoStage = "staging" | "rendering" | "moving" | "installing";

/** mirrors video::VideoProgress, the shared progress event channel's
 * payload. percent exists only in the rendering and installing stages;
 * speed/eta ride verbatim from the backend's own progress line */
export interface VideoProgressEvent {
	jobId: string;
	stage: VideoStage;
	percent?: number;
	speed?: string;
	eta?: string;
}

/** mirrors video::VideoExportResult */
export interface VideoExportResult {
	path: string;
	bytes: number;
}
