import { describe, expect, test } from "bun:test";
import type { PlayfieldGridSpacing } from "../state/defaults";
import { playfieldGridGeometry } from "./playfield-grid";
import { PLAYFIELD_HEIGHT, PLAYFIELD_WIDTH } from "./playfield";

/** the four real spacings, off excluded */
const DRAWN: PlayfieldGridSpacing[] = [4, 8, 16, 32];

describe("playfieldGridGeometry", () => {
	test("off draws nothing at all, border included", () => {
		expect(playfieldGridGeometry(0)).toBeNull();
	});

	test("each spacing draws every interior line the rect divides into", () => {
		// the border carries the lines at 0 and at the far edge, so the interior
		// count is one fewer than the divisions per axis
		for (const spacing of DRAWN) {
			const geometry = playfieldGridGeometry(spacing);
			expect(geometry).not.toBeNull();
			expect(geometry!.vertical).toHaveLength(PLAYFIELD_WIDTH / spacing - 1);
			expect(geometry!.horizontal).toHaveLength(PLAYFIELD_HEIGHT / spacing - 1);
		}
	});

	test("the widest spacing lands on the coordinates it says it does", () => {
		const geometry = playfieldGridGeometry(32)!;
		expect(geometry.vertical.slice(0, 3)).toEqual([32, 64, 96]);
		expect(geometry.horizontal.slice(0, 3)).toEqual([32, 64, 96]);
		expect(geometry.vertical.at(-1)).toBe(PLAYFIELD_WIDTH - 32);
		expect(geometry.horizontal.at(-1)).toBe(PLAYFIELD_HEIGHT - 32);
	});

	test("every line sits strictly inside the playfield rect", () => {
		// bounded to the playfield rather than the canvas: the grid doubles as
		// the play area's boundary, which covering the whole canvas would lose
		for (const spacing of DRAWN) {
			const geometry = playfieldGridGeometry(spacing)!;
			for (const x of geometry.vertical) {
				expect(x).toBeGreaterThan(0);
				expect(x).toBeLessThan(PLAYFIELD_WIDTH);
			}
			for (const y of geometry.horizontal) {
				expect(y).toBeGreaterThan(0);
				expect(y).toBeLessThan(PLAYFIELD_HEIGHT);
			}
		}
	});

	test("the border is the playfield rect itself, at every spacing", () => {
		// what makes the play area findable once the leash has let it be panned
		// almost entirely off canvas
		for (const spacing of DRAWN) {
			expect(playfieldGridGeometry(spacing)!.border).toEqual({
				x: 0,
				y: 0,
				width: PLAYFIELD_WIDTH,
				height: PLAYFIELD_HEIGHT
			});
		}
	});
});
