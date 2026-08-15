import { describe, expect, test } from "bun:test";
import { TOOL_IDS, type ToolId } from "../state/store";
import {
	applyCapture,
	bindingIdentities,
	clearBinding,
	defaultKeybinds,
	EDIT_ACTIONS,
	foldKeybinds,
	KEYBIND_ENTRIES,
	KEYBINDS,
	keybindIdentities,
	keybindRow,
	matchesKeybind,
	keybindMainKey,
	readCapture,
	releasedMainKey,
	resolveEditKeybind,
	revertKeybind,
	TOOL_KEYBINDS,
	type CaptureKeyEvent,
	type EffectiveKeybind,
	type KeybindAction,
	type KeybindContext,
	type KeybindOverrides
} from "./keybinds";

// every fold in this file names its platform: the canonical modifier token is
// platform-adaptive (`Mod` on windows/linux, `Control` on mac), and a test
// that let it float would assert whatever machine ran it
const PLATFORM = "windows";

const table = (overrides: KeybindOverrides = {}) => foldKeybinds(overrides, PLATFORM);
const bindingsFor = (overrides: KeybindOverrides, action: KeybindAction) =>
	keybindRow(table(overrides), action).bindings.map((binding) => binding.hotkey);

/** the situation the edit keys are meant to work in; each test names the one
 * fact it changes */
function editing(overrides: Partial<KeybindContext> = {}): KeybindContext {
	return { mode: "edit", editable: true, gestureLive: false, ...overrides };
}

/** a press as plain data, the way shortcut-guards' tests build their targets */
function press(over: Partial<CaptureKeyEvent> = {}): CaptureKeyEvent {
	return { key: "K", code: "KeyK", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...over };
}

/** the binding a capture of `over` produces, for the tests that only care
 * about what it ends up bound to */
function captured(over: Partial<CaptureKeyEvent>) {
	const read = readCapture(press(over), PLATFORM);
	if (read.kind !== "captured") throw new Error(`expected a capture, got ${read.kind}`);
	return read.binding;
}

function toolsArmedBy(key: string, rows: EffectiveKeybind[] = table()): ToolId[] {
	const resolution = resolveEditKeybind(key, editing(), rows, PLATFORM);
	return resolution !== null && resolution.kind === "tool" ? [resolution.tool] : [];
}

/** every character key the table binds -- what a user can actually press */
const boundKeys = (rows: EffectiveKeybind[] = table()) =>
	rows.filter((row) => row.by === "key").flatMap((row) => row.bindings.map((binding) => binding.hotkey));

function collisionsIn(rows: EffectiveKeybind[]): string[] {
	const identities = rows.flatMap((row) => keybindIdentities(row, PLATFORM));
	return identities.filter((identity, index) => identities.indexOf(identity) !== index);
}

