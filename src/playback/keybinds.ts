// the keybind table -- every action the app binds, declared once as data --
// and the pure model over it: the fold of a sparse override map onto those
// defaults, the capture a settings row arms, the steal that resolves a
// conflict, and the resolver for the edit-mode keys. pure: every import from
// the app itself is a type, erased at build, and @tanstack/react-hotkeys is
// imported for its parser/normaliser only (no dom, no react), so nothing here
// reaches the store, the renderer or tauri and its test runs headlessly the way
// shortcut-guards' does.
//
// the table is the complete inventory, playback and editing alike. a partial
// one could not answer "is this key free?", which is the question this module
// exists to answer, and it would make the uniqueness invariant meaningless.
// one row per *action*, not per key: erase selection answers to two keys and
// renders as one row holding both, and the viewport reset is one chord that
// occupies two physical zeros rather than two bindings.
//
// `owner` records where a keybind is *registered*, never where it is listed:
// everything is listed here, and one entry can have several registrations
// (play/pause splits over keydown and keyup, Escape over three listeners).
// `group` is the separate, user-facing question of which division of the
// keybinds settings category a row is listed under -- the tool keys are
// registered globally but are editing actions, so grouping by `owner` would
// produce a nonsense list

import {
	detectPlatform,
	formatForDisplay,
	hasNonModifierKey,
	matchesKeyboardEvent,
	normalizeHotkey,
	normalizeHotkeyFromParsed,
	normalizeKeyName,
	parseHotkey,
	parseKeyboardEvent
} from "@tanstack/react-hotkeys";
import type { SeverityGrade } from "../lib/judgement-nav";
import type { KeybindBinding, KeybindOverrides } from "../lib/scene-types";
import type { ToolId, ViewerMode } from "../state/store";

// the persisted shapes are declared once, with the rest of the wire contract;
// re-exported here because this is where every consumer of them already looks
export type { KeybindBinding, KeybindOverrides };

/** what a keybind does. one row per action; an action may hold two keys */
export type KeybindAction =
	| "playPause"
	| "seekBack"
	| "seekForward"
	| "frameStepBack"
	| "frameStepForward"
	| "restart"
	| "jumpNextOk"
	| "jumpPreviousOk"
	| "jumpNextMeh"
	| "jumpPreviousMeh"
	| "jumpNextMiss"
	| "jumpPreviousMiss"
	| "volumeUp"
	| "volumeDown"
	| "viewportReset"
	| "selectTool"
	| "lassoTool"
	| "moveTool"
	| "smoothTool"
	| "eraseTool"
	| "toggleSnap"
	| "cancel"
	| "eraseSelection"
	| "smoothSelection"
	| "openMenu"
	| "showHelp";

/** where a keybind is registered: `global` is use-playback-shortcuts, through
 * the one guard every binding passes; `gesture` is use-edit-tools, which needs
 * gesture-local state a generic registration point cannot see */
export type KeybindOwner = "global" | "gesture";

/** the user-facing division a row is listed under, in the keybinds settings
 * category and the help overlay alike. deliberately not `owner` */
export type KeybindGroup = "playback" | "viewport" | "editing" | "general";

/** how a binding is matched, which is part of the entry's identity and not a
 * user setting.
 *
 * `key` is the character the layout prints, which is the hotkey string a
 * @tanstack/react-hotkeys registration takes verbatim -- dvorak and colemak
 * users press the key their keycap shows. the library trusts the layout for
 * letters, so a non-latin layout prints a non-latin letter (cyrillic KeyV
 * reports `м`) and the shipped default never fires there; rebinding is the fix
 * (docs/adr/0002-keybindings-store-key-and-code.md).
 *
 * `code` is the physical key under its modifiers, because the printed
 * character varies by layout -- a hotkey string carrying the character would
 * miss the press on half of them. the library cannot register on a code at
 * all, so matchesCodeKeybind is the matcher for these rows */
export type KeybindMatcher = "key" | "code";

/** the platform the canonical modifier token resolves against. taken as a
 * parameter everywhere it matters so the tests need no browser */
export type KeybindPlatform = "mac" | "windows" | "linux";

/** one place a keybind can sit. a row owns a primary slot and an optional
 * alternate; the whole array is what a slot index reads into */
export type BindingSlot = number;

/** the primary plus one alternate. more slots would be a list rather than a
 * pair, and nothing in the app wants a third key for one action */
export const MAX_BINDING_SLOTS = 2;

export interface KeybindEntry {
	action: KeybindAction;
	group: KeybindGroup;
	owner: KeybindOwner;
	by: KeybindMatcher;
	/** the binding in the voice a keybind list would print it in */
	label: string;
	/** the reason a row cannot be rebound, or null. only cancel is locked:
	 * Escape is claimed by four listeners, one of them the dialog primitive's
	 * own native handling that no override could ever reach */
	locked: string | null;
	/** primary first, alternate second */
	defaults: readonly KeybindBinding[];
}

/** a helper for the table below: one key on one physical code */
function one(hotkey: string, code: string): readonly KeybindBinding[] {
	return [{ hotkey, codes: [code] }];
}

/** the inventory, in the order every list renders it: the declaration order
 * reconciliation walks, grouped so the rows read as a structure */
