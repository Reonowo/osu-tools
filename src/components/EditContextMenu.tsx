// the context menu's dom shell, shared by the viewport and the timeline's
// hold lanes: it renders and dispatches what the decision surface
// (lib/context-menu.ts) decided, and decides nothing itself. the host owns
// the geometry -- its `resolve` freezes the right-click context at the
// contextmenu instant (exactly as a gesture freezes its env), applies the
// plan's selection change, and hands back the items; a null answer opens
// nothing at all, the app-root guard having already suppressed the native menu
//
// commit items dispatch through the same functions their keybinds and panels
// use (editor/selection-commits.ts, editor/press-commits.ts), so a menu
// action is indistinguishable from the equivalent dispatch elsewhere: one
// undo step each. routing items run only once the menu has fully closed --
// the popup's own focus teardown would otherwise stomp the destination's
// focus -- which is the whole of why onOpenChangeComplete is consulted
//
// escape closes only the menu: while open, a window capture listener claims
// the press whole (preventDefault + stopPropagation), so it can never reach
// the gesture-cancel or selection-clear listeners bubbling below it. the
// keybind model's Escape-claimant inventory counts this shell as the fifth
// (playback/keybinds.ts, the cancel row)

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import type { ContextMenuRootActions, ContextMenuTriggerProps } from "@base-ui/react/context-menu";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { addPressCommit, selectedPressCommit } from "@/editor/press-commits";
import { expandDeletePress } from "@/editor/press-ops";
import { eraseSelection, smoothSelection, snapSelectionToLattice } from "@/editor/selection-commits";
import { pressLabel } from "@/editor/tool-commits";
import type { EditMenuAction, EditMenuItem } from "@/lib/context-menu";
import { framesReveal } from "@/components/panels/frames-reveal";
import { viewerStore } from "@/state/store";

type MenuRoute = Extract<EditMenuAction, { kind: "route" }>["to"];

/** an existing operation through the store's commit path, one undo step,
 * exactly the dispatch its keybind or panel twin makes */
function dispatchCommit(action: Exclude<EditMenuAction, { kind: "route" }>): void {
	switch (action.kind) {
		case "erase":
			eraseSelection();
			return;
		case "smooth":
			smoothSelection();
			return;
		case "snapToLattice":
			snapSelectionToLattice();
			return;
		case "deletePress":
			// the keypress panel's own delete: the intent reads the press
			// selection at dispatch, which the resolve installed at open
			void viewerStore.getState().commitEdit(
				selectedPressCommit(
					(key) => pressLabel("delete", key),
					(frames, run) => expandDeletePress(frames, run)
				)
			);
			return;
		case "addPress":
			// the lane's key and the pointer's time -- the attribution the
			// timeline's geometry states; median duration, hybrid-rule edges
			// and same-key merging all come from the existing expansion, and
			// the new press lands selected through its outcome
			void viewerStore
				.getState()
				.commitEdit(addPressCommit(pressLabel("add", action.key), action.key, action.atMs));
			return;
	}
}

function runRoute(to: MenuRoute): void {
	const state = viewerStore.getState();
	if (to === "framesOffset") {
		// the tab raise opens the panel too (setPanelTab's own rule); the
		// field focus rides the frames panel's reveal latch, which bridges
		// the mount the tab switch is about to cause
		state.setPanelTab("frames");
		framesReveal.requestOffsetFocus();
		return;
	}
	// the press selection was installed at open, so this is the existing
	// fix-this-note flow reached from the menu
	state.setPanelTab("keys");
}

export function EditContextMenu({
	resolve,
	render,
	children
}: {
	/** freezes the right-click context and answers with the items to show,
	 * applying the plan's selection change on the way; null opens nothing */
	resolve: (e: ReactMouseEvent<HTMLDivElement>) => EditMenuItem[] | null;
	/** the element the trigger renders as, so a host can make an existing
	 * box the right-click surface without a wrapper node */
	render: ContextMenuTriggerProps["render"];
	children?: ReactNode;
}) {
	const [items, setItems] = useState<EditMenuItem[]>([]);
	const [open, setOpen] = useState(false);
	const actionsRef = useRef<ContextMenuRootActions | null>(null);
	const pendingRouteRef = useRef<MenuRoute | null>(null);

	// the escape claim, capture-phase on the window so it runs ahead of every
	// bubbling listener: the same press must neither cancel a gesture nor
	// clear a selection. attached only while the menu is open, the way
	// DetailLanes' drag listener attaches only for its gesture -- and as a
	// layout effect, so the claim is in place before the browser can deliver
	// any keydown that follows the open
	useLayoutEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			actionsRef.current?.close();
		};
		window.addEventListener("keydown", onKeyDown, { capture: true });
		return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
	}, [open]);

	const onItem = (action: EditMenuAction) => {
		if (action.kind === "route") {
			// held until the close completes; the item press closes the menu
			pendingRouteRef.current = action.to;
			return;
		}
		dispatchCommit(action);
	};

	return (
		<ContextMenu
			actionsRef={actionsRef}
			onOpenChange={setOpen}
			onOpenChangeComplete={(nowOpen) => {
				if (nowOpen) return;
				const route = pendingRouteRef.current;
				if (route === null) return;
				pendingRouteRef.current = null;
				// one frame after the popup's teardown, so its focus return --
				// which lands around unmount -- cannot stomp the destination's
				requestAnimationFrame(() => runRoute(route));
			}}
		>
			<ContextMenuTrigger
				render={render}
				onContextMenu={(e) => {
					const plan = resolve(e);
					if (plan === null) {
						// no menu at all: the internal open handler never runs, and
						// the event proceeds to the app root's native-menu guard
						e.preventBaseUIHandler();
						return;
					}
					pendingRouteRef.current = null;
					setItems(plan);
				}}
				onTouchStart={(e) => {
					// the trigger's built-in long-press open bypasses resolve
					// entirely -- no contextmenu event, no hit test, no null
					// answer -- so a touch hold would raise an empty or stale
					// menu on surfaces that must open nothing. right-click is
					// this menu's one affordance; the touch path is declined
					// whole (a platform-synthesized contextmenu still resolves)
					e.preventBaseUIHandler();
				}}
			>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent>
				{items.map((item) => {
					const body = (
						<>
							<span>{item.label}</span>
							{item.hint !== null && (
								<span className="font-mono text-[10px] text-[#8a8a93]">{item.hint}</span>
							)}
						</>
					);
					if (item.disabled === null) {
						return (
							<ContextMenuItem key={item.label} onClick={() => onItem(item.action)}>
								{body}
							</ContextMenuItem>
						);
					}
					// a disabled item still walks and hovers, and its tooltip
					// states the gate's reason -- matching every other edit
					// surface's disabled-with-reason posture
					return (
						<Tooltip key={item.label}>
							<TooltipTrigger render={<div />}>
								<ContextMenuItem disabled>{body}</ContextMenuItem>
							</TooltipTrigger>
							<TooltipContent side="right">{item.disabled}</TooltipContent>
						</Tooltip>
					);
				})}
			</ContextMenuContent>
		</ContextMenu>
	);
}
