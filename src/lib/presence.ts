// the one piece of JS in the chrome-transition mechanism (docs/adr/0010): the
// state machine that keeps an EXITING shell region mounted until its exit
// transition ends, marks it inert for the duration so it can take neither
// focus nor a click, and then unmounts it.
//
// pure and injected, like lib/combo.ts and the space-pan module: three
// states, two signals, no dom and no store. use-presence.ts is the thin hook
// that wires it to a real element's transitionend and to the shell row's fold.
//
// THE ZERO-DURATION REASON, which is the whole shape of this module. the
// master's rule in index.css zeroes DURATIONS rather than removing
// animations, because base-ui's popups wait on animationend to unmount and a
// zero-duration animation still fires it on the next frame. a zero-duration
// TRANSITION fires nothing at all. so a region cannot wait for its exit to
// end when motion is off -- it has to read the flag and unmount at once,
// which is why `motion` is an input here rather than something the dom
// reports.
//
// the enter side needs none of this. a shell region's transition is carried
// by a wrapper that is always mounted, so there is nothing to transition from
// on the shell's first paint and a region already open when the shell mounts
// appears in place -- enter motion belongs to a CHANGE, never to first paint

/** unmounted: not in the dom. entered: in the dom and interactive. exiting:
 * still in the dom, still painting its exit, and inert */
export type PresenceState = "unmounted" | "entered" | "exiting";

/** what moves the machine. `inputs` is the open flag and the row's effective
 * motion flag, reported together because a close decides between exiting and
 * unmounting by reading both; `exitEnded` is the driving property's
 * transitionend, already filtered to this element and this property */
export type PresenceSignal = { kind: "inputs"; open: boolean; motion: boolean } | { kind: "exitEnded" };

/** where a region starts. a region open at first paint starts ENTERED, so
 * nothing about it is a change and nothing about it moves */
export function initialPresence(open: boolean): PresenceState {
	return open ? "entered" : "unmounted";
}

export function presenceStep(state: PresenceState, signal: PresenceSignal): PresenceState {
	if (signal.kind === "exitEnded") {
		// only an exit can be ended. a transitionend arriving in any other state
		// is a stray -- a neighbouring property finishing, or the enter's own
		// end -- and unmounting a live region on one would be the worst
		// available bug
		return state === "exiting" ? "unmounted" : state;
	}
	if (signal.open) {
		// a reopen during an exit returns to entered WITHOUT passing through
		// unmounted: the region never leaves the dom, so the transition it is
		// in the middle of retargets from where it is rather than restarting
		return "entered";
	}
	if (state === "unmounted") return "unmounted";
	// closing with motion off, by master, by row, or by the OS flipping under
	// `system`: unmount now, because no end event is coming (see the header)
	if (!signal.motion) return "unmounted";
	return "exiting";
}

/** whether the region is in the dom at all */
export function presenceMounted(state: PresenceState): boolean {
	return state !== "unmounted";
}

/** whether the region is `inert`: on its way out, so a tab must not land in
 * it and a click meant for what is behind it must not be eaten by it */
export function presenceInert(state: PresenceState): boolean {
	return state === "exiting";
}

/** a transitionend reduced to what the filter reads, so this module stays
 * dom-free and the filter can be pinned with plain objects standing in for
 * elements, the way shortcut-guards.test.ts pins its walks */
export interface TransitionEndLike {
	target: unknown;
	currentTarget: unknown;
	propertyName: string;
}

/** whether a transitionend is the one that ends this region's exit. two
 * filters, and both are load-bearing: it must be the element's OWN, never a
 * bubbling child's -- a tooltip fading inside a sliding panel, the key
 * tile's press inside the HUD's fade -- and it must be the DRIVING property,
 * never a neighbour finishing on the same element, since the panel's body
 * fade ends half a slide before its width does. either miss would unmount a
 * live region mid-motion, which is the worst available bug */
export function isDrivingTransitionEnd(event: TransitionEndLike, drivingProperty: string): boolean {
	return event.target === event.currentTarget && event.propertyName === drivingProperty;
}
