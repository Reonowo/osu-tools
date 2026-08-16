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
	/// rgba rows; consumers pick comboColours[comboColourIndex % length]
	comboColours: [number, number, number, number][];
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
	| { kind: "exportOverflow"; field: string };

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

/** mirrors settings.rs RecentReplay. the beatmap association is what
 * load_recent_replay reopens through; it is rust's to read and refresh, so
 * openRecent sends only osrPath back across the boundary. every association
 * field is absent on entries written before it existed */
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
 * render effects. they sit beside the effects rather than with the volumes
 * because that is lazer's own split -- `Sections/Gameplay/AudioSettings` holds
 * these two while `Sections/Audio` holds the levels and the offset */
export interface GameplaySettings {
	/** 0-1; osuconfigmanager.cs:144 PositionalHitsoundsLevel, default 0.2 */
	positionalHitsoundLevel: number;
	/** comboeffects.cs:59 -- whether the play's FIRST combo break sounds even
	 * when the combo lost was small. lazer defaults it on */
	alwaysPlayFirstComboBreak: boolean;
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
}
