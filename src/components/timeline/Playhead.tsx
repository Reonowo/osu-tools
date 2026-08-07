// the playhead both timeline tiers draw. a zero-width wrapper carries all of
// the movement and the head and the stem hang off it at whole-pixel offsets,
// so the marker rasterises as one unit. each tier used to draw its own copy:
// a 1.5px stem positioned by `left: X%` with a `left-1/2 -translate-x-1/2`
// head nested inside it -- two independent fractional centrings on a
// fractional-percent parent. at the default 20s detail span one replay frame
// is about 1px, which is exactly where that decoheres: the stem flicks
// between 1 and 2 device pixels and the head rounds away from the stem

import type { Ref } from "react";
import { snapDevicePixels } from "@/lib/timeline-view";

/** the transform a tier's rAF loop writes on the wrapper -- the playhead's
 * only per-frame style write. translate3d rather than a `left` offset so the
 * marker is composited instead of re-laid-out on every tick */
export function playheadTransform(offsetPx: number, dpr: number): string {
	return `translate3d(${snapDevicePixels(offsetPx, dpr)}px, 0, 0)`;
}

export function Playhead({ ref }: { ref: Ref<HTMLDivElement> }) {
	return (
		<div ref={ref} className="pointer-events-none absolute inset-y-0 left-0 w-0">
			<div className="absolute inset-y-0 left-[-1px] w-0.5 bg-primary" />
			<div className="absolute top-0 left-[-4px] h-[9px] w-2 rounded-b-[2px] bg-primary" />
		</div>
	);
}