export const KEYBINDS = {
	// one keybind, two registrations: the keydown arms the viewport pan and the
	// keyup decides tap-or-drag. the table describes what is bound, not how many
	// listeners implement it
	playPause: {
		action: "playPause",
		group: "playback",
		owner: "global",
		by: "key",
		label: "play / pause",
		locked: null,
		defaults: one("Space", "Space")
	},
	seekBack: {
		action: "seekBack",
		group: "playback",
		owner: "global",
		by: "key",
		label: "seek back one second",
		locked: null,
		defaults: one("ArrowLeft", "ArrowLeft")
	},
	seekForward: {
		action: "seekForward",
		group: "playback",
		owner: "global",
		by: "key",
		label: "seek forward one second",
		locked: null,
		defaults: one("ArrowRight", "ArrowRight")
	},
	frameStepBack: {
		action: "frameStepBack",
		group: "playback",
		owner: "global",
		by: "key",
		label: "step back one frame",
		locked: null,
		defaults: one(",", "Comma")
	},
	frameStepForward: {
		action: "frameStepForward",
		group: "playback",
		owner: "global",
		by: "key",
		label: "step forward one frame",
		locked: null,
		defaults: one(".", "Period")
	},
	restart: {
		action: "restart",
		group: "playback",
		owner: "global",
		by: "key",
		label: "jump to the start",
		locked: null,
		defaults: one("Home", "Home")
	},
	// the six severity jumps: forward on the plain digit, backward under ctrl.
	// they sit with the other seek actions because that is what they are --
	// navigation to the judgements the overview strip marks and could never be
	// aimed at (lib/judgement-nav.ts owns every decision behind them).
	//
	// `Shift+1` was never a candidate for the backward half: a shifted digit
	// prints a different character on every layout (`!` on us, `+` on german,
	// `&` on french), so a character-matched binding would answer to nothing.
	// ctrl leaves the printed character alone, which is what makes it the safe
	// modifier here. spelled `Control` rather than `Mod`, so it demands ctrlKey
	// on every platform, the same way viewportReset spells its chord -- known
	// cost, recorded in TODO.md: macOS binds Control+digit to Mission Control's
	// desktop switching once a second desktop exists, so the three backward
	// defaults never reach the webview there and rebinding is the fix.
	//
	// matched by printed character like every other digit and letter row, but
	// the digits are the one place that is not the whole story: the library's
	// matcher falls back to the event's `code` when the printed character is a
	// single NON-letter that did not match, and reads a `Digit<n>` as that digit
	// (matchesKeyboardEvent, @tanstack/hotkeys). NON-letter is the whole hinge:
	// the same arm is blocked for anything unicode calls a letter, which is why
	// the letter rows are unaffected by it (a cyrillic `в` on `KeyV` does not
	// answer to `V`).
	//
	// so azerty, whose unshifted digit row prints `&`/`é`/`"`, splits: `&` and
	// `"` are punctuation, so `1` and `3` fire through the fallback, and `é` is
	// a letter, so `2` does not. four of these six defaults work there and the
	// meh pair needs a rebind -- the ordinary docs/adr/0002 answer, reached for
	// one key rather than all of them.
	//
	// the cost of the fallback, recorded in TODO.md: the keys it rescues are
	// reachable from two hotkeys at once. a user on such a layout who rebinds
	// some other action onto that same physical key captures the character it
	// prints (`&`), which is a different identity from `1` -- so the fold and
	// its uniqueness test both see a clean table -- and the press then matches
	// both registrations, which the manager fires in turn. one key, two actions.
	// the shipped table cannot hit this on its own, since nothing else is bound
	// to those characters, and the blocked half cannot hit it at all: a rebind
	// onto `é` is the arm that never re-matches `2`.
	//
	// the code-matched viewportReset is the only other digit binding and lives in
	// a separate identity namespace, so nothing here can collide with it.
	//
	// `ok` and `meh` name the grades the labels call 100 and 50: the wire's
	// vocabulary in the action, the user's in the label (CONTEXT.md pins the pair)
	jumpNextOk: {
		action: "jumpNextOk",
		group: "playback",
		owner: "global",
		by: "key",
		label: "jump to the next 100",
		locked: null,
		defaults: one("1", "Digit1")
	},
	jumpPreviousOk: {
		action: "jumpPreviousOk",
		group: "playback",
		owner: "global",
		by: "key",
		label: "jump to the previous 100",
		locked: null,
		defaults: one("Control+1", "Digit1")
	},
	jumpNextMeh: {
		action: "jumpNextMeh",
		group: "playback",
		owner: "global",
		by: "key",
		label: "jump to the next 50",
		locked: null,
		defaults: one("2", "Digit2")
	},
	jumpPreviousMeh: {
		action: "jumpPreviousMeh",
		group: "playback",
		owner: "global",
		by: "key",
		label: "jump to the previous 50",
		locked: null,
		defaults: one("Control+2", "Digit2")
	},
	jumpNextMiss: {
		action: "jumpNextMiss",
		group: "playback",
		owner: "global",
		by: "key",
		label: "jump to the next miss",
		locked: null,
		defaults: one("3", "Digit3")
	},
	jumpPreviousMiss: {
		action: "jumpPreviousMiss",
		group: "playback",
		owner: "global",
		by: "key",
		label: "jump to the previous miss",
		locked: null,
		defaults: one("Control+3", "Digit3")
	},
	// alt+arrow, matching lazer's own IncreaseVolume/DecreaseVolume
	// (GlobalAction.cs). the master only: three more pairs for the channels
	// would be keys spent on a balance that is set once
	volumeUp: {
		action: "volumeUp",
		group: "playback",
		owner: "global",
		by: "key",
		label: "master volume up",
		locked: null,
		defaults: one("Alt+ArrowUp", "ArrowUp")
	},
	volumeDown: {
		action: "volumeDown",
		group: "playback",
		owner: "global",
		by: "key",
		label: "master volume down",
		locked: null,
		defaults: one("Alt+ArrowDown", "ArrowDown")
	},
	// written as Control rather than Mod: this chord has always demanded
	// e.ctrlKey on every platform, and the fold normalises it per platform
	viewportReset: {
		action: "viewportReset",
		group: "viewport",
		owner: "global",
		by: "code",
		label: "reset the viewport",
		locked: null,
		// one chord on two physical keys, which is why both codes ride on one
		// binding: a later ctrl+numpad-0 binding must collide with it rather
		// than quietly double-bind
		defaults: [{ hotkey: "Control+0", codes: ["Digit0", "Numpad0"] }]
	},
	selectTool: {
		action: "selectTool",
		group: "editing",
		owner: "global",
		by: "key",
		label: "select tool",
		locked: null,
		defaults: one("V", "KeyV")
	},
	lassoTool: {
		action: "lassoTool",
		group: "editing",
		owner: "global",
		by: "key",
		label: "lasso tool",
		locked: null,
		defaults: one("L", "KeyL")
	},
	moveTool: {
		action: "moveTool",
		group: "editing",
		owner: "global",
		by: "key",
		label: "move tool",
		locked: null,
		defaults: one("M", "KeyM")
	},
	smoothTool: {
		action: "smoothTool",
		group: "editing",
		owner: "global",
		by: "key",
		label: "smooth tool",
		locked: null,
		defaults: one("S", "KeyS")
	},
	eraseTool: {
		action: "eraseTool",
		group: "editing",
		owner: "global",
		by: "key",
		label: "erase tool",
		locked: null,
		defaults: one("E", "KeyE")
	},
	// X is arbitrary by choice: every mnemonic for snapping is a tool's key
	// already (magnet -> M, lattice -> L, snap -> S), G would teach the exact
	// word the glossary reserves for the playfield grid, and modifier-free
	// matters more than mnemonic for a preference flipped this often
	toggleSnap: {
		action: "toggleSnap",
		group: "editing",
		owner: "global",
		by: "key",
		label: "snap to lattice",
		locked: null,
		defaults: one("X", "KeyX")
	},
	// one keybind, four registrations: use-edit-tools kills a live cursor-path
	// gesture or clears the selections, DetailLanes attaches its own listener
	// for the duration of a press drag, and the dialog primitive closes on it
	// natively. only the first three could ever read an override, so a rebound
	// cancel would leave the app's meaning of "cancel" and the dialog's
	// permanently disagreeing -- the row is listed and locked
	cancel: {
		action: "cancel",
		group: "editing",
		owner: "gesture",
		by: "key",
		label: "cancel the live gesture or drag, or clear the selection",
		locked: "the dialogs close on Escape natively, which no rebinding can reach",
		defaults: one("Escape", "Escape")
	},
	eraseSelection: {
		action: "eraseSelection",
		group: "editing",
		owner: "gesture",
		by: "key",
		label: "erase the frame selection",
		locked: null,
		defaults: [
			{ hotkey: "Delete", codes: ["Delete"] },
			{ hotkey: "Backspace", codes: ["Backspace"] }
		]
	},
	// smooth selection is the frames panel's own smooth button from the
	// keyboard -- the selection, or the frame-cursor frame when nothing is
	// selected -- so its default keeps the tool's mnemonic one shift away
	// rather than spending a second letter on it
	smoothSelection: {
		action: "smoothSelection",
		group: "editing",
		owner: "gesture",
		by: "key",
		label: "smooth the frame selection, or the current frame",
		locked: null,
		defaults: one("Shift+S", "KeyS")
	},
	// `Mod` rather than `Control`, unlike viewportReset above: this is the open
	// accelerator every desktop app has, which means ctrl off the mac and cmd on
	// it, and `Mod` is the token that resolves per platform. matched on the
	// printed character like every other letter binding, so a rebind on a
	// non-latin layout is what fixes it there (docs/adr/0002)
	openMenu: {
		action: "openMenu",
		group: "general",
		owner: "global",
		by: "key",
		label: "open a replay",
		locked: null,
		defaults: one("Mod+O", "KeyO")
	},
	// matched on the key rather than the code: a function key reports the same
	// `key` on every layout, so the layout question the code-matched path
	// exists for never arises here
	showHelp: {
		action: "showHelp",
		group: "general",
		owner: "global",
		by: "key",
		label: "show the keybind list",
		locked: null,
		defaults: one("F1", "F1")
	}
} as const satisfies Record<KeybindAction, KeybindEntry>;

