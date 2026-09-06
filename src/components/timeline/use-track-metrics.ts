// both timeline tiers do their geometry in css pixels, so that every moving
// offset can be snapped onto the device-pixel grid before it reaches the dom.
// that means each rAF tick needs the track's width -- and reading offsetWidth
// inside the loop would force a layout flush sixty times a second, so the
// width is observed once and parked in a ref the loop can read for free

import { useCallback, useRef, useState, type RefObject } from "react";

export interface TrackMetrics {
	/** attach to the track element. a ref callback rather than a ref object so
	 * the observer follows the element itself: a tier that returns null on its
	 * first render (OverviewStrip, before its scene has derived) would leave a
	 * mount-time effect looking at an element that did not exist yet */
	attach: (element: HTMLElement | null) => void;
	/** the attached element, for the geometry reads outside the rAF loops */
	element: RefObject<HTMLElement | null>;
	/** its observed css width. a ref rather than state: only the rAF loops read
	 * it, and a resize must not re-render the tier */
	widthPx: RefObject<number>;
}

export function useTrackMetrics(): TrackMetrics {
	const element = useRef<HTMLElement | null>(null);
	const widthPx = useRef(0);
	const observerRef = useRef<ResizeObserver | null>(null);

	const attach = useCallback((next: HTMLElement | null) => {
		element.current = next;
		observerRef.current?.disconnect();
		if (next === null) return;
		// measured here and not left to the observer: its first callback only
		// lands after the first paint, and a zero width until then would collapse
		// the detail tier's lane layer, which is sized from this
		widthPx.current = next.getBoundingClientRect().width;
		observerRef.current ??= new ResizeObserver((entries) => {
			widthPx.current = entries[0].contentRect.width;
		});
		observerRef.current.observe(next);
	}, []);

	return { attach, element, widthPx };
}

/** the same observed width as react STATE, for a layer that is rebuilt when
 * the track resizes rather than read every frame. deliberately separate from
 * `useTrackMetrics`: putting the width in state there would re-render both
 * tiers on every resize tick, and the rAF loops that read `widthPx` want it
 * free of react entirely. compose the two ref callbacks on the same element */
export interface ObservedWidth {
	observe: (element: HTMLElement | null) => void;
	/** css pixels; `0` until the element exists */
	width: number;
}

export function useObservedWidth(): ObservedWidth {
	const [width, setWidth] = useState(0);
	const observerRef = useRef<ResizeObserver | null>(null);

	const observe = useCallback((next: HTMLElement | null) => {
		observerRef.current?.disconnect();
		if (next === null) return;
		// measured here for the same reason useTrackMetrics does: the
		// observer's first callback only lands after the first paint
		setWidth(next.getBoundingClientRect().width);
		observerRef.current ??= new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
		observerRef.current.observe(next);
	}, []);

	return { observe, width };
}
