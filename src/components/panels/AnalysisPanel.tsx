// the analysis tab's panel body: hit-timing stat cards, the error
// histogram, the cursor velocity trace, and the frame-stream stat list.
// header + scrolling body together, so SidePanel can mount this as a single
// self-contained panel

import { Check, Minus, X } from "lucide-react";
import type { ReactNode } from "react";
import { PanelHeader } from "@/components/shell/SidePanel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ERROR_WINDOW_MS, HISTOGRAM_BINS, type HistogramBin, type VelocitySample } from "@/lib/analysis";
import { formatTime } from "@/lib/format";
import {
	crossCheckConsistent,
	describeCrossCheck,
	incompletenessNote,
	integrityRowLabel,
	integrityRowValue,
	lifeBarNote,
	rowVerdict
} from "@/lib/integrity";
import { formatLatticeStep, type Lattice, type OffLatticeSummary } from "@/lib/lattice";
import type { Incompleteness, IntegrityReport } from "@/lib/scene-types";
import { useViewerStore } from "@/state/store";
import { SectionLabel } from "./SectionLabel";

// real minus (u2212), not a hyphen -- the design's chosen glyph for signed values
const MINUS = "−";

function signedMs(value: number): string {
	const sign = value < 0 ? MINUS : "";
	return `${sign}${Math.abs(value).toFixed(1)}`;
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
			<SectionLabel>{label}</SectionLabel>
			{children}
		</div>
	);
}

function StatRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="contents">
			<dt className="text-[#8a8a93]">{label}</dt>
			<dd className="text-right text-[#e4e4e7] tabular-nums">{value}</dd>
		</div>
	);
}

// stands in for the two stat cards and the histogram together rather than
// letting either render a zero that would misrepresent the play
function TimingEmptyState({ reason }: { reason: string }) {
	return (
		<div className="rounded-[9px] border border-border bg-surface-card px-3 py-7 text-center text-[11px] text-[#8a8a93]">
			{reason}
		</div>
	);
}

function Histogram({
	histogram,
	greatWindow,
	earlyFraction,
	lateFraction,
	stdDev
}: {
	histogram: readonly HistogramBin[];
	greatWindow: number;
	earlyFraction: number;
	lateFraction: number;
	stdDev: number;
}) {
	const maxCount = histogram.reduce((max, bin) => Math.max(max, bin.count), 0);
	return (
		<div>
			<SectionLabel>hit error distribution</SectionLabel>
			{/* a grid, not flex: `flex-1` shares out the leftover space, so with a
			fractional 1.5px gap each bar's own width lands on a different
			subpixel and the row rasterises as an irregular comb. equal grid
			tracks and a whole-pixel gap make every bar and gap identical. the
			column count comes from HISTOGRAM_BINS rather than a literal, so the
			two cannot drift apart -- tailwind cannot generate a class from a
			runtime value, hence the inline gridTemplateColumns */}
			<div
				className="mt-[7px] grid h-[74px] items-end gap-[2px]"
				style={{ gridTemplateColumns: `repeat(${HISTOGRAM_BINS}, minmax(0, 1fr))` }}
			>
				{histogram.map((bin) => {
					// an all-zero histogram must not divide by a zero max into NaN heights
					const share = maxCount === 0 ? 0 : bin.count / maxCount;
					const insideGreat = Math.abs(bin.centre) <= greatWindow;
					return (
						<div
							key={bin.centre}
							className="rounded-t-[1.5px]"
							style={{
								height: `${Math.max(2, share * 72)}px`,
								backgroundColor: insideGreat ? "#66ccff" : "#88b300"
							}}
						/>
					);
				})}
			</div>
			<div className="mt-1 flex justify-between font-mono text-[9px] text-[#8a8a93]">
				<span>
					{MINUS}
					{ERROR_WINDOW_MS}ms
				</span>
				<span>0</span>
				<span>+{ERROR_WINDOW_MS}ms</span>
			</div>
			<div className="mt-1.5 text-[11px] text-[#a1a1aa] tabular-nums">
				early {Math.round(earlyFraction * 100)}% · late {Math.round(lateFraction * 100)}% · σ{" "}
				{stdDev.toFixed(1)}ms
			</div>
		</div>
	);
}