/** the inventory in declaration order -- the order reconciliation walks and
 * every list renders */
export const KEYBIND_ENTRIES: readonly KeybindEntry[] = Object.values(KEYBINDS);

/** the groups in the order they are listed, with the heading each carries */
export const KEYBIND_GROUPS: readonly { id: KeybindGroup; label: string }[] = [
	{ id: "playback", label: "playback" },
	{ id: "viewport", label: "viewport" },
	{ id: "editing", label: "editing" },
	{ id: "general", label: "general" }
];

/** the five tool actions by the tool they arm. exhaustive by type, so a sixth
 * tool cannot reach the palette without a key -- this stops compiling, and the
 * table's test says the same thing at runtime */
export const TOOL_KEYBINDS = {
	select: KEYBINDS.selectTool,
	lasso: KEYBINDS.lassoTool,
	move: KEYBINDS.moveTool,
	smooth: KEYBINDS.smoothTool,
	erase: KEYBINDS.eraseTool
} as const satisfies Record<ToolId, KeybindEntry>;

/** the tool an action arms, for the resolver's answer */
const TOOL_BY_ACTION = new Map<KeybindAction, ToolId>(
	(Object.entries(TOOL_KEYBINDS) as [ToolId, KeybindEntry][]).map(([tool, entry]) => [entry.action, tool])
);