describe("the keybind table", () => {
	test("no effective table binds one key twice", () => {
		// the invariant that matters once overrides exist: not that a constant
		// does not collide, but that nothing a user or a hand-edited file can
		// ask for produces a table where one key does two things
		expect(collisionsIn(table())).toEqual([]);
		// two actions handed the same key, and one handed the key another row
		// already holds by default
		expect(
			collisionsIn(
				table({
					seekBack: [captured({ key: "j", code: "KeyJ" })],
					restart: [captured({ key: "j", code: "KeyJ" })]
				})
			)
		).toEqual([]);
		expect(collisionsIn(table({ restart: [captured({ key: "v", code: "KeyV" })] }))).toEqual([]);
	});

	test("counts the code-matched reset among the physical keys it occupies", () => {
		// ctrl+0 is matched by physical key, so it holds two identities -- a
		// later ctrl+numpad-0 binding must collide with it rather than double-bind
		expect(keybindIdentities(keybindRow(table(), "viewportReset"), PLATFORM)).toEqual([
			"code:Control:Digit0",
			"code:Control:Numpad0"
		]);
	});

	test("a character binding's identity carries its modifiers", () => {
		// so that ctrl+V and a bare V are two free keys rather than one taken one
		expect(bindingIdentities("key", captured({ key: "v", code: "KeyV" }), PLATFORM)).not.toEqual(
			bindingIdentities("key", captured({ key: "v", code: "KeyV", ctrlKey: true }), PLATFORM)
		);
	});

	test("gives every tool exactly one key", () => {
		// a palette tile shipping unreachable from the keyboard fails here
		for (const tool of TOOL_IDS) {
			expect(boundKeys().filter((key) => toolsArmedBy(key).includes(tool))).toHaveLength(1);
		}
	});

	test("lists every action, each in a group and reachable from the keyboard", () => {
		// the surface cannot drift from the inventory: a keybind declared here
		// gets a settings row and a help-overlay row for free, and one shipped
		// with nothing bound would be an action no user could ever find
		for (const row of table()) {
			expect(row.bindings.length).toBeGreaterThan(0);
			expect(["playback", "viewport", "editing", "general"]).toContain(row.group);
		}
	});

	test("locks cancel and nothing else, with the reason it is locked", () => {
		const locked = table().filter((row) => row.locked !== null);
		expect(locked.map((row) => row.action)).toEqual(["cancel"]);
		expect(locked[0].locked).toContain("Escape");
	});

	test("matches the help key on the key, not the physical code", () => {
		// a function key reports the same `key` on every layout, so the layout
		// question the code-matched path exists for never arises for the one
		// binding whose job is being findable by someone who does not know the
		// keys -- and a second hand-rolled matcher would buy nothing
		expect(keybindRow(table(), "showHelp").by).toBe("key");
		expect(keybindRow(table(), "showHelp").locked).toBeNull();
	});

	test("registers the tool keys and the snap toggle globally", () => {
		// the actions use-playback-shortcuts applies through the resolver are the
		// actions the resolver answers for: neither list can grow without the other
		const rows = EDIT_ACTIONS.map((action) => keybindRow(table(), action));
		expect(
			rows.every((row) => resolveEditKeybind(row.bindings[0].hotkey, editing(), table(), PLATFORM) !== null)
		).toBe(true);
		expect(EDIT_ACTIONS).toHaveLength(TOOL_IDS.length + 1);
		expect(rows.every((row) => row.owner === "global")).toBe(true);
	});
});

describe("the overrides fold", () => {
	test("an action absent from the map follows its default", () => {
		// which is what lets a better default in a later version reach a user
		// who never touched that row
		expect(bindingsFor({}, "selectTool")).toEqual(["V"]);
		expect(bindingsFor({ restart: [captured({ key: "j", code: "KeyJ" })] }, "selectTool")).toEqual(["V"]);
	});

	test("an action present with bindings takes them", () => {
		const overrides = { selectTool: [captured({ key: "к", code: "KeyV" })] };
		expect(bindingsFor(overrides, "selectTool")).toEqual(["К"]);
	});

	test("an action present and empty is unbound", () => {
		expect(bindingsFor({ toggleSnap: [] }, "toggleSnap")).toEqual([]);
	});

	test("an unbind comes back as an unbind, never as a reset", () => {
		// the three states across a round trip: the map is what persists, and
		// collapsing "deliberately unbound" into "never touched" would make
		// unbinding a lie that expires at the next launch
		const unbound: KeybindOverrides = { eraseTool: [] };
		const moved: KeybindOverrides = { eraseTool: [captured({ key: "d", code: "KeyD" })] };
		const reloaded = (map: KeybindOverrides) => table(JSON.parse(JSON.stringify(map)) as KeybindOverrides);
		expect(keybindRow(reloaded(unbound), "eraseTool").bindings).toEqual([]);
		expect(keybindRow(reloaded(moved), "eraseTool").bindings.map((b) => b.hotkey)).toEqual(["D"]);
		expect(keybindRow(reloaded({}), "eraseTool").bindings.map((b) => b.hotkey)).toEqual(["E"]);
	});

	test("a row carries whether the user's own map put it there", () => {
		// the per-row revert appears on an overridden row and on no other, so
		// this flag doubles as the indicator that the row is the user's
		expect(keybindRow(table(), "moveTool").overridden).toBe(false);
		expect(keybindRow(table({ moveTool: [] }), "moveTool").overridden).toBe(true);
	});

	test("a locked row ignores an override entirely", () => {
		const rows = table({ cancel: [captured({ key: "q", code: "KeyQ" })] });
		expect(keybindRow(rows, "cancel").bindings.map((b) => b.hotkey)).toEqual(["Escape"]);
		expect(keybindRow(rows, "cancel").overridden).toBe(false);
	});

	test("a hand-edited hotkey is read in whatever spelling it was written in", () => {
		// the library's own normaliser, so `ctrl+v` from a text editor and a
		// captured Mod+V are one binding rather than two that look alike
		expect(bindingsFor({ lassoTool: [{ hotkey: "ctrl+j", codes: [] }] }, "lassoTool")).toEqual(["Mod+J"]);
	});

	test("a hand-edited entry of the wrong shape leaves the action on its default", () => {
		// a typo must not brick the keyboard: the app starts with a sensible
		// table whatever the file says
		const bogus = { moveTool: "M", smoothTool: [{ nope: true }], eraseTool: 7 } as unknown as KeybindOverrides;
		expect(bindingsFor(bogus, "moveTool")).toEqual(["M"]);
		expect(bindingsFor(bogus, "smoothTool")).toEqual(["S"]);
		expect(bindingsFor(bogus, "eraseTool")).toEqual(["E"]);
	});
});

