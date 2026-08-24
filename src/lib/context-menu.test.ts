// the context menu's decision surface: given resolved geometry, selections,
// the gate and the keybind table, assert the selection change and the item
// list -- labels, hints, enabled/disabled with the reason, and the action
// data. no dom, no pixi, no base-ui anywhere (the spec's testing decision);
// the dom shells only render and dispatch what these functions decide

import { describe, expect, test } from "bun:test";
import type { FrameEditGate } from "../editor/gate";
import { defaultKeybinds, foldKeybinds } from "../playback/keybinds";
import {
	holdLaneContextMenu,
	viewportContextMenu,
	type EditMenuPlan,
	type HoldLaneMenuFacts,
	type ViewportMenuFacts
} from "./context-menu";

const EDITABLE: FrameEditGate = { editable: true };
const GATED: FrameEditGate = { editable: false, reason: "this replay was not simulated" };
const TABLE = defaultKeybinds("windows");

function viewportFacts(overrides: Partial<ViewportMenuFacts> = {}): ViewportMenuFacts {
	return { hit: 4, selection: [], gate: EDITABLE, hasLattice: true, keybinds: TABLE, ...overrides };
}

function laneFacts(overrides: Partial<HoldLaneMenuFacts> = {}): HoldLaneMenuFacts {
	return { laneKey: "K1", atMs: 1234, runStartIndex: 7, gate: EDITABLE, keybinds: TABLE, ...overrides };
}

function labels(plan: EditMenuPlan | null): string[] {
	return (plan?.items ?? []).map((item) => item.label);
}

function item(plan: EditMenuPlan | null, label: string) {
	const found = plan?.items.find((candidate) => candidate.label === label);
	if (found === undefined) throw new Error(`no item labelled ${label}`);
	return found;
}

describe("the viewport menu", () => {
	test("a reachable hit offers the frame operations in order, ending on the routing item", () => {
		const plan = viewportContextMenu(viewportFacts(), "windows");
		expect(labels(plan)).toEqual(["erase", "smooth", "snap to lattice", "offset…"]);
		expect(item(plan, "erase").action).toEqual({ kind: "erase" });
		expect(item(plan, "smooth").action).toEqual({ kind: "smooth" });
		expect(item(plan, "snap to lattice").action).toEqual({ kind: "snapToLattice" });
		expect(item(plan, "offset…").action).toEqual({ kind: "route", to: "framesOffset" });
	});

	test("no hit means no menu at all -- empty playfield and unreachable trail points", () => {
		expect(viewportContextMenu(viewportFacts({ hit: null }), "windows")).toBeNull();
	});

	test("an unselected hit replaces the frame selection with itself", () => {
		const plan = viewportContextMenu(viewportFacts({ hit: 4, selection: [10, 11] }), "windows");
		expect(plan?.select).toEqual({ kind: "frames", indices: [4] });
	});

	test("a hit inside the existing selection keeps it, so the menu acts on the gathered frames", () => {
		const plan = viewportContextMenu(viewportFacts({ hit: 10, selection: [9, 10, 11] }), "windows");
		expect(plan?.select).toBeNull();
	});

	test("items print their effective keybind hints", () => {
		const plan = viewportContextMenu(viewportFacts(), "windows");
		expect(item(plan, "erase").hint).toBe("Delete / Backspace");
		expect(item(plan, "smooth").hint).toBe("Shift+S");
		// no keybind exists for either, so neither may invent one
		expect(item(plan, "snap to lattice").hint).toBeNull();
		expect(item(plan, "offset…").hint).toBeNull();
	});

	test("hints honour the user's own overrides, including an unbind", () => {
		const table = foldKeybinds(
			{
				eraseSelection: [{ hotkey: "Q", codes: ["KeyQ"] }],
				smoothSelection: []
			},
			"windows"
		);
		const plan = viewportContextMenu(viewportFacts({ keybinds: table }), "windows");
		expect(item(plan, "erase").hint).toBe("Q");
		// an unbound action's hint disappears rather than lying about a key
		expect(item(plan, "smooth").hint).toBeNull();
	});

	test("a gated scene disables every mutating item with the gate's reason, and still opens", () => {
		const plan = viewportContextMenu(viewportFacts({ gate: GATED }), "windows");
		expect(plan).not.toBeNull();
		expect(item(plan, "erase").disabled).toBe("this replay was not simulated");
		expect(item(plan, "smooth").disabled).toBe("this replay was not simulated");
		expect(item(plan, "snap to lattice").disabled).toBe("this replay was not simulated");
	});

	test("offset… routes, so it stays enabled on a non-editable scene", () => {
		const plan = viewportContextMenu(viewportFacts({ gate: GATED }), "windows");
		expect(item(plan, "offset…").disabled).toBeNull();
	});

	test("snap alone disables when no lattice was inferred, in the frames panel's own words", () => {
		const plan = viewportContextMenu(viewportFacts({ hasLattice: false }), "windows");
		expect(item(plan, "snap to lattice").disabled).toBe("no input lattice could be inferred from these frames");
		expect(item(plan, "erase").disabled).toBeNull();
		expect(item(plan, "smooth").disabled).toBeNull();
	});

	test("the gate's reason outranks the lattice reason on snap", () => {
		const plan = viewportContextMenu(viewportFacts({ gate: GATED, hasLattice: false }), "windows");
		expect(item(plan, "snap to lattice").disabled).toBe("this replay was not simulated");
	});
});

describe("the hold-lane menu", () => {
	test("a press span selects that press and offers delete plus the keys-panel route", () => {
		const plan = holdLaneContextMenu(laneFacts({ laneKey: "M2", runStartIndex: 41 }));
		expect(plan?.select).toEqual({ kind: "press", selection: { key: "M2", startIndex: 41 } });
		expect(labels(plan)).toEqual(["delete press", "open in keys panel"]);
		expect(item(plan, "delete press").action).toEqual({ kind: "deletePress" });
		expect(item(plan, "open in keys panel").action).toEqual({ kind: "route", to: "keysPanel" });
	});

	test("a gap offers add press attributed the lane's key and the pointer's time", () => {
		const plan = holdLaneContextMenu(laneFacts({ laneKey: "K2", atMs: 8_765, runStartIndex: null }));
		expect(plan?.select).toBeNull();
		expect(labels(plan)).toEqual(["add press"]);
		expect(item(plan, "add press").action).toEqual({ kind: "addPress", key: "K2", atMs: 8_765 });
	});

	test("outside the hold lanes there is no menu at all", () => {
		expect(holdLaneContextMenu(laneFacts({ laneKey: null }))).toBeNull();
	});

	test("a gated scene disables the mutating items with the reason while the selection still lands", () => {
		const span = holdLaneContextMenu(laneFacts({ gate: GATED }));
		expect(span?.select).toEqual({ kind: "press", selection: { key: "K1", startIndex: 7 } });
		expect(item(span, "delete press").disabled).toBe("this replay was not simulated");
		// routing is not mutating: the keypress panel states the reason itself
		expect(item(span, "open in keys panel").disabled).toBeNull();
		const gap = holdLaneContextMenu(laneFacts({ gate: GATED, runStartIndex: null }));
		expect(item(gap, "add press").disabled).toBe("this replay was not simulated");
	});

	test("no press item claims a keybind hint, because none exists to teach", () => {
		const span = holdLaneContextMenu(laneFacts());
		expect(span?.items.every((entry) => entry.hint === null)).toBe(true);
	});
});