/** the six severity-jump rows by the grade they navigate. exhaustive by type,
 * so a fourth navigable grade cannot reach the transport without a pair of
 * keys -- this stops compiling first */
export const SEVERITY_JUMP_KEYBINDS = {
	ok: { next: KEYBINDS.jumpNextOk, previous: KEYBINDS.jumpPreviousOk },
	meh: { next: KEYBINDS.jumpNextMeh, previous: KEYBINDS.jumpPreviousMeh },
	miss: { next: KEYBINDS.jumpNextMiss, previous: KEYBINDS.jumpPreviousMiss }
} as const satisfies Record<SeverityGrade, { next: KeybindEntry; previous: KeybindEntry }>;

/** what one severity-jump key asks for: which grade to walk, and which way */
export interface SeverityJumpBinding {
	grade: SeverityGrade;
	direction: 1 | -1;
}

const SEVERITY_JUMP_BY_ACTION = new Map<KeybindAction, SeverityJumpBinding>(
	Object.entries(SEVERITY_JUMP_KEYBINDS).flatMap(([key, pair]) => {
		const grade = key as SeverityGrade;
		return [
			[pair.next.action, { grade, direction: 1 }],
			[pair.previous.action, { grade, direction: -1 }]
		];
	})
);

/** the jump an action asks for, or null when the action is not one of the six.
 * the whole dispatch behind the number keys, so the registration point looks
 * up rather than spelling six near-identical callbacks */
export function severityJumpFor(action: KeybindAction): SeverityJumpBinding | null {
	return SEVERITY_JUMP_BY_ACTION.get(action) ?? null;
}

/** the actions use-playback-shortcuts applies through resolveEditKeybind:
 * the five tools and the snap toggle */
export const EDIT_ACTIONS: readonly KeybindAction[] = [
	...Object.values(TOOL_KEYBINDS).map((entry) => entry.action),
	KEYBINDS.toggleSnap.action
];

// ---------------------------------------------------------------------------
// overrides and the fold
// ---------------------------------------------------------------------------

/** no overrides: what a fresh install folds, and what restore-all writes */
export const NO_KEYBIND_OVERRIDES: KeybindOverrides = {};

/** one row of the effective table: the entry, whatever is actually bound to
 * it, and whether the user's own map is what put it there */
export interface EffectiveKeybind extends KeybindEntry {
	/** primary first; empty means the action is unbound */
	bindings: readonly KeybindBinding[];
	/** the override map carries an entry for this action */
	overridden: boolean;
}

/** the numpad codes whose printed character is what makes the press the
 * chord: with numlock off Numpad0 reports Insert, and ctrl+insert is copy */
const NUMPAD_NUMERIC = /^Numpad(\d|Decimal)$/;

function isBindingShape(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { hotkey?: unknown; codes?: unknown };
	if (typeof candidate.hotkey !== "string" || candidate.hotkey.length === 0) return false;
	// a hand-written entry may omit the codes entirely; a key-matched row does
	// not read them, and a code-matched one without them simply binds nothing
	return candidate.codes === undefined || Array.isArray(candidate.codes);
}

/** the stored form put into the canonical form everything else compares: the
 * hotkey through the library's own normaliser (so `ctrl+v` from a hand edit
 * and a captured `Mod+V` are one string), the codes filtered to strings */
function normalizeBindings(bindings: readonly unknown[], platform: KeybindPlatform): KeybindBinding[] {
	return (
		bindings
			.filter(isBindingShape)
			.map((raw) => {
				const { hotkey, codes } = raw as KeybindBinding;
				return {
					hotkey: normalizeHotkey(hotkey, platform),
					codes: (Array.isArray(codes) ? codes : []).filter(
						(code): code is string => typeof code === "string"
					)
				};
			})
			// a hand edit the grammar cannot spell (`+`, which is its own chord
			// separator) normalises to nothing; a binding on nothing would claim the
			// empty identity and collide with the next one
			.filter((binding) => binding.hotkey.length > 0)
	);
}

/** the modifier half of a hotkey string, in the library's canonical order */
function modifierPrefix(hotkey: string, platform: KeybindPlatform): string {
	const parsed = parseHotkey(hotkey, platform);
	return parsed.modifiers.join("+");
}

/** every distinct trigger a binding occupies. character-matched and
 * code-matched bindings live in separate namespaces because they are not
 * comparable without a layout map: `V` and `KeyV` are the same key on a us
 * layout and different keys on a dvorak or cyrillic one.
 *
 * so uniqueness holds *within* a matcher and cannot hold across the two. what
 * keeps that from mattering is bindingUnfitReason: the code-matched rows are
 * confined to chords, so no plain letter can be claimed twice. a user who
 * deliberately puts a key-matched action on the same chord a code-matched row
 * holds gets both -- and sees it, since the two rows then print the same chord.
 * claiming both halves of every binding instead was rejected: the character a
 * physical key prints is captured once and goes stale the moment the layout
 * changes, so it would false-steal on exactly the non-latin layouts this
 * feature exists for */
export function bindingIdentities(
	by: KeybindMatcher,
	binding: KeybindBinding,
	platform: KeybindPlatform = detectPlatform()
): string[] {
	if (by === "key") return [`key:${normalizeHotkey(binding.hotkey, platform)}`];
	const prefix = modifierPrefix(binding.hotkey, platform);
	return binding.codes.map((code) => `code:${prefix}:${code}`);
}