describe("reconciliation", () => {
	test("a colliding override falls back to its own default", () => {
		// declaration order decides: seek back is listed before the select tool,
		// so it keeps the key and the tool comes back on V
		const overrides = { seekBack: [captured({ key: "v", code: "KeyV" })] };
		expect(bindingsFor(overrides, "seekBack")).toEqual(["V"]);
		expect(bindingsFor(overrides, "selectTool")).toEqual([]);
	});

	test("an override whose default is also taken comes back unbound", () => {
		// the select tool asks for Home, which restart is listed ahead of it
		// holding, and the V it would fall back to has gone to seek back
		const overrides = {
			seekBack: [captured({ key: "v", code: "KeyV" })],
			selectTool: [captured({ key: "Home", code: "Home" })]
		};
		expect(bindingsFor(overrides, "restart")).toEqual(["Home"]);
		expect(bindingsFor(overrides, "selectTool")).toEqual([]);
	});

	test("the same file always produces the same table", () => {
		const overrides = {
			seekBack: [captured({ key: "v", code: "KeyV" })],
			selectTool: [captured({ key: "ArrowLeft", code: "ArrowLeft" })],
			restart: []
		};
		expect(table(overrides)).toEqual(table(overrides));
		expect(collisionsIn(table(overrides))).toEqual([]);
	});

	test("a locked row keeps its key however the file asks for it", () => {
		// the capture reader can never produce this, but a hand-edited or
		// newer-build file can: an action declared ahead of cancel asking for
		// Escape. cancel is claimed by listeners no override reaches -- the
		// dialogs close on it natively -- so a table calling it unbound while the
		// key still cancels would be two meanings of one press, which is the
		// whole reason the row is locked
		const overrides = { selectTool: [{ hotkey: "Escape", codes: ["Escape"] }] };
		expect(bindingsFor(overrides, "cancel")).toEqual(["Escape"]);
		expect(bindingsFor(overrides, "selectTool")).toEqual(["V"]);
		expect(collisionsIn(table(overrides))).toEqual([]);
	});

	test("an override that is only a modifier leaves the action on its default", () => {
		// `Control` parses as an ordinary key with no ctrl flag, so a real
		// Control press -- which reports ctrlKey -- could never match it. the row
		// would print a key nothing can press; the typo must not cost a binding
		expect(bindingsFor({ moveTool: [{ hotkey: "Control", codes: ["ControlLeft"] }] }, "moveTool")).toEqual(["M"]);
		expect(bindingsFor({ moveTool: [{ hotkey: "Shift", codes: ["ShiftLeft"] }] }, "moveTool")).toEqual(["M"]);
	});
});

