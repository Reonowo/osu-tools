// the playfield grid's geometry: the interior line coordinates and the
// playfield's own border for a given spacing. pure math, no pixi imports --
// the drawing half is one renderer-lifetime Graphics in GameplayRenderer.
//
// the playfield grid is a ruler and nothing else. it snaps nothing, ever:
// snapping belongs to the lattice (lib/lattice.ts), which is what keeps an
// edit forensically plausible, and a second thing to snap to would undermine
// it

import type { PlayfieldGridSpacing } from "../state/defaults";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "./playfield";

export interface PlayfieldGridGeometry {
	/** x of each interior vertical line, ascending */
	vertical: number[];
	/** y of each interior horizontal line, ascending */
	horizontal: number[];
	/** the playfield rect, drawn heavier than the lines inside it */
	border: { x: number; y: number; width: number; height: number };
}

/** the lines for `spacing`, bounded to the 512x384 playfield rect; null when
 * off. centre-anchored and origin-anchored grids coincide for all four
 * spacings (512 and 384 are integer multiples of each), so there is no
 * anchoring choice to make */
export function playfieldGridGeometry(spacing: PlayfieldGridSpacing): PlayfieldGridGeometry | null {
	if (spacing === 0) return null;
	// the divisions at 0 and at the far edge are the border's own sides, so
	// the interior starts one step in and stops one step short
	const vertical: number[] = [];
	for (let x = spacing; x < PLAYFIELD_WIDTH; x += spacing) vertical.push(x);
	const horizontal: number[] = [];
	for (let y = spacing; y < PLAYFIELD_HEIGHT; y += spacing) horizontal.push(y);
	return { vertical, horizontal, border: { x: 0, y: 0, width: PLAYFIELD_WIDTH, height: PLAYFIELD_HEIGHT } };
}
