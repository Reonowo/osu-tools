// display formatting only -- no gameplay math lives here

import { PHYSICAL_BUTTONS } from "../engine/buttons";

export function formatTime(ms: number): string {
	const sign = ms < 0 ? "-" : "";
	const abs = Math.abs(ms);
	const minutes = Math.floor(abs / 60_000);
	const seconds = Math.floor((abs % 60_000) / 1000);
	const millis = Math.floor(abs % 1000);
	return `${sign}${minutes}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

// legacy mod flags in display order (legacymods in engine/src/mods.rs)
const MOD_NAMES: [number, string][] = [
	[1, "NF"],
	[2, "EZ"],
	[4, "TD"],
	[8, "HD"],
	[16, "HR"],
	[32, "SD"],
	[64, "DT"],
	[128, "RX"],
	[256, "HT"],
	[512, "NC"],
	[1024, "FL"],
	[2048, "AT"],
	[4096, "SO"],
	[8192, "AP"],
	[16384, "PF"],
	[536_870_912, "SV2"]
];

const KNOWN_MASK = MOD_NAMES.reduce((mask, [bit]) => mask | bit, 0);

export function formatMods(mods: number): string {
	const names = MOD_NAMES.filter(([bit]) => (mods & bit) !== 0).map(([, name]) => name);
	// a nonzero mask must never display as "none": bits outside the table
	// (other rulesets' key mods, future flags) surface as a hex residue
	const unknown = (mods & ~KNOWN_MASK) >>> 0;
	if (unknown !== 0) names.push(`0x${unknown.toString(16)}`);
	return names.length === 0 ? "none" : names.join(" ");
}

export function formatAccuracy(fraction: number): string {
	return `${(fraction * 100).toFixed(2)}%`;
}

/** decoded physical keys, space-joined in K1/K2/M1/M2 order (e.g. "K1 K2");
 * empty when no button is down. FramesPanel's k column -- the raw integer
 * belongs in the row tooltip alongside this, since it is the editing surface */
export function formatButtons(raw: number): string {
	return PHYSICAL_BUTTONS.filter((button) => button.is(raw))
		.map((button) => button.label)
		.join(" ");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** coarse "n units ago" label for the start screen's recents list. clamps a
 * future timestamp (clock skew, an optimistic write) to "just now" rather
 * than printing a negative duration */
export function formatRelativeTime(fromMs: number, nowMs: number): string {
	const elapsed = Math.max(0, nowMs - fromMs);
	if (elapsed < MINUTE_MS) return "just now";
	if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
	if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
	if (elapsed < 2 * DAY_MS) return "yesterday";
	if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)} days ago`;
	if (elapsed < 2 * WEEK_MS) return "last week";
	return `${Math.floor(elapsed / WEEK_MS)} weeks ago`;
}

/** .net ticks (100ns since 0001-01-01) to unix milliseconds. the value
 * exceeds 2^53, so it arrives as a decimal string and is reduced in bigint */
export function ticksToUnixMs(ticks: string): number | null {
	try {
		const value = BigInt(ticks);
		if (value <= 0n) return null;
		return Number(value / 10_000n - 62_135_596_800_000n);
	} catch {
		return null;
	}
}
