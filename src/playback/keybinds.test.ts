import { describe, expect, test } from "bun:test";
import { TOOL_IDS, type ToolId } from "../state/store";
import {
	EDIT_KEYBINDS,
	KEYBINDS,
	keybindIdentities,
	resolveEditKeybind,
	TOOL_KEYBINDS,
	type Keybind,
	type KeybindContext,
	type KeyKeybind
} from "./keybinds";

/** the situation the edit keys are meant to work in; each test names the one
 * fact it changes */
function editing(overrides: Partial<KeybindContext> = {}): KeybindContext {
	return { mode: "edit", editable: true, gestureLive: false, ...overrides };
}

const TABLE: Keybind[] = Object.values(KEYBINDS);

/** every key the table binds by character -- what a user can actually press */
const BOUND_KEYS = TABLE.filter((bind): bind is KeyKeybind => bind.by === "key").map((bind) => bind.key);

function toolsArmedBy(key: string): ToolId[] {
	const resolution = resolveEditKeybind(key, editing());
	return resolution !== null && resolution.kind === "tool" ? [resolution.tool] : [];
}

describe("the keybind table", () => {
	test("binds no key twice", () => {
		// the whole point of one table: a second binding on a taken key is a
		// failure here, when it is written, rather than a live conflict
		const identities = TABLE.flatMap(keybindIdentities);
		const collisions = identities.filter((identity, index) => identities.indexOf(identity) !== index);
		expect(collisions).toEqual([]);
	});

	test("counts the code-matched reset among the keys it occupies", () => {
		// ctrl+0 is matched by physical key, so it holds two identities -- a
		// later numpad binding must collide with it rather than double-bind
		expect(keybindIdentities(KEYBINDS.viewportReset)).toEqual(["ctrl+code:Digit0", "ctrl+code:Numpad0"]);
	});

	test("gives every tool exactly one key", () => {
		// a palette tile shipping unreachable from the keyboard fails here
		for (const tool of TOOL_IDS) {
			expect(BOUND_KEYS.filter((key) => toolsArmedBy(key).includes(tool))).toHaveLength(1);
		}
	});

	test("registers the tool keys and the snap toggle globally", () => {
		// the keys use-playback-shortcuts registers are the keys the resolver
		// answers for: neither list can grow without the other
		expect(EDIT_KEYBINDS.every((bind) => resolveEditKeybind(bind.key, editing()) !== null)).toBe(true);
		expect(EDIT_KEYBINDS).toHaveLength(TOOL_IDS.length + 1);
	});
});

describe("resolveEditKeybind", () => {
	test("arms each tool from its own key", () => {
		for (const tool of TOOL_IDS) {
			expect(resolveEditKeybind(TOOL_KEYBINDS[tool].key, editing())).toEqual({ kind: "tool", tool });
		}
	});

	test("reads a tool key whatever case the press arrives in", () => {
		// the hotkey library matches letters case-insensitively, so an
		// unshifted press arrives as "v" against a table that prints "V"
		expect(resolveEditKeybind("v", editing())).toEqual({ kind: "tool", tool: "select" });
	});

	test("toggles snap rather than arming a sixth tool", () => {
		expect(resolveEditKeybind(KEYBINDS.toggleSnap.key, editing())).toEqual({ kind: "snap" });
	});

	test("does nothing in watch mode", () => {
		const watching = editing({ mode: "watch" });
		for (const bind of EDIT_KEYBINDS) expect(resolveEditKeybind(bind.key, watching)).toBeNull();
	});

	test("does nothing on a non-editable replay", () => {
		// quietly: the disabled palette is already showing the reason
		const blocked = editing({ editable: false });
		for (const bind of EDIT_KEYBINDS) expect(resolveEditKeybind(bind.key, blocked)).toBeNull();
	});

	test("does nothing while a gesture is live", () => {
		// the drag finishes as the tool it started as
		const dragging = editing({ gestureLive: true });
		for (const bind of EDIT_KEYBINDS) expect(resolveEditKeybind(bind.key, dragging)).toBeNull();
	});

	test("leaves the playback keys to the playback handlers", () => {
		for (const key of ["Space", "ArrowLeft", "ArrowRight", ",", ".", "Home"]) {
			expect(resolveEditKeybind(key, editing())).toBeNull();
		}
	});

	test("leaves the gesture-owned keys to their own handlers", () => {
		// listed in the table, registered in use-edit-tools: cancel and erase
		// need gesture-local state this resolver cannot see
		for (const key of ["Escape", "Delete", "Backspace"]) {
			expect(resolveEditKeybind(key, editing())).toBeNull();
		}
	});

	test("ignores a key the table does not bind", () => {
		expect(resolveEditKeybind("Q", editing())).toBeNull();
	});
});