/** every trigger a whole row occupies */
export function keybindIdentities(row: EffectiveKeybind, platform: KeybindPlatform = detectPlatform()): string[] {
	return row.bindings.flatMap((binding) => bindingIdentities(row.by, binding, platform));
}

/** why a binding cannot sit on a row, or null when it can.
 *
 * a code-matched row needs at least one modifier. the two matchers live in
 * separate identity namespaces -- `V` and `KeyV` are the same key on a us
 * layout and different keys on a cyrillic one, so nothing can compare them --
 * which means a bare physical key on a code-matched row would collide
 * invisibly with a character binding on the same keycap, and the uniqueness
 * invariant would go on reporting a clean table. a modifier is what keeps the
 * one code-matched row out of the plain keys' way */
export function bindingUnfitReason(
	by: KeybindMatcher,
	binding: KeybindBinding,
	platform: KeybindPlatform = detectPlatform()
): string | null {
	// a bare modifier name parses as an ordinary key -- `Control` becomes the
	// key "Control" with no ctrl flag -- so a real Control press, which reports
	// ctrlKey, fails the matcher's modifier test and the row prints a binding
	// nothing can trigger. readCapture already refuses a modifiers-only press;
	// a hand-edited file has to be refused on the same rule or it keeps a key
	// the user cannot reach
	if (by === "key") {
		if (hasNonModifierKey(binding.hotkey, platform)) return null;
		return "that one is only a modifier, so nothing can press it on its own";
	}
	// a code-matched row matches on the code and nothing else, so one without
	// a code would print its hotkey in the list and answer to no press at all
	if (binding.codes.length === 0) return "this one is matched by physical key, and that key was not reported";
	const parsed = parseHotkey(binding.hotkey, platform);
	// matchesCodeKeybind asks a numpad digit for its printed character too,
	// because with numlock off that code reports Insert and ctrl+insert is
	// copy. a binding whose every code is a numpad digit captured with numlock
	// off therefore answers to nothing -- the shipped ctrl+0 survives this
	// because it also carries Digit0, which the character rule never gates
	if (!binding.codes.some((code) => !NUMPAD_NUMERIC.test(code) || parsed.key.length === 1)) {
		return "the numpad only reports that key with numlock on";
	}
	if (parsed.ctrl || parsed.alt || parsed.shift || parsed.meta) return null;
	return "this one is matched by physical key, so it needs a modifier";
}

/** the override the map holds for an entry, or null when it holds none --
 * which is also the answer for a locked row and for a hand-edited value of
 * the wrong shape, both of which follow the default */
function readOverride(
	overrides: KeybindOverrides,
	entry: KeybindEntry,
	platform: KeybindPlatform
): KeybindBinding[] | null {
	if (entry.locked !== null) return null;
	const raw: unknown = overrides[entry.action];
	if (!Array.isArray(raw)) return null;
	const bindings = normalizeBindings(raw, platform).filter(
		(binding) => bindingUnfitReason(entry.by, binding, platform) === null
	);
	// an entry that had bindings and kept none of them is a typo rather than a
	// deliberate unbind: the empty list is what says "unbound", and a hand edit
	// that got the shape wrong must not cost the user a key
	if (raw.length > 0 && bindings.length === 0) return null;
	return bindings.slice(0, MAX_BINDING_SLOTS);
}

/**
 * defaults plus a sparse override map, folded into the table every consumer
 * reads. deterministic and silent: the inventory is walked in declaration
 * order, the first claim on a key identity wins, a colliding override falls
 * back to its own default, and if that also collides the action comes out
 * unbound. no toast -- the settings rows show the effective binding, which is
 * the truth, so the same file always produces the same table.
 */
export function foldKeybinds(
	overrides: KeybindOverrides = NO_KEYBIND_OVERRIDES,
	platform: KeybindPlatform = detectPlatform()
): EffectiveKeybind[] {
	const claimed = new Set<string>();
	// the locked rows claim ahead of declaration order. a locked row's key is
	// held by listeners no override can reach -- Escape closes a dialog
	// natively -- so an earlier row's override taking it would leave the table
	// calling cancel unbound while the key still cancels. that is two meanings
	// of one press, which is the exact thing locking the row prevents, and a
	// hand-edited or newer-build file is the only way to ask for it
	for (const entry of KEYBIND_ENTRIES) {
		if (entry.locked === null) continue;
		for (const binding of normalizeBindings(entry.defaults, platform)) {
			for (const id of bindingIdentities(entry.by, binding, platform)) claimed.add(id);
		}
	}
	return KEYBIND_ENTRIES.map((entry) => {
		const defaults = normalizeBindings(entry.defaults, platform);
		// a locked row is on its default by definition, and the pass above
		// already holds its keys for it
		if (entry.locked !== null) return { ...entry, bindings: defaults, overridden: false };
		const override = readOverride(overrides, entry, platform);
		const claim = (bindings: readonly KeybindBinding[]): KeybindBinding[] | null => {
			const identities = bindings.flatMap((binding) => bindingIdentities(entry.by, binding, platform));
			// a candidate whose keys are not all free is refused whole: a row is
			// one user-visible thing, and half-applying it would leave a
			// configuration nobody asked for
			if (identities.some((id, index) => claimed.has(id) || identities.indexOf(id) !== index)) return null;
			for (const id of identities) claimed.add(id);
			return bindings.slice();
		};
		const bindings = (override !== null ? claim(override) : null) ?? claim(defaults) ?? [];
		return { ...entry, bindings, overridden: override !== null };
	});
}

