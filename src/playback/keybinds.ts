// the keybind table -- every key the app binds, declared once as data --
// and the resolver for the edit-mode keys. pure: the two store imports are
// types, erased at build, so nothing here reaches the store, the renderer or
// tauri and its test runs headlessly the way shortcut-guards' does.
//
// the table is the complete inventory, playback and editing alike. a partial
// one could not answer "is this key free?", which is the question this module
// exists to answer, and it would make the uniqueness invariant meaningless.
// `owner` records where a keybind is *registered*, never where it is listed:
// everything is listed here, and one entry can have several registrations
// (play/pause splits over keydown and keyup, Escape over three listeners)

import type { ToolId, ViewerMode } from "../state/store";

/** what a keybind does. entries are unique by key, actions are not -- erase
 * selection answers to two keys */
export type KeybindAction =
	| "playPause"
	| "seekBack"
	| "seekForward"
	| "frameStepBack"
	| "frameStepForward"
	| "restart"
	| "viewportReset"
	| "selectTool"
	| "lassoTool"
	| "moveTool"
	| "smoothTool"
	| "eraseTool"
	| "toggleSnap"
	| "cancel"
	| "eraseSelection";

/** where a keybind is registered: `global` is use-playback-shortcuts, through
 * the one guard every binding passes; `gesture` is use-edit-tools, which needs
 * gesture-local state a generic registration point cannot see */
export type KeybindOwner = "global" | "gesture";

interface KeybindBase {
	action: KeybindAction;
	owner: KeybindOwner;
	/** the binding in the voice a keybind list would print it in */
	label: string;
}

/** matched on the character the layout prints, which is the hotkey string a
 * @tanstack/react-hotkeys registration takes verbatim.
 *
 * layout caveat, deliberate: the library trusts the layout for letters, so
 * dvorak and colemak users press the key their keycap shows -- but a
 * non-latin layout prints a non-latin letter (cyrillic KeyV reports `м`) and
 * `matchesKeyboardEvent` returns before its event.code fallback for it, so
 * the letter bindings do not fire there at all. going by code instead would
 * fix those layouts by breaking the remapped-latin ones, which is the worse
 * trade for this app's users; see TODO.md */
export interface KeyKeybind extends KeybindBase {
	by: "key";
	key: string;
}

/** matched on the physical key under its modifier, because the printed
 * character varies by layout -- a hotkey string carrying the character would
 * miss the press on half of them. asksViewportReset (shortcut-guards.ts) stays
 * the matcher; the entry exists so the key is listed rather than invisible */
export interface CodeKeybind extends KeybindBase {
	by: "code";
	ctrl: true;
	/** any of these physical keys is the binding */
	codes: readonly string[];
	/** what the chord is called on screen */
	chord: string;
}

export type Keybind = KeyKeybind | CodeKeybind;