describe("readCapture", () => {
	test("reads one press into a binding carrying both the character and the key", () => {
		// the crux of the layout fix: a cyrillic keyboard prints `м` for the
		// physical KeyV, and both halves are recorded so the entry's matcher
		// decides which one is matched against
		expect(captured({ key: "м", code: "KeyV" })).toEqual({ hotkey: "М", codes: ["KeyV"] });
	});

	test("carries the modifiers of a chord, in the library's own normalized form", () => {
		expect(captured({ key: "s", code: "KeyS", ctrlKey: true }).hotkey).toBe("Mod+S");
		expect(captured({ key: "s", code: "KeyS", ctrlKey: true, shiftKey: true }).hotkey).toBe("Mod+Shift+S");
	});

	test("rejects a press that is only modifiers", () => {
		// resting on ctrl while thinking must not bind something absurd
		expect(readCapture(press({ key: "Control", code: "ControlLeft", ctrlKey: true }), PLATFORM).kind).toBe(
			"incomplete"
		);
		expect(readCapture(press({ key: "Shift", code: "ShiftLeft", shiftKey: true }), PLATFORM).kind).toBe(
			"incomplete"
		);
	});

	test("lets Tab go rather than binding it", () => {
		// Tab is the only way off the control: capturing it would take the key
		// the app is navigated by *and* leave the slot's blur-disarm unreachable,
		// so the user would end up bound to Tab with no second chance. the
		// separate answer is what tells the caller to leave the default alone
		expect(readCapture(press({ key: "Tab", code: "Tab" }), PLATFORM).kind).toBe("passthrough");
		expect(readCapture(press({ key: "Tab", code: "Tab", shiftKey: true }), PLATFORM).kind).toBe("passthrough");
	});

	test("refuses a dead key, which the library answers from the code instead", () => {
		// macOS Option+E and the european accent keys report the literal key
		// "Dead". the library's matcher sees that and compares the *physical
		// code* against the stored key, so `Alt+Dead` could never match the very
		// press that produced it -- the row would print a binding that does
		// nothing
		expect(readCapture(press({ key: "Dead", code: "KeyE", altKey: true }), PLATFORM)).toEqual({
			kind: "unsupported"
		});
	});

	test("cancels on Escape and never captures it", () => {
		// arming a slot is never a trap
		expect(readCapture(press({ key: "Escape", code: "Escape" }), PLATFORM).kind).toBe("cancelled");
		expect(readCapture(press({ key: "Escape", code: "Escape", ctrlKey: true }), PLATFORM).kind).toBe("cancelled");
	});

	test("refuses a key the hotkey grammar cannot spell", () => {
		// `+` is the library's own chord separator, so a binding on it parses
		// back to an empty key: it would look bound in the row and be dead after
		// a reload, which is the one outcome this whole surface exists to remove
		expect(readCapture(press({ key: "+", code: "NumpadAdd" }), PLATFORM).kind).toBe("unsupported");
		// and a settings file hand-edited to hold one leaves the action on its
		// default rather than claiming an empty identity
		expect(bindingsFor({ moveTool: [{ hotkey: "+", codes: ["NumpadAdd"] }] }, "moveTool")).toEqual(["M"]);
	});

	test("captures the keys the library's own recorder would have eaten", () => {
		// Backspace and Delete are clear in the library's recorder, and they are
		// erase selection's own defaults -- unrecordable is not an option here
		expect(captured({ key: "Backspace", code: "Backspace" }).hotkey).toBe("Backspace");
		expect(captured({ key: "Delete", code: "Delete" }).hotkey).toBe("Delete");
		expect(captured({ key: " ", code: "Space" }).hotkey).toBe("Space");
	});
});