/** the shipped table, with nothing overridden. the module keeps exporting the
 * pure defaults: the store owns the effective table, this is what a consumer
 * with no store (a test, a default store value) folds */
export function defaultKeybinds(platform?: KeybindPlatform): EffectiveKeybind[] {
	return foldKeybinds(NO_KEYBIND_OVERRIDES, platform);
}

/** what one binding is called on screen. the library's own display formatter,
 * asked for labels rather than symbols: `⌫` and `␣` are cryptic in a list
 * whose whole job is teaching keys */
export function formatBinding(binding: KeybindBinding, platform: KeybindPlatform = detectPlatform()): string {
	return formatForDisplay(binding.hotkey, { platform, useSymbols: false });
}

/** what a row's keys are called on screen, or null when it is unbound -- which
 * is what lets a tooltip say nothing about a key rather than showing an empty
 * pair of brackets */
export function formatBindings(
	bindings: readonly KeybindBinding[],
	platform: KeybindPlatform = detectPlatform()
): string | null {
	if (bindings.length === 0) return null;
	return bindings.map((binding) => formatBinding(binding, platform)).join(" / ");
}

/** an action's keys in the shape a tooltip appends -- ` (Home)` -- or the empty
 * string when the action is unbound, so a surface that names its key stops
 * naming one the moment the user takes it away rather than printing an empty
 * pair of brackets. every control that advertises a key reads this: a hint
 * left as a literal goes on teaching a key that no longer does anything, which
 * is the lie this whole feature exists to fix */
export function keybindSuffix(
	table: readonly EffectiveKeybind[],
	action: KeybindAction,
	platform: KeybindPlatform = detectPlatform()
): string {
	const keys = formatBindings(keybindRow(table, action).bindings, platform);
	return keys === null ? "" : ` (${keys})`;
}

/** the row for an action, which the fold guarantees exists */
export function keybindRow(table: readonly EffectiveKeybind[], action: KeybindAction): EffectiveKeybind {
	const row = table.find((candidate) => candidate.action === action);
	// the fold emits one row per inventory entry, so this is unreachable; the
	// throw is what keeps the return type honest for every caller
	if (row === undefined) throw new Error(`no keybind row for ${action}`);
	return row;
}

// ---------------------------------------------------------------------------
// capture
// ---------------------------------------------------------------------------

/** the structural subset of a keydown a capture reads. a plain object rather
 * than a KeyboardEvent, the way shortcut-guards' predicates take a structural
 * element shape, so the test builds presses as literals */
export interface CaptureKeyEvent {
	key: string;
	code: string;
	ctrlKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
	metaKey: boolean;
}

/** what one armed keypress means: the binding it asks for, a cancellation, a
 * press that must keep doing its own job instead, a press that is only
 * modifiers and asks for nothing yet, or a key the hotkey grammar cannot spell */
export type CaptureRead =
	| { kind: "cancelled" }
	| { kind: "passthrough" }
	| { kind: "incomplete" }
	| { kind: "unsupported" }
	| { kind: "captured"; binding: KeybindBinding };

/**
 * one armed keypress read into a candidate binding. handrolled rather than
 * taken from the library's recorder, which hardcodes unmodified Backspace and
 * Delete as *clear* -- the two keys erase selection is bound to by default,
 * which would make them permanently uncapturable -- and emits a hotkey string
 * with no physical code.
 *
 * Escape always cancels and can never itself be captured, so arming a slot is
 * never a trap. a press that is only modifiers is incomplete: resting on ctrl
 * while thinking must not bind something absurd.
 *
 * Tab passes through instead: it is the only way a keyboard user moves off the
 * control, so capturing it would both take the key the app navigates by and
 * leave the slot's own blur-disarm unreachable -- the user would be bound to
 * Tab with no second chance. the caller must let it keep its default, which is
 * why this is a separate answer from a cancellation.
 */
export function readCapture(e: CaptureKeyEvent, platform: KeybindPlatform = detectPlatform()): CaptureRead {
	const key = normalizeKeyName(e.key);
	if (key === "Escape") return { kind: "cancelled" };
	if (key === "Tab") return { kind: "passthrough" };
	// a dead key -- macOS Option+E, the accent keys on the european layouts --
	// reports the literal key "Dead", and the library's matcher answers a Dead
	// press from the *physical code* rather than that string. so a stored
	// `Alt+Dead` is compared against "KeyE" and never matches its own press:
	// the row would print a binding that answers to nothing. refused rather
	// than stored, the same answer the `+` key gets
	if (key === "Dead") return { kind: "unsupported" };
	// the library's own event parser: it reads exactly the six fields above,
	// so the structural shape satisfies it at runtime
	const parsed = parseKeyboardEvent(e as KeyboardEvent);
	if (!hasNonModifierKey(parsed, platform)) return { kind: "incomplete" };
	const hotkey = normalizeHotkeyFromParsed(parsed, platform);
	// the library joins a chord with `+`, so the `+` key cannot be spelled in
	// its own grammar: parsing the string back yields an empty key, and the
	// binding would look bound in the row and be dead after a reload. refused
	// rather than stored, which is the truthful answer for a key this app
	// cannot register
	if (normalizeHotkey(hotkey, platform) !== hotkey) return { kind: "unsupported" };
	return {
		kind: "captured",
		binding: {
			hotkey,
			// the physical key rides alongside the character; both are recorded
			// and the entry's matcher decides which one is matched against
			codes: e.code === "" ? [] : [e.code]
		}
	};
}