// the loaded file's header-vs-simulated comparison. rendered only when the
// scene shipped a report (pre-lazer authoritative scenes), so an
// inapplicable rules profile never raises false mismatch alarms. the report
// describes the loaded file across every in-session edit. an incomplete
// play keeps its rows but drops the verdict treatment: the header stops at
// the fail point while simulation judges the whole map, so a differing row
// is expected context there, never an accusation
function IntegritySection({
	report,
	incompleteness
}: {
	report: IntegrityReport;
	incompleteness: Incompleteness | null;
}) {
	const incomplete = incompleteness !== null;
	const consistent = crossCheckConsistent(report.crossCheck, incompleteness);
	return (
		<div>
			<SectionLabel>integrity</SectionLabel>
			<div className="mt-[7px] rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
				{incomplete && (
					<p className="mb-2.5 border-b border-border pb-2 text-[10.5px] leading-[1.55] text-[#fbbf24]">
						{incompletenessNote(incompleteness)}
					</p>
				)}
				<div className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-x-3 gap-y-[6px] text-[11px]">
					<span />
					<span className="text-right text-[9.5px] uppercase tracking-[0.08em] text-[#8a8a93]">header</span>
					<span className="text-right text-[9.5px] uppercase tracking-[0.08em] text-[#8a8a93]">
						simulated
					</span>
					<span />
					{report.rows.map((row) => {
						const verdict = rowVerdict(row, incompleteness);
						return (
							<div key={row.field} className="contents">
								<span className="text-[#8a8a93]">{integrityRowLabel(row.field)}</span>
								<span
									className={`text-right tabular-nums ${
										verdict === "differs" ? "text-destructive" : "text-[#e4e4e7]"
									}`}
								>
									{integrityRowValue(row.field, row.header)}
								</span>
								<span className="text-right tabular-nums text-[#e4e4e7]">
									{integrityRowValue(row.field, row.simulated)}
								</span>
								{verdict === "match" ? (
									<Check className="size-3 shrink-0 text-[#88b300]" aria-label="matches" />
								) : verdict === "expected" ? (
									<Minus
										className="size-3 shrink-0 text-[#8a8a93]"
										aria-label="differs (play ended early)"
									/>
								) : (
									<X className="size-3 shrink-0 text-destructive" aria-label="differs" />
								)}
							</div>
						);
					})}
				</div>
				<div
					className={`mt-2.5 border-t border-border pt-2 text-[10.5px] leading-[1.5] tabular-nums ${
						consistent ? "text-[#8a8a93]" : "text-destructive"
					}`}
				>
					{describeCrossCheck(report.crossCheck)}
				</div>
				<div className="mt-1 text-[10.5px] text-[#8a8a93]">{lifeBarNote(report.lifeBarPresent)}</div>
			</div>
		</div>
	);
}

