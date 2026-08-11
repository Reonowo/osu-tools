// raw .osr button bitfield (legacyreplayframe.cs); k1/k2 are the keyboard
// bits, m1/m2 the mouse bits, and stable sets m alongside k historically

export const M1 = 1;
export const M2 = 2;
export const K1 = 4;
export const K2 = 8;
export const SMOKE = 16;

/** legacyreplayframe.cs -- mouseleft is m1 or k1: one gameplay action */
export function isLeft(raw: number): boolean {
	return (raw & (M1 | K1)) !== 0;
}

export function isRight(raw: number): boolean {
	return (raw & (M2 | K2)) !== 0;
}

export function isSmoke(raw: number): boolean {
	return (raw & SMOKE) !== 0;
}

// physical-key decoding, for presentation only -- gameplay/simulation stays
// on isLeft/isRight above, unchanged. lazer has no k/m concept at all
// (mouseleft/mouseright already collapse both bits into one gameplay action,
// as above); this divergence is recorded in todo.md. osureplayeditor
// api.cs:249: "m1 = 1, m2 = 2, k1 = 4, k2 = 8, smoke = 16 (k1 is always used
// with m1; k2 is always used with m2: 1+4=5; 2+8=10)" -- k1/k2 are
// keyboard-provenance flags, not independent buttons, so a keyboard tap's
// raw value already carries its paired mouse bit and isM1/isM2 must read
// that as the keyboard key alone, not both keys down at once
export function isK1(raw: number): boolean {
	return (raw & K1) !== 0;
}

export function isM1(raw: number): boolean {
	return (raw & M1) !== 0 && (raw & K1) === 0;
}

export function isK2(raw: number): boolean {
	return (raw & K2) !== 0;
}

export function isM2(raw: number): boolean {
	return (raw & M2) !== 0 && (raw & K2) === 0;
}

export type PhysicalKey = "K1" | "K2" | "M1" | "M2";

export interface PhysicalButton {
	/** the display label, and the value pressEdges' Press.key reports */
	label: PhysicalKey;
	/** lowercase form -- the key into ButtonEdges and DetailLanes' hold-lane maps */
	edgesKey: "k1" | "k2" | "m1" | "m2";
	is: (raw: number) => boolean;
}

/** the single source of the K1/K2/M1/M2 list -- every presentation call site
 * that needs "all four physical keys" iterates this instead of re-deriving
 * the list or re-hardcoding the raw bit values */
export const PHYSICAL_BUTTONS: readonly PhysicalButton[] = [
	{ label: "K1", edgesKey: "k1", is: isK1 },
	{ label: "K2", edgesKey: "k2", is: isK2 },
	{ label: "M1", edgesKey: "m1", is: isM1 },
	{ label: "M2", edgesKey: "m2", is: isM2 }
];

const BY_LABEL = Object.fromEntries(PHYSICAL_BUTTONS.map((button) => [button.label, button])) as Record<
	PhysicalKey,
	PhysicalButton
>;

/** lookup by label -- press editing resolves its (key, run) identities
 * through this instead of re-deriving the predicate per call site */
export function physicalButton(key: PhysicalKey): PhysicalButton {
	return BY_LABEL[key];
}
