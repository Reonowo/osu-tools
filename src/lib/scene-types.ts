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
	warnings: LoadedSceneWarning[];
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

export type FrameChanges =
	| { updated: IndexedFrame[]; inserted: IndexedFrame[]; removed: number[] }
	| { fullFrames: FrameDto[] };

export interface EditDelta {
	revision: number;
	frames: FrameChanges | null;
	playerName: string | null;
	timestampTicks: string;
	dirty: boolean;
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
	| { type: "sliderRepeat"; hit: boolean }
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
	kind: RenderKind;
}

export type RenderKind =
	| { type: "circle" }
	| RenderSlider
	| { type: "spinner"; duration: number; spinsRequired: number; maxBonusSpins: number };

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
	| { kind: "notEditable"; reason: string };

/** mirrors settings.rs OverlayPrefs */
export interface OverlaySettings {
	cursorPath: boolean;
	clickMarkers: boolean;
	frameMarkers: boolean;
	hideCursor: boolean;
	keyOverlay: boolean;
	/** ms; lazer's ReplayAnalysisDisplayLength (200-2000, default 800) */
	displayLength: number;
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
}

/** mirrors settings.rs Settings */
export interface Settings {
	osuStablePath: string | null;
	/** linear amplitude percent, 0-100 */
	volume: number;
	overlays: OverlaySettings;
	recents: RecentReplay[];
	editing: EditingSettings;
	effects: EffectSettings;
}
