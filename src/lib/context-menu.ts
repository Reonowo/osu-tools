// the context menu's whole decision surface, in the mould of the open menu's
// and severity jump's decision modules: given the resolved right-click
// geometry, the current selection, the frame-edit gate and the effective
// keybinds, decide the selection change to apply and the ordered items as
// pure data. the dom half (components/EditContextMenu.tsx and the two
// surface shells) renders and dispatches; it decides nothing. pure, so `bun
// test src` pins every rule without a dom, pixi, or base-ui.
//
// two standing rules live here. parameterized operations route to the
// surface that takes their parameters instead of growing submenus (offset…
// raises the frames tab; open in keys panel raises the keys tab) -- and a
// routing item is not a mutating item, so it stays enabled on a non-editable
// scene, where the destination's own controls state the gate's reason.
// mutating items disable with the gate's reason in their tooltip, matching
// every other edit surface

import type { FrameEditGate } from "../editor/gate";
import type { PressSelection } from "../editor/press-runs";
import type { PhysicalKey } from "../engine/buttons";
import { NO_LATTICE_REASON } from "./lattice";
import {
	formatBindings,
	keybindRow,
	type EffectiveKeybind,
	type KeybindAction,
	type KeybindPlatform
} from "../playback/keybinds";

/** what activating an item does, as data: an existing commit dispatched
 * through the store's commit path, or a routing jump to the surface that
 * takes the operation's parameters. add press carries the attribution its
 * geometry states -- the lane's key and the time under the pointer (the
 * glossary's Armed key entry records the two add-press rules) */
export type EditMenuAction =
	| { kind: "erase" }
	| { kind: "smooth" }
	| { kind: "snapToLattice" }
	| { kind: "deletePress" }
	| { kind: "addPress"; key: PhysicalKey; atMs: number }
	| { kind: "route"; to: "framesOffset" | "keysPanel" };

/** one menu item as pure data; the dom half renders exactly this */
export interface EditMenuItem {
	label: string;
	/** the action's effective keys as the menu prints them -- the store's
	 * folded table, so user overrides print correctly -- or null when the
	 * action has no keybind or the user unbound it */
	hint: string | null;
	/** why the item cannot act, in the voice its tooltip prints, or null
	 * when it is enabled */
	disabled: string | null;
	action: EditMenuAction;
}

/** the selection change to apply before the menu opens. viewport indices are
 * displayed-space (the gesture base's), and the shell owns the translation
 * back to authoritative space, exactly as it does for gestures */
export type EditMenuSelection = { kind: "frames"; indices: number[] } | { kind: "press"; selection: PressSelection };

export interface EditMenuPlan {
	/** null keeps the selection that stands */
	select: EditMenuSelection | null;
	items: EditMenuItem[];
}

function hintFor(
	keybinds: readonly EffectiveKeybind[],
	action: KeybindAction,
	platform?: KeybindPlatform
): string | null {
	return formatBindings(keybindRow(keybinds, action).bindings, platform);
}

function gateReason(gate: FrameEditGate): string | null {
	return gate.editable ? null : gate.reason;
}

export interface ViewportMenuFacts {
	/** the nearest candidate frame under the pointer, displayed space, or
	 * null -- the same hit test and candidate window the gestures use, so
	 * right-click and left-click agree on what is reachable */
	hit: number | null;
	/** the current frame selection, displayed space */
	selection: readonly number[];
	gate: FrameEditGate;
	/** whether a lattice was inferred, which is what snap needs beyond the gate */
	hasLattice: boolean;
	keybinds: readonly EffectiveKeybind[];
}

/**
 * the viewport's menu: frame operations on a reachable point of the cursor
 * path. null means no menu at all -- empty playfield and unreachable trail
 * points open nothing (the app-root guard has already suppressed the native
 * menu). the selection rule: an unselected hit replaces the frame selection
 * with itself so the menu always acts on the thing under the pointer; a hit
 * inside the existing selection keeps it, so the menu acts on all the frames
 * the user gathered. selecting never seeks.
 */
export function viewportContextMenu(facts: ViewportMenuFacts, platform?: KeybindPlatform): EditMenuPlan | null {
	if (facts.hit === null) return null;
	const reason = gateReason(facts.gate);
	return {
		select: facts.selection.includes(facts.hit) ? null : { kind: "frames", indices: [facts.hit] },
		items: [
			{
				label: "erase",
				hint: hintFor(facts.keybinds, "eraseSelection", platform),
				disabled: reason,
				action: { kind: "erase" }
			},
			{
				label: "smooth",
				hint: hintFor(facts.keybinds, "smoothSelection", platform),
				disabled: reason,
				action: { kind: "smooth" }
			},
			{
				label: "snap to lattice",
				hint: null,
				disabled: reason ?? (facts.hasLattice ? null : NO_LATTICE_REASON),
				action: { kind: "snapToLattice" }
			},
			// the routing rule's first item: offset takes a typed delta, so it
			// routes to the frames panel's Δx field rather than growing a
			// directional submenu. enabled on a non-editable scene -- it only
			// navigates, and the destination controls carry the gate's reason
			{
				label: "offset…",
				hint: null,
				disabled: null,
				action: { kind: "route", to: "framesOffset" }
			}
		]
	};
}

export interface HoldLaneMenuFacts {
	/** the hold lane under the pointer, or null outside the four lanes --
	 * the gutters, the ruler, the object lane and the velocity row open
	 * nothing */
	laneKey: PhysicalKey | null;
	/** the time under the pointer, ms, through the lanes' own inversion */
	atMs: number;
	/** the start index of the press run under the pointer, or null on a gap */
	runStartIndex: number | null;
	gate: FrameEditGate;
	keybinds: readonly EffectiveKeybind[];
}

/**
 * the timeline's menu: press operations where the timeline shows them. on a
 * press span the press becomes the press selection -- without the pause the
 * left-click select-and-drag entry performs, so right-click is never an edit
 * affordance with a playback side effect -- and the menu offers the delete
 * expansion and the routing jump to the press's full editing surface. on a
 * gap it offers add press, attributed the lane's key and the pointer's time.
 * watch mode is unreachable by construction: the hold lanes mount only in
 * edit mode.
 */
export function holdLaneContextMenu(facts: HoldLaneMenuFacts): EditMenuPlan | null {
	if (facts.laneKey === null) return null;
	const reason = gateReason(facts.gate);
	if (facts.runStartIndex !== null) {
		return {
			select: { kind: "press", selection: { key: facts.laneKey, startIndex: facts.runStartIndex } },
			items: [
				{ label: "delete press", hint: null, disabled: reason, action: { kind: "deletePress" } },
				// routing, so enabled whatever the gate says: the keypress
				// panel's own controls state the reason there
				{
					label: "open in keys panel",
					hint: null,
					disabled: null,
					action: { kind: "route", to: "keysPanel" }
				}
			]
		};
	}
	return {
		select: null,
		items: [
			{
				label: "add press",
				hint: null,
				disabled: reason,
				action: { kind: "addPress", key: facts.laneKey, atMs: facts.atMs }
			}
		]
	};
}