describe("capturing into a slot", () => {
	test("a captured key resolves to its action", () => {
		// what a cyrillic user ends up with: the letter their own keyboard
		// prints arms the tool the default V never could
		const { overrides } = applyCapture(
			{},
			table(),
			"selectTool",
			0,
			captured({ key: "м", code: "KeyV" }),
			PLATFORM
		);
		expect(toolsArmedBy("м", table(overrides))).toEqual(["select"]);
		expect(toolsArmedBy("V", table(overrides))).toEqual([]);
	});

	test("a colliding capture takes the key and unbinds the row that had it", () => {
		// one step rather than three: the user does not go clear the other row
		// and come back
		const { overrides, displaced } = applyCapture(
			{},
			table(),
			"restart",
			0,
			captured({ key: "v", code: "KeyV" }),
			PLATFORM
		);
		expect(bindingsFor(overrides, "restart")).toEqual(["V"]);
		expect(bindingsFor(overrides, "selectTool")).toEqual([]);
		// the displaced row says inline what it lost, so the consequence sits
		// where the user will look
		expect(displaced).toEqual([{ action: "selectTool", binding: { hotkey: "V", codes: ["KeyV"] } }]);
	});

	test("stealing one of two keys leaves the other alone", () => {
		const { overrides } = applyCapture(
			{},
			table(),
			"restart",
			0,
			captured({ key: "Delete", code: "Delete" }),
			PLATFORM
		);
		expect(bindingsFor(overrides, "eraseSelection")).toEqual(["Backspace"]);
	});

	test("an alternate lands beside the primary without displacing it", () => {
		const { overrides } = applyCapture({}, table(), "restart", 1, captured({ key: "g", code: "KeyG" }), PLATFORM);
		expect(bindingsFor(overrides, "restart")).toEqual(["Home", "G"]);
	});

	test("capturing the key the row already had leaves it unoverridden", () => {
		// sparse: an action the user has not actually changed keeps inheriting
		// a later change to its default
		const { overrides } = applyCapture(
			{},
			table(),
			"selectTool",
			0,
			captured({ key: "v", code: "KeyV" }),
			PLATFORM
		);
		expect(keybindRow(table(overrides), "selectTool").overridden).toBe(false);
	});

	test("a row cannot end up bound to one key twice", () => {
		const { overrides } = applyCapture(
			{},
			table(),
			"eraseSelection",
			1,
			captured({ key: "Delete", code: "Delete" }),
			PLATFORM
		);
		expect(bindingsFor(overrides, "eraseSelection")).toEqual(["Delete"]);
	});

	test("a locked row refuses a capture, and says why", () => {
		const outcome = applyCapture({}, table(), "cancel", 0, captured({ key: "q", code: "KeyQ" }), PLATFORM);
		expect(bindingsFor(outcome.overrides, "cancel")).toEqual(["Escape"]);
		expect(outcome.refused).toContain("Escape");
	});

	test("a plain letter cannot end up driving a code-matched row and a tool at once", () => {
		// the two matchers cannot be compared without a layout map, so uniqueness
		// holds within a matcher and not across them. confining the code-matched
		// rows to chords is what keeps that from mattering: `V` on the reset
		// would otherwise arm the select tool and reset the viewport on one
		// keystroke, with both rows reading as bound to V and nothing displaced
		const outcome = applyCapture({}, table(), "viewportReset", 0, captured({ key: "v", code: "KeyV" }), PLATFORM);
		expect(outcome.refused).not.toBeNull();
		expect(toolsArmedBy("V", table(outcome.overrides))).toEqual(["select"]);
		expect(bindingsFor(outcome.overrides, "viewportReset")).toEqual(["Mod+0"]);
	});

	test("a code-matched row refuses a capture the physical key did not reach", () => {
		// codes are what it matches on, so a binding without one would print its
		// hotkey in the list and answer to no press at all
		const outcome = applyCapture({}, table(), "viewportReset", 0, { hotkey: "Mod+R", codes: [] }, PLATFORM);
		expect(outcome.refused).not.toBeNull();
		expect(bindingsFor(outcome.overrides, "viewportReset")).toEqual(["Mod+0"]);
		expect(bindingsFor({ viewportReset: [{ hotkey: "Mod+R", codes: [] }] }, "viewportReset")).toEqual(["Mod+0"]);
	});

	test("a code-matched row refuses a capture with no modifier", () => {
		// the two matchers live in separate identity namespaces, so a bare
		// physical key on the reset would collide invisibly with whatever
		// character its keycap prints -- and the uniqueness invariant would go on
		// reporting a clean table
		const outcome = applyCapture({}, table(), "viewportReset", 0, captured({ key: "r", code: "KeyR" }), PLATFORM);
		expect(outcome.refused).not.toBeNull();
		expect(bindingsFor(outcome.overrides, "viewportReset")).toEqual(["Mod+0"]);
		// a hand-edited file gets the same answer, silently
		expect(bindingsFor({ viewportReset: [{ hotkey: "R", codes: ["KeyR"] }] }, "viewportReset")).toEqual(["Mod+0"]);
	});

	test("a numpad digit captured with numlock off is refused rather than left dead", () => {
		// with numlock off that code reports Insert, and the code matcher asks a
		// numpad digit for its printed character too (ctrl+insert is copy). so
		// this binding would answer to nothing at all -- including the very press
		// that made it. the shipped ctrl+0 is unaffected: it also carries Digit0
		const numlockOff = { hotkey: "Mod+Insert", codes: ["Numpad0"] };
		const outcome = applyCapture({}, table(), "viewportReset", 0, numlockOff, PLATFORM);
		expect(outcome.refused).not.toBeNull();
		expect(bindingsFor(outcome.overrides, "viewportReset")).toEqual(["Mod+0"]);
		expect(bindingsFor({ viewportReset: [numlockOff] }, "viewportReset")).toEqual(["Mod+0"]);
	});

	test("a steal takes the key from a row that would only reclaim it on the next fold", () => {
		// the lasso took M and move tool was reverted, so move tool shows nothing
		// -- but its *default* is still M, and it is declared ahead of the erase
		// tool. clearing the lasso alone would hand M straight back to it and the
		// capture would silently fail to land on the row the user configured
		const before: KeybindOverrides = { lassoTool: [captured({ key: "m", code: "KeyM" })] };
		expect(bindingsFor(before, "moveTool")).toEqual([]);

		const outcome = applyCapture(
			before,
			table(before),
			"eraseTool",
			0,
			captured({ key: "m", code: "KeyM" }),
			PLATFORM
		);
		expect(outcome.refused).toBeNull();
		expect(bindingsFor(outcome.overrides, "eraseTool")).toEqual(["M"]);
		expect(bindingsFor(outcome.overrides, "moveTool")).toEqual([]);
		expect(bindingsFor(outcome.overrides, "lassoTool")).toEqual([]);
		// and the row the user could see lose a key is the only one told it did
		expect(outcome.displaced.map((entry) => entry.action)).toEqual(["lassoTool"]);
	});

	test("a steal takes the key from a row that is only riding its default", () => {
		// select tool asked for Home and lost it to restart, so it is visibly
		// back on V while its override still says Home. taking V has to leave it
		// unable to claim V again, or the fold hands V straight back and the
		// capture never reaches the row the user configured
		const before: KeybindOverrides = { selectTool: [captured({ key: "Home", code: "Home" })] };
		expect(bindingsFor(before, "selectTool")).toEqual(["V"]);

		const outcome = applyCapture(
			before,
			table(before),
			"eraseTool",
			0,
			captured({ key: "v", code: "KeyV" }),
			PLATFORM
		);
		expect(outcome.refused).toBeNull();
		expect(bindingsFor(outcome.overrides, "eraseTool")).toEqual(["V"]);
		expect(bindingsFor(outcome.overrides, "selectTool")).toEqual([]);
		expect(bindingsFor(outcome.overrides, "restart")).toEqual(["Home"]);
		expect(outcome.displaced.map((entry) => entry.action)).toEqual(["selectTool"]);
	});

	test("a capture always ends up holding the key it took", () => {
		// the guarantee behind both cases above, asserted directly: whatever the
		// map looked like going in, the row the user armed is the row the key
		// resolves to afterwards, and nothing else answers to it
		const messy: KeybindOverrides = {
			selectTool: [captured({ key: "Home", code: "Home" })],
			lassoTool: [captured({ key: "m", code: "KeyM" })]
		};
		for (const action of ["eraseTool", "smoothTool", "seekForward"] as KeybindAction[]) {
			for (const key of [
				{ key: "v", code: "KeyV" },
				{ key: "m", code: "KeyM" },
				{ key: "Home", code: "Home" }
			]) {
				const outcome = applyCapture(messy, table(messy), action, 0, captured(key), PLATFORM);
				const after = table(outcome.overrides);
				expect(keybindRow(after, action).bindings[0]).toEqual(captured(key));
				expect(collisionsIn(after)).toEqual([]);
			}
		}
	});
});