// the off-lattice run summary: shown for any scene with an inferred lattice
// -- this forensic signal needs no simulation, so NotSimulated and
// lazer-native scenes get it too. a failed inference reads as unanalysable,
// never as clean
function OffLatticeSection({ lattice, summary }: { lattice: Lattice | null; summary: OffLatticeSummary | null }) {
	return (
		<div>
			<SectionLabel>input lattice</SectionLabel>
			<div className="mt-[7px] rounded-[9px] border border-border bg-surface-card px-3 py-[9px] text-[11px]">
				{lattice === null || summary === null ? (
					<p className="text-[#8a8a93]">
						no lattice inferred — the coordinates fit no known fullscreen quantisation (windowed play), so
						off-lattice analysis is unavailable
					</p>
				) : summary.runCount === 0 ? (
					<p className="text-[#8a8a93]">
						every frame sits on the {formatLatticeStep(lattice)} lattice — no interpolated or synthesized
						input detected
					</p>
				) : (
					<>
						<div className="text-[#e4e4e7] tabular-nums">
							{summary.runCount.toLocaleString()} off-lattice {summary.runCount === 1 ? "run" : "runs"} ·{" "}
							{summary.offLatticeFrames.toLocaleString()}{" "}
							{summary.offLatticeFrames === 1 ? "frame" : "frames"} off the {formatLatticeStep(lattice)}{" "}
							lattice
						</div>
						<div className="mt-1.5 flex flex-col gap-[3px] font-mono text-[10px] text-[#a1a1aa]">
							{summary.longestRuns.map((run) => (
								<div key={run.startIndex} className="tabular-nums">
									frames {run.startIndex.toLocaleString()}–{run.endIndex.toLocaleString()} ·{" "}
									{formatTime(run.startTime)}–{formatTime(run.endTime)} ·{" "}
									{(run.endIndex - run.startIndex + 1).toLocaleString()} long
								</div>
							))}
						</div>
						{summary.runCount > summary.longestRuns.length && (
							<div className="mt-1 text-[10px] text-[#8a8a93]">
								showing the {summary.longestRuns.length} longest of {summary.runCount.toLocaleString()}{" "}
								runs
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}

// x = the sample's share of the trace width, y = its velocity's share of the
// trace's own peak. both shares are guarded: a single-sample trace would
// divide by a zero index range, and a motionless replay's peak is zero --
// either unguarded would put NaN into the points attribute and silently
// blank the whole polyline/polygon
function velocityPoints(samples: readonly VelocitySample[], peak: number): string | null {
	if (samples.length === 0 || peak <= 0) return null;
	const lastIndex = Math.max(1, samples.length - 1);
	return samples
		.map((sample, i) => {
			const x = (i / lastIndex) * 600;
			const y = 40 - Math.min(1, Math.max(0, sample.velocity / peak)) * 38.5;
			return `${x.toFixed(2)},${y.toFixed(2)}`;
		})
		.join(" ");
}

function VelocityChart({
	velocity,
	peakVelocity,
	meanVelocity
}: {
	velocity: readonly VelocitySample[];
	peakVelocity: number;
	meanVelocity: number;
}) {
	const points = velocityPoints(velocity, peakVelocity);
	return (
		<div>
			<SectionLabel>cursor velocity</SectionLabel>
			<div className="mt-[7px] rounded-[9px] border border-border bg-surface-card p-2">
				<svg viewBox="0 0 600 40" preserveAspectRatio="none" className="h-10 w-full">
					{points !== null && (
						<>
							<polygon points={`0,40 ${points} 600,40`} fill="#eb4791" fillOpacity={0.14} />
							<polyline points={points} fill="none" stroke="#eb4791" strokeWidth={1.6} />
						</>
					)}
				</svg>
			</div>
			<div className="mt-1.5 text-[11px] text-[#a1a1aa] tabular-nums">
				avg {Math.round(meanVelocity)} px/s · peak {Math.round(peakVelocity)}
			</div>
		</div>
	);
}

export function AnalysisPanel() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const editor = useViewerStore((s) => s.editor);
	if (scene === null || derived === null) return null;
	const { analysis } = derived;
	const { simulation } = scene;
	const authoritative = simulation.status === "authoritative";
	// judgedTime (analysis.ts) returns null for a miss -- it carries no press
	// to measure an error against -- so an authoritative simulation can still
	// finish with zero countable hit errors (a miss-only play, or a map with
	// no circle/slider-head objects at all). gate the timing half on both
	// conditions together, or a miss-only replay renders a fabricated 0.00 UR
	// and a histogram of floored bars instead of admitting there's nothing to
	// measure
	const hasTimedHits = authoritative && analysis.errors.length > 0;

	// totals only exist on the authoritative variant -- an absent trailing is
	// the honest header for a replay whose judgements were never simulated
	const judgedTrailing =
		simulation.status === "authoritative"
			? `${(
					simulation.totals.count300 +
					simulation.totals.count100 +
					simulation.totals.count50 +
					simulation.totals.countMiss
				).toLocaleString()} judged`
			: undefined;

	return (
		<>
			<PanelHeader title="analysis" trailing={judgedTrailing} />
			<div
				data-native-wheel=""
				className="flex min-w-0 flex-1 flex-col gap-3.5 overflow-y-auto overflow-x-hidden p-3.5"
			>
				{hasTimedHits ? (
					<>
						<div className="grid grid-cols-2 gap-2">
							{/* the card spells the metric out, but "unstable rate" still
							doesn't say what the number measures. a div wrapper rather
							than a span: StatCard is a block and this is the grid item */}
							<Tooltip>
								<TooltipTrigger render={<div />}>
									<StatCard label="unstable rate">
										<div className="text-[22px] font-bold tabular-nums text-[#f4f4f5]">
											{analysis.unstableRate.toFixed(2)}
										</div>
									</StatCard>
								</TooltipTrigger>
								<TooltipContent>
									UR — ten times the standard deviation of this play's hit errors. lower is steadier;
									it says nothing about whether the taps were early or late.
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger render={<div />}>
									<StatCard label="mean error">
										<div
											className="text-[22px] font-bold tabular-nums"
											style={{ color: "#66ccff" }}
										>
											{signedMs(analysis.meanError)}
											<span className="text-[12px] text-[#8a8a93]">ms</span>
										</div>
									</StatCard>
								</TooltipTrigger>
								<TooltipContent>
									the average signed hit error: negative is early, positive is late
								</TooltipContent>
							</Tooltip>
						</div>
						<Histogram
							histogram={analysis.histogram}
							greatWindow={scene.renderPlan.hitWindows.great}
							earlyFraction={analysis.earlyFraction}
							lateFraction={analysis.lateFraction}
							stdDev={analysis.stdDev}
						/>
					</>
				) : (
					<TimingEmptyState
						reason={
							authoritative
								? "no timed hits to measure in this replay"
								: "judgements are not simulated for this replay"
						}
					/>
				)}

				<VelocityChart
					velocity={analysis.velocity}
					peakVelocity={analysis.peakVelocity}
					meanVelocity={analysis.meanVelocity}
				/>

				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-[7px] text-[11px]">
					<StatRow label="peak tap rate" value={`${Math.round(analysis.peakTapBpm)} bpm`} />
					<StatRow label="mean hold" value={`${Math.round(analysis.meanHoldMs)}ms`} />
					<StatRow label="frames" value={analysis.frameCount.toLocaleString()} />
					<StatRow label="median Δt" value={`${analysis.medianDeltaMs.toFixed(1)}ms`} />
				</dl>

				{scene.integrity !== null && (
					<IntegritySection report={scene.integrity} incompleteness={scene.incompleteness} />
				)}

				<OffLatticeSection lattice={editor?.lattice ?? null} summary={editor?.offLattice ?? null} />
			</div>
		</>
	);
}