/** true when a keydown is one of a row's bindings. character-matched rows go
 * through the library's own matcher -- the same comparison its registrations
 * make, so a gesture-owned key and a globally registered one answer to the
 * same press -- and code-matched rows through matchesCodeKeybind.
 *
 * this is what the `gesture` owner reads instead of comparing key literals:
 * those keys are listed in the table, and until they resolved against it they
 * were not driven by it */
export function matchesKeybind(
	e: CaptureKeyEvent,
	row: EffectiveKeybind,
	platform: KeybindPlatform = detectPlatform()
): boolean {
	return row.bindings.some((binding) =>
		row.by === "key"
			? // the library reads exactly the fields CaptureKeyEvent names
				matchesKeyboardEvent(e as KeyboardEvent, parseHotkey(binding.hotkey, platform), platform)
			: matchesCodeKeybind(e, binding, platform)
	);
}

/** the key a binding's keyup has to deliver for that press to be over: the
 * chord's main key, with the modifiers dropped.
 *
 * a binding that latches something on the way down cannot ask the library to
 * tell it when the press ends, because its matcher demands the exact chord on
 * the keyup too -- `Control+K` let go of ctrl-first delivers the K keyup with
 * ctrlKey already false, so the chord never matches and whatever the keydown
 * armed stays armed. the same trap catches the shipped `Space` when a modifier
 * is touched mid-hold. asking only for the main key is what closes it, and
 * pairing that with the key which actually armed the hold (spacePan) is what
 * keeps a second binding on the same action from ending a hold it never began */
export function keybindMainKey(hotkey: string, platform: KeybindPlatform = detectPlatform()): string {
	return parseHotkey(hotkey, platform).key;
}

/** the main key a keyup is letting go of, spelled the way keybindMainKey
 * spells it so the two can be compared */
export function releasedMainKey(e: { key: string }): string {
	return normalizeKeyName(e.key);
}

/** true when a keydown is a code-matched binding: the physical key under
 * exactly its modifiers. the library cannot register on a code at all -- its
 * registerable hotkey carries a key and modifier flags and no code -- so this
 * is ours to match rather than something we can hand to it */
export function matchesCodeKeybind(
	e: { ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; code: string; key: string },
	binding: KeybindBinding,
	platform: KeybindPlatform = detectPlatform()
): boolean {
	const parsed = parseHotkey(binding.hotkey, platform);
	// exactly the modifiers the chord names. alt matching false is what keeps
	// altgr out: chromium reports altgr as ctrl+alt, and altgr+0 is `}` on the
	// german-family layouts, which a looser test would stop those users typing
	if (e.ctrlKey !== parsed.ctrl || e.altKey !== parsed.alt) return false;
	if (e.shiftKey !== parsed.shift || e.metaKey !== parsed.meta) return false;
	if (!binding.codes.includes(e.code)) return false;
	// the numpad arm asks for the printed character too: with numlock off that
	// same code is Insert, ctrl+insert is copy, and the webview never zoomed on it
	return !NUMPAD_NUMERIC.test(e.code) || e.key.length === 1;
}

// ---------------------------------------------------------------------------
// editing the override map
// ---------------------------------------------------------------------------

/** the row a capture displaced and the binding it lost, so the settings row
 * can say inline what happened rather than raising a toast somewhere else */
export interface DisplacedKeybind {
	action: KeybindAction;
	binding: KeybindBinding;
}

export interface CaptureOutcome {
	overrides: KeybindOverrides;
	displaced: DisplacedKeybind[];
	/** why nothing was applied, said in the voice the row will print, or null
	 * when the capture landed */
	refused: string | null;
}

function sameBinding(a: KeybindBinding, b: KeybindBinding): boolean {
	return a.hotkey === b.hotkey && a.codes.length === b.codes.length && a.codes.every((c, i) => c === b.codes[i]);
}

function sameBindings(a: readonly KeybindBinding[], b: readonly KeybindBinding[]): boolean {
	return a.length === b.length && a.every((binding, index) => sameBinding(binding, b[index]!));
}

/** writes one action's bindings into the map, or drops the entry when they
 * are exactly the defaults again -- sparse is the load-bearing half: an
 * action left alone must keep inheriting a later change to its default */
function withAction(
	overrides: KeybindOverrides,
	entry: KeybindEntry,
	bindings: readonly KeybindBinding[],
	platform: KeybindPlatform
): KeybindOverrides {
	const next = { ...overrides };
	if (sameBindings(bindings, normalizeBindings(entry.defaults, platform))) delete next[entry.action];
	else next[entry.action] = bindings;
	return next;
}

/**
 * arms a captured binding into a slot, stealing the key from whoever holds
 * it. the new row takes it and the displaced row is unbound, because refusing
 * the capture instead would make resolving a conflict a three-step errand:
 * go clear the other row, come back, press the key again.
 */