describe("ending a held binding", () => {
	test("a chord is over when its main key comes up, whatever the modifiers did", () => {
		// play/pause latches the viewport pan on the way down, so a release it
		// cannot see leaves the app stuck panning. the library's own matcher
		// demands the whole chord on the keyup, which a chord let go of
		// modifier-first never delivers
		expect(keybindMainKey("Mod+K", PLATFORM)).toBe("K");
		expect(releasedMainKey({ key: "k" })).toBe("K");
	});

	test("the shipped space is over when space comes up, modifier touched or not", () => {
		expect(keybindMainKey("Space", PLATFORM)).toBe("Space");
		expect(releasedMainKey({ key: " " })).toBe("Space");
	});

	test("an alternate binding is a different press from the primary", () => {
		// holding the primary and tapping the alternate's key must not read as
		// the primary being let go: the pan would drop mid-drag and playback
		// would toggle behind it. the two keys simply do not compare equal
		const [primary, alternate] = [keybindMainKey("Space", PLATFORM), keybindMainKey("Mod+K", PLATFORM)];
		expect(releasedMainKey({ key: "k" })).not.toBe(primary);
		expect(releasedMainKey({ key: " " })).not.toBe(alternate);
	});
});

describe("matchesKeybind", () => {
	const erase = (overrides: KeybindOverrides = {}) => keybindRow(table(overrides), "eraseSelection");

	test("the gesture-owned keys answer to both of their defaults", () => {
		expect(matchesKeybind(press({ key: "Delete", code: "Delete" }), erase(), PLATFORM)).toBe(true);
		expect(matchesKeybind(press({ key: "Backspace", code: "Backspace" }), erase(), PLATFORM)).toBe(true);
		expect(matchesKeybind(press({ key: "q", code: "KeyQ" }), erase(), PLATFORM)).toBe(false);
	});

	test("a rebound gesture key is the key that erases, and the old one stops", () => {
		const { overrides } = applyCapture(
			{},
			table(),
			"eraseSelection",
			0,
			captured({ key: "q", code: "KeyQ" }),
			PLATFORM
		);
		expect(matchesKeybind(press({ key: "q", code: "KeyQ" }), erase(overrides), PLATFORM)).toBe(true);
		expect(matchesKeybind(press({ key: "Delete", code: "Delete" }), erase(overrides), PLATFORM)).toBe(false);
	});

	test("an unbound row answers to nothing", () => {
		// each clear reads the table the previous one produced, the way the
		// settings row does
		const once = clearBinding({}, table(), "eraseSelection", 1, PLATFORM);
		const overrides = clearBinding(once, table(once), "eraseSelection", 0, PLATFORM);
		expect(matchesKeybind(press({ key: "Delete", code: "Delete" }), erase(overrides), PLATFORM)).toBe(false);
		expect(matchesKeybind(press({ key: "Backspace", code: "Backspace" }), erase(overrides), PLATFORM)).toBe(false);
	});

	test("the viewport reset stays the physical zero under exactly ctrl", () => {
		// the layouts the code-matched path exists for: azerty prints `à` there
		// unshifted and "0" only with shift, and both are one user pressing
		// "ctrl and the zero key"
		const reset = keybindRow(table(), "viewportReset");
		const zero = (over: Partial<CaptureKeyEvent>) =>
			matchesKeybind(press({ ctrlKey: true, ...over }), reset, PLATFORM);
		expect(zero({ code: "Digit0", key: "0" })).toBe(true);
		expect(zero({ code: "Digit0", key: "à" })).toBe(true);
		expect(zero({ code: "Digit0", key: "0", shiftKey: true })).toBe(false);
		// numlock off makes that same code Insert, and ctrl+insert is copy
		expect(zero({ code: "Numpad0", key: "0" })).toBe(true);
		expect(zero({ code: "Numpad0", key: "Insert" })).toBe(false);
		// chromium reports altgr as ctrl+alt, and altgr+0 is `}` on the
		// german-family layouts
		expect(zero({ code: "Digit0", key: "}", altKey: true })).toBe(false);
		expect(matchesKeybind(press({ code: "Digit0", key: "0" }), reset, PLATFORM)).toBe(false);
	});

	test("a rebound viewport reset keeps the modifier the user pressed", () => {
		// an override that dropped the chord would silently turn ctrl+0 into a
		// bare 0, which is a key the user is going to press by accident
		const { overrides } = applyCapture(
			{},
			table(),
			"viewportReset",
			0,
			captured({ key: "r", code: "KeyR", ctrlKey: true, shiftKey: true }),
			PLATFORM
		);
		const reset = keybindRow(table(overrides), "viewportReset");
		expect(reset.bindings[0].hotkey).toBe("Mod+Shift+R");
		expect(matchesKeybind(press({ code: "KeyR", key: "R", ctrlKey: true, shiftKey: true }), reset, PLATFORM)).toBe(
			true
		);
		expect(matchesKeybind(press({ code: "KeyR", key: "r" }), reset, PLATFORM)).toBe(false);
	});
});

