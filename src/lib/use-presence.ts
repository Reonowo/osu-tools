// the thin hook over lib/presence.ts: it reads the shell row's effective
// motion flag off the store, feeds the reducer the open flag beside it, and
// hands back what a region needs to render itself -- whether to mount, and
// the transitionend handler that ends an exit.
//
// the handler is filtered twice: on the driving PROPERTY, so a wrapper that
// transitions two things does not unmount on the wrong one, and on the
// ELEMENT, so a bubbling child's transition never speaks for its parent. the
// property is the caller's, because one region's exit is driven by its width
// and another's by its opacity. the filter itself lives beside the reducer
// (isDrivingTransitionEnd), where it is pinned without a dom

import { useState, type TransitionEvent } from "react";
import { selectShellMotion } from "@/lib/motion";
import {
	initialPresence,
	isDrivingTransitionEnd,
	presenceInert,
	presenceMounted,
	presenceStep,
	type PresenceState
} from "@/lib/presence";
import { useViewerStore } from "@/state/store";

export interface Presence {
	/** render the region's body at all */
	mounted: boolean;
	/** the body is on its way out: inert, and holding its last reading */
	exiting: boolean;
	/** goes on the element that carries the transition -- the same element the
	 * driving property is declared on */
	onTransitionEnd: (event: TransitionEvent<Element>) => void;
}

export function useShellPresence(open: boolean, drivingProperty: string): Presence {
	const motion = useViewerStore(selectShellMotion);
	const [state, setState] = useState<PresenceState>(() => initialPresence(open));
	// react's own "adjust state while rendering when an input changes" pattern
	// rather than an effect: an effect would leave one committed frame where a
	// just-opened region is still unmounted while its wrapper is already sliding
	const [seen, setSeen] = useState({ open, motion });
	if (seen.open !== open || seen.motion !== motion) {
		setSeen({ open, motion });
		setState(presenceStep(state, { kind: "inputs", open, motion }));
	}

	return {
		mounted: presenceMounted(state),
		exiting: presenceInert(state),
		onTransitionEnd: (event) => {
			if (!isDrivingTransitionEnd(event, drivingProperty)) return;
			setState((current) => presenceStep(current, { kind: "exitEnded" }));
		}
	};
}