export function applyCapture(
	overrides: KeybindOverrides,
	table: readonly EffectiveKeybind[],
	action: KeybindAction,
	slot: BindingSlot,
	captured: KeybindBinding,
	platform: KeybindPlatform = detectPlatform()
): CaptureOutcome {
	const target = keybindRow(table, action);
	if (target.locked !== null) return { overrides, displaced: [], refused: target.locked };
	const unfit = bindingUnfitReason(target.by, captured, platform);
	if (unfit !== null) return { overrides, displaced: [], refused: unfit };
	const claimed = new Set(bindingIdentities(target.by, captured, platform));
	const collides = (row: EffectiveKeybind, binding: KeybindBinding) =>
		bindingIdentities(row.by, binding, platform).some((id) => claimed.has(id));

	let next = overrides;
	const displaced: DisplacedKeybind[] = [];
	// what the table shows a row holding is what that row can be told it lost,
	// so this pass -- and only this one -- produces the notices
	for (const row of table) {
		if (row.action === action || row.locked !== null) continue;
		const survivors = row.bindings.filter((binding) => !collides(row, binding));
		if (survivors.length === row.bindings.length) continue;
		for (const binding of row.bindings) {
			if (collides(row, binding)) displaced.push({ action: row.action, binding });
		}
		next = withAction(next, row, survivors, platform);
	}

	// the target's own other slot may hold the same key: keep the capture and
	// drop the duplicate rather than leaving the row bound to one key twice.
	// an empty primary with an alternate captured collapses to one slot, which
	// is what keeps "primary then optional alternate" true of every row
	const slots: (KeybindBinding | undefined)[] = [...target.bindings];
	slots[slot] = captured;
	const merged = slots
		.filter(
			(binding, index): binding is KeybindBinding =>
				binding !== undefined && (index === slot || !collides(target, binding))
		)
		.slice(0, MAX_BINDING_SLOTS);
	next = withAction(next, target, merged, platform);

	// clearing what the table *shows* is not enough on its own. a row can be
	// unbound right now only because something else holds its default, or be
	// riding its default because its own override lost -- and either will claim
	// the key back the moment the visible holder lets go, ahead of the target if
	// it is declared earlier. the capture would then silently fail to land: the
	// row the user configured keeps its old key and some other row quietly takes
	// the new one. so the result is folded and anything still answering to the
	// key is written out of the way, until the capture is what holds it
	const settled = new Set<KeybindAction>();
	for (;;) {
		const folded = foldKeybinds(next, platform);
		const thief = folded.find(
			(row) => row.action !== action && row.locked === null && row.bindings.some((b) => collides(row, b))
		);
		if (thief === undefined) break;
		// a row that comes back a second time is riding a default its own
		// override keeps losing to, so trimming its claim would only see it made
		// again; unbind it outright. this is also what bounds the loop -- an
		// action can be the thief at most twice, and an empty override claims
		// nothing
		const survivors = settled.has(thief.action) ? [] : thief.bindings.filter((b) => !collides(thief, b));
		settled.add(thief.action);
		next = withAction(next, thief, survivors, platform);
	}
	return { overrides: next, displaced, refused: null };
}

/** clears a slot. a distinct control rather than a magic key, so clearing and
 * capturing cannot be confused with each other; clearing the primary leaves
 * the action deliberately unbound, and that survives a restart as an unbind */
export function clearBinding(
	overrides: KeybindOverrides,
	table: readonly EffectiveKeybind[],
	action: KeybindAction,
	slot: BindingSlot,
	platform: KeybindPlatform = detectPlatform()
): KeybindOverrides {
	const row = keybindRow(table, action);
	if (row.locked !== null) return overrides;
	// withAction writes the empty list explicitly rather than dropping the
	// entry: an absent action means "follow the default", which would make
	// unbinding a lie that expires at the next launch
	return withAction(
		overrides,
		row,
		row.bindings.filter((_, index) => index !== slot),
		platform
	);
}

/** puts one row back on its default, costing the user none of their others */
export function revertKeybind(overrides: KeybindOverrides, action: KeybindAction): KeybindOverrides {
	if (!(action in overrides)) return overrides;
	const next = { ...overrides };
	delete next[action];
	return next;
}

// ---------------------------------------------------------------------------
// the edit-mode resolver
// ---------------------------------------------------------------------------

/** the plain facts the edit-mode keys are gated on. focus modality, dialogs
 * and whether a scene is loaded are deliberately absent: those belong to
 * guarded() in use-playback-shortcuts, which every one of these keys registers
 * through, and that rule exists in exactly one copy */
export interface KeybindContext {
	mode: ViewerMode;
	/** frameEditGate's answer for the loaded scene */
	editable: boolean;
	/** a cursor-path gesture is under way (editor/gesture-live.ts) */
	gestureLive: boolean;
}

/** what an edit-mode key asks for. snap stays distinguishable from the tools
 * at the seam because it is a live preference, not a sixth tool */
export type EditKeybindResolution = { kind: "tool"; tool: ToolId } | { kind: "snap" };

/** the whole decision behind the tool keys and the snap toggle, as a pure
 * function of plain data. the table is the *effective* one, so a rebound tool
 * key resolves to its tool and the default it replaced resolves to nothing */
export function resolveEditKeybind(
	hotkey: string,
	context: KeybindContext,
	table: readonly EffectiveKeybind[],
	platform: KeybindPlatform = detectPlatform()
): EditKeybindResolution | null {
	// gesture liveness first: a key pressed mid-drag is ignored outright, so the
	// drag finishes as the tool it started as and the palette cannot lie about
	// what is happening
	if (context.gestureLive) return null;
	if (context.mode !== "edit") return null;
	// quietly -- the disabled palette is already showing the reason, and a toast
	// per keystroke would say it again
	if (!context.editable) return null;
	const pressed = normalizeHotkey(hotkey, platform);
	for (const row of table) {
		if (row.by !== "key" || !row.bindings.some((binding) => binding.hotkey === pressed)) continue;
		const tool = TOOL_BY_ACTION.get(row.action);
		if (tool !== undefined) return { kind: "tool", tool };
		if (row.action === "toggleSnap") return { kind: "snap" };
	}
	return null;
}
