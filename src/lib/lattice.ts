// input-lattice inference. genuine client input is quantised -- integer screen
// pixels divided by the playfield scale -- so every coordinate is a multiple
// of 1/scale osu!px. stable's scale is screenHeight * 0.8 / 384, and the
// common resolutions land on clean rationals (1080p fullscreen -> 2.25 ->
// 4/9 px). interpolated or synthesised frames miss the lattice, which is the
// signal TODO.md's export-integrity item is built on

import type { FrameDto } from "./scene-types";

export interface Lattice {
	/** playfield scale the frames were recorded at */
	scale: number;
	/** the quantisation step in osu!px, i.e. 1 / scale */
	step: number;
	/** fraction of sampled coordinates landing on the lattice, 0-1 */
	conformance: number;
}

/** frames are stored as float32 in the .osr, so a multiple of the step comes
 * back with up to a few ulp of error; this tolerance is well inside half a
 * step for every candidate scale below */
const TOLERANCE = 1e-3;

/** the scale a fullscreen client produces at each common screen height,
 * screenHeight * 0.8 / 384. windowed play lands between these, which is why a
 * failed inference is a legitimate result rather than an error */
const CANDIDATE_SCALES = [
	1, // 480p
	1.125, // 540p
	1.25, // 600p
	1.5, // 720p
	1.6875, // 810p
	1.875, // 900p
	2, // 960p
	2.25, // 1080p
	2.5, // 1200p
	3, // 1440p
	4.5 // 2160p
];

/** frames sampled before deciding; enough to be decisive without walking a
 * 100k-frame stream eleven times, once per CANDIDATE_SCALES entry */
const SAMPLE_LIMIT = 4000;
/** a candidate must explain at least this share of sampled coordinates */
const MIN_CONFORMANCE = 0.9;
const MIN_FRAMES = 32;

/** why lattice operations are unavailable when inference found nothing --
 * the one wording every surface prints (the frames panel's tooltip and
 * footer, the context menu's snap item), kept here so they cannot drift */
export const NO_LATTICE_REASON = "no input lattice could be inferred from these frames";

export function isOnLattice(value: number, step: number): boolean {
	const multiples = value / step;
	return Math.abs(multiples - Math.round(multiples)) <= TOLERANCE;
}

export function inferLattice(frames: readonly FrameDto[]): Lattice | null {
	if (frames.length < MIN_FRAMES) return null;
	const stride = Math.max(1, Math.floor(frames.length / SAMPLE_LIMIT));

	let best: Lattice | null = null;
	for (const scale of CANDIDATE_SCALES) {
		const step = 1 / scale;
		let hits = 0;
		let total = 0;
		for (let i = 0; i < frames.length; i += stride) {
			const frame = frames[i];
			if (isOnLattice(frame.x, step)) hits += 1;
			if (isOnLattice(frame.y, step)) hits += 1;
			total += 2;
		}
		const conformance = hits / total;
		if (conformance < MIN_CONFORMANCE) continue;
		// the coarsest scale that still explains the frames wins: every lattice
		// is a subset of each finer one, so scanning coarse-to-fine and keeping
		// the first acceptable candidate names the real recording resolution
		best = { scale, step, conformance };
		break;
	}
	return best;
}

/** one maximal contiguous span of off-lattice frames -- the forensic
 * signature of interpolated or synthesized input. indices inclusive */
export interface OffLatticeRun {
	startIndex: number;
	endIndex: number;
	startTime: number;
	endTime: number;
}

export interface OffLatticeSummary {
	/** every run, counted exactly even when the stored list is capped */
	runCount: number;
	/** total off-lattice frames across all runs, exact */
	offLatticeFrames: number;
	/** the longest runs (ties broken earlier-first), capped at
	 * MAX_SUMMARY_RUNS so a hostile alternating stream cannot balloon the
	 * summary; counts above stay exact regardless */
	longestRuns: OffLatticeRun[];
}

export const MAX_SUMMARY_RUNS = 8;

/** a frame is off-lattice when either axis fails the on-lattice predicate at
 * its usual tolerance; a run is a maximal contiguous index range with no gap
 * tolerance and no minimum length. computed once at scene install next to
 * the frozen lattice, never per edit; a null lattice yields null (windowed
 * play reads as unanalysable, never as clean) */
export function summarizeOffLattice(frames: readonly FrameDto[], lattice: Lattice | null): OffLatticeSummary | null {
	if (lattice === null) return null;
	const { step } = lattice;

	const summary: OffLatticeSummary = { runCount: 0, offLatticeFrames: 0, longestRuns: [] };
	const runLength = (run: OffLatticeRun) => run.endIndex - run.startIndex + 1;
	const closeRun = (startIndex: number, endIndex: number) => {
		summary.runCount += 1;
		summary.offLatticeFrames += endIndex - startIndex + 1;
		summary.longestRuns.push({
			startIndex,
			endIndex,
			startTime: frames[startIndex].time,
			endTime: frames[endIndex].time
		});
		summary.longestRuns.sort((a, b) => runLength(b) - runLength(a) || a.startIndex - b.startIndex);
		if (summary.longestRuns.length > MAX_SUMMARY_RUNS) summary.longestRuns.length = MAX_SUMMARY_RUNS;
	};

	let runStart = -1;
	for (let i = 0; i <= frames.length; i += 1) {
		const frame = frames[i];
		const off = frame !== undefined && (!isOnLattice(frame.x, step) || !isOnLattice(frame.y, step));
		if (off && runStart === -1) {
			runStart = i;
		} else if (!off && runStart !== -1) {
			closeRun(runStart, i - 1);
			runStart = -1;
		}
	}
	return summary;
}

/** greatest common divisor of two positive integers */
function gcd(a: number, b: number): number {
	while (b !== 0) [a, b] = [b, a % b];
	return a;
}

/** names the step as the rational it is ("4/9 px"), since that is how the
 * quantisation is actually reasoned about */
export function formatLatticeStep(lattice: Lattice): string {
	// every candidate scale is a multiple of 1/16, so a 16x numerator is exact
	const numerator = 16;
	const denominator = Math.round(lattice.scale * 16);
	const divisor = gcd(numerator, denominator);
	const top = numerator / divisor;
	const bottom = denominator / divisor;
	return bottom === 1 ? `${top} px` : `${top}/${bottom} px`;
}
