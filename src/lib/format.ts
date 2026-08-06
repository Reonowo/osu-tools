// display formatting only -- no gameplay math lives here

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