export const KEYBINDS = {
	// one keybind, two registrations: the keydown arms the viewport pan and the
	// keyup decides tap-or-drag. the table describes what is bound, not how many
	// listeners implement it
	playPause: { by: "key", key: "Space", action: "playPause", owner: "global", label: "play / pause" },
	seekBack: { by: "key", key: "ArrowLeft", action: "seekBack", owner: "global", label: "seek back one second" },
	seekForward: {
		by: "key",
		key: "ArrowRight",
		action: "seekForward",
		owner: "global",
		label: "seek forward one second"
	},
	frameStepBack: { by: "key", key: ",", action: "frameStepBack", owner: "global", label: "step back one frame" },
	frameStepForward: {
		by: "key",
		key: ".",
		action: "frameStepForward",
		owner: "global",
		label: "step forward one frame"
	},
	restart: { by: "key", key: "Home", action: "restart", owner: "global", label: "jump to the start" },
	viewportReset: {
		by: "code",
		ctrl: true,
		codes: ["Digit0", "Numpad0"],
		chord: "ctrl+0",
		action: "viewportReset",
		owner: "global",
		label: "reset the viewport"
	},
	selectTool: { by: "key", key: "V", action: "selectTool", owner: "global", label: "select tool" },
	lassoTool: { by: "key", key: "L", action: "lassoTool", owner: "global", label: "lasso tool" },
	moveTool: { by: "key", key: "M", action: "moveTool", owner: "global", label: "move tool" },
	smoothTool: { by: "key", key: "S", action: "smoothTool", owner: "global", label: "smooth tool" },
	eraseTool: { by: "key", key: "E", action: "eraseTool", owner: "global", label: "erase tool" },
	// X is arbitrary by choice: every mnemonic for snapping is a tool's key
	// already (magnet -> M, lattice -> L, snap -> S), G would teach the exact
	// word the glossary reserves for the playfield grid, and modifier-free
	// matters more than mnemonic for a preference flipped this often
	toggleSnap: { by: "key", key: "X", action: "toggleSnap", owner: "global", label: "snap to lattice" },
	// one keybind, three registrations, same as play/pause: use-edit-tools kills
	// a live cursor-path gesture or clears the selections, and DetailLanes
	// attaches its own listener for the duration of a press drag. which one acts
	// is decided between them by pressDrag.live, not by this table
	cancel: {
		by: "key",
		key: "Escape",
		action: "cancel",
		owner: "gesture",
		label: "cancel the live gesture or drag, or clear the selection"
	},
	eraseSelection: {
		by: "key",
		key: "Delete",
		action: "eraseSelection",
		owner: "gesture",
		label: "erase the frame selection"
	},
	eraseSelectionBackspace: {
		by: "key",
		key: "Backspace",
		action: "eraseSelection",
		owner: "gesture",
		label: "erase the frame selection"
	}
} as const satisfies Record<string, Keybind>;

/** the five tool entries by the tool they arm. exhaustive by type, so a sixth
 * tool cannot reach the palette without a key -- this stops compiling, and the
 * table's test says the same thing at runtime */
export const TOOL_KEYBINDS = {
	select: KEYBINDS.selectTool,
	lasso: KEYBINDS.lassoTool,
	move: KEYBINDS.moveTool,
	smooth: KEYBINDS.smoothTool,
	erase: KEYBINDS.eraseTool
} as const satisfies Record<ToolId, KeyKeybind>;

/** the keys use-playback-shortcuts registers for the edit-mode actions, every
 * one of them applied through resolveEditKeybind */
export const EDIT_KEYBINDS = [...Object.values(TOOL_KEYBINDS), KEYBINDS.toggleSnap];

/** the tool rows as pairs, so a key match can answer with the tool it armed */
const TOOL_ROWS = Object.entries(TOOL_KEYBINDS) as [ToolId, KeyKeybind][];

/** the hotkey library matches single characters case-insensitively (letters by
 * layout, with an event.code fallback), so an unshifted `v` and the table's
 * printed `V` are one identity; named keys are already canonical */
function normalizeKey(key: string): string {
	return key.length === 1 ? key.toUpperCase() : key;
}

/** every distinct trigger an entry occupies. one for a key binding; one per
 * physical key for the code-matched reset, so a later ctrl+numpad-0 binding
 * collides with it instead of quietly double-binding */
export function keybindIdentities(bind: Keybind): string[] {
	if (bind.by === "key") return [`key:${normalizeKey(bind.key)}`];
	return bind.codes.map((code) => `ctrl+code:${code}`);
}

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
 * function of plain data */
export function resolveEditKeybind(key: string, context: KeybindContext): EditKeybindResolution | null {
	// gesture liveness first: a key pressed mid-drag is ignored outright, so the
	// drag finishes as the tool it started as and the palette cannot lie about
	// what is happening
	if (context.gestureLive) return null;
	if (context.mode !== "edit") return null;
	// quietly -- the disabled palette is already showing the reason, and a toast
	// per keystroke would say it again
	if (!context.editable) return null;
	const pressed = normalizeKey(key);
	for (const [tool, bind] of TOOL_ROWS) {
		if (normalizeKey(bind.key) === pressed) return { kind: "tool", tool };
	}
	if (pressed === normalizeKey(KEYBINDS.toggleSnap.key)) return { kind: "snap" };
	return null;
}