describe("clearing and reverting", () => {
	test("clearing the primary leaves the action unbound, and it stays unbound", () => {
		const overrides = clearBinding({}, table(), "eraseTool", 0, PLATFORM);
		expect(bindingsFor(overrides, "eraseTool")).toEqual([]);
		expect(toolsArmedBy("E", table(overrides))).toEqual([]);
		// an explicit entry, so a reload cannot quietly overrule the choice
		expect(keybindRow(table(overrides), "eraseTool").overridden).toBe(true);
	});

	test("clearing one of two keys keeps the other", () => {
		const overrides = clearBinding({}, table(), "eraseSelection", 0, PLATFORM);
		expect(bindingsFor(overrides, "eraseSelection")).toEqual(["Backspace"]);
	});

	test("reverting one row costs the user none of their others", () => {
		let overrides = applyCapture(
			{},
			table(),
			"restart",
			0,
			captured({ key: "g", code: "KeyG" }),
			PLATFORM
		).overrides;
		overrides = applyCapture(
			overrides,
			table(overrides),
			"moveTool",
			0,
			captured({ key: "n", code: "KeyN" }),
			PLATFORM
		).overrides;
		const reverted = revertKeybind(overrides, "restart");
		expect(bindingsFor(reverted, "restart")).toEqual(["Home"]);
		expect(bindingsFor(reverted, "moveTool")).toEqual(["N"]);
	});

	test("restoring the defaults is the empty map", () => {
		// the recovery path once unbinding exists, so a user who unbinds
		// something essential never has to hand-edit the settings file
		expect(defaultKeybinds(PLATFORM)).toEqual(table({}));
	});
});

describe("resolveEditKeybind", () => {
	test("arms each tool from its own key", () => {
		for (const tool of TOOL_IDS) {
			const key = keybindRow(table(), TOOL_KEYBINDS[tool].action).bindings[0].hotkey;
			expect(resolveEditKeybind(key, editing(), table(), PLATFORM)).toEqual({ kind: "tool", tool });
		}
	});

	test("reads a tool key whatever case the press arrives in", () => {
		// the hotkey library matches letters case-insensitively, so an
		// unshifted press arrives as "v" against a table that prints "V"
		expect(resolveEditKeybind("v", editing(), table(), PLATFORM)).toEqual({ kind: "tool", tool: "select" });
	});

	test("toggles snap rather than arming a sixth tool", () => {
		expect(resolveEditKeybind("X", editing(), table(), PLATFORM)).toEqual({ kind: "snap" });
	});

	test("does nothing in watch mode", () => {
		const watching = editing({ mode: "watch" });
		for (const key of boundKeys()) expect(resolveEditKeybind(key, watching, table(), PLATFORM)).toBeNull();
	});

	test("does nothing on a non-editable replay", () => {
		// quietly: the disabled palette is already showing the reason
		const blocked = editing({ editable: false });
		for (const key of boundKeys()) expect(resolveEditKeybind(key, blocked, table(), PLATFORM)).toBeNull();
	});

	test("does nothing while a gesture is live", () => {
		// the drag finishes as the tool it started as
		const dragging = editing({ gestureLive: true });
		for (const key of boundKeys()) expect(resolveEditKeybind(key, dragging, table(), PLATFORM)).toBeNull();
	});

	test("leaves the playback keys to the playback handlers", () => {
		for (const key of ["Space", "ArrowLeft", "ArrowRight", ",", ".", "Home"]) {
			expect(resolveEditKeybind(key, editing(), table(), PLATFORM)).toBeNull();
		}
	});

	test("leaves the gesture-owned keys to their own handlers", () => {
		// listed in the table, registered in use-edit-tools: cancel and erase
		// need gesture-local state this resolver cannot see
		for (const key of ["Escape", "Delete", "Backspace"]) {
			expect(resolveEditKeybind(key, editing(), table(), PLATFORM)).toBeNull();
		}
	});

	test("ignores a key the table does not bind", () => {
		expect(resolveEditKeybind("Q", editing(), table(), PLATFORM)).toBeNull();
	});

	test("an unbound tool key arms nothing", () => {
		const overrides = clearBinding({}, table(), "smoothTool", 0, PLATFORM);
		expect(resolveEditKeybind("S", editing(), table(overrides), PLATFORM)).toBeNull();
	});
});

describe("the inventory as data", () => {
	test("the keyed table and the ordered one describe the same rows", () => {
		expect(KEYBIND_ENTRIES.map((entry) => entry.action)).toEqual(Object.keys(KEYBINDS) as KeybindAction[]);
	});

	test("every entry is keyed by its own action", () => {
		for (const [key, entry] of Object.entries(KEYBINDS)) expect(entry.action).toBe(key as KeybindAction);
	});
});
