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
import { describeFailPoint } from "@/lib/hp";
import {
	crossCheckConsistent,
	describeCrossCheck,
	headerFailNote,
	incompletenessNote,
	blockNote,
	integrityRowLabel,
	integrityRowValue,
	lifeBarGraphNote,
	rowVerdict
} from "@/lib/integrity";
import { describeDrops, type DerivedHp } from "@/lib/derive";
import { formatLatticeStep, type Lattice, type OffLatticeSummary } from "@/lib/lattice";
import type { Incompleteness, IntegrityReport } from "@/lib/scene-types";
import { useViewerStore } from "@/state/store";
import { simulated } from "@/lib/simulation";
import { SectionLabel } from "./SectionLabel";

// real minus (u2212), not a hyphen -- the design's chosen glyph for signed values
const MINUS = "−";

function signedMs(value: number): string {
	const sign = value < 0 ? MINUS : "";
	return `${sign}${Math.abs(value).toFixed(1)}`;
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="card">
			<SectionLabel>{label}</SectionLabel>
			{children}
		</div>
	);
}

function StatRow({ label, value }: { label: string; value: string }) {
	return (
		<div className="contents">
			<dt className="text-muted-foreground">{label}</dt>
			<dd className="text-right text-foreground tabular-nums">{value}</dd>
		</div>
	);
}

// stands in for the two stat cards and the histogram together rather than
// letting either render a zero that would misrepresent the play
function TimingEmptyState({ reason }: { reason: string }) {
	return (
		<div className="rounded-card border border-border bg-surface-card px-3 py-7 text-center text-row text-muted-foreground">
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
				className="mt-stack grid h-histogram items-end gap-micro"
				style={{ gridTemplateColumns: `repeat(${HISTOGRAM_BINS}, minmax(0, 1fr))` }}
			>
				{histogram.map((bin) => {
					// an all-zero histogram must not divide by a zero max into NaN heights
					const share = maxCount === 0 ? 0 : bin.count / maxCount;
					const insideGreat = Math.abs(bin.centre) <= greatWindow;
					return (
						<div
							key={bin.centre}
							className="rounded-t-mark-tip"
							style={{
								height: `${Math.max(2, share * 72)}px`,
								backgroundColor: insideGreat ? "var(--grade-great)" : "var(--grade-ok)"
							}}
						/>
					);
				})}
			</div>
			<div className="mt-1 flex justify-between font-mono text-micro text-muted-foreground">
				<span>
					{MINUS}
					{ERROR_WINDOW_MS}ms
				</span>
				<span>0</span>
				<span>+{ERROR_WINDOW_MS}ms</span>
			</div>
			<div className="mt-1.5 text-row text-foreground-soft tabular-nums">
				early {Math.round(earlyFraction * 100)}% · late {Math.round(lateFraction * 100)}% · σ{" "}
				{stdDev.toFixed(1)}ms
			</div>
		</div>
	);
}

// the play's HP: the lowest the CURRENT document reached, and the fail
// point -- the first millisecond its HP hit zero, which is where stable would
// have ended the play. this viewer keeps simulating past it and marks it
// instead (`CONTEXT.md`'s fail point), so the row states it rather than
// truncating anything, and says whether the loaded file's own header agrees.
//
// nothing is re-derived here: the curve, the lowest point and the fail point
// all come off derive.ts, which re-runs on every landed edit. the lowest-HP
// row is a readout and deliberately not a seek target -- HP is a continuous
// quantity, and its minimum is a moment to read rather than a mark to visit
function HpSection({ hp, report }: { hp: DerivedHp; report: IntegrityReport | null }) {
	const lowest =
		hp.lowest === null ? "—" : `${Math.round(hp.lowest.fraction * 100)}% at ${formatTime(hp.lowest.time)}`;
	return (
		<div>
			<SectionLabel>hp</SectionLabel>
			<div className="mt-stack card">
				<dl className="grid dl-grid gap-x-3 gap-y-stack text-row">
					<StatRow label="lowest HP" value={lowest} />
					<StatRow
						label="fail point"
						value={describeFailPoint(
							hp.curve.length > 0,
							hp.failPoint === null ? null : formatTime(hp.failPoint)
						)}
					/>
				</dl>
				<div className="mt-2.5 border-t border-border pt-2 text-caption-tight text-muted-foreground">
					{headerFailNote(report)}
				</div>
			</div>
		</div>
	);
}

// the loaded file's own record against the simulation -- the header under the
// stable profile, the score-info block under the native one. rendered only
// when the scene shipped a report (an authoritative scene whose profile has
// an oracle), so an inapplicable rules profile never raises false mismatch
// alarms. the report
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
			<div className="mt-stack card">
				{incomplete && (
					<p className="mb-2.5 border-b border-border pb-2 text-caption text-warning">
						{incompletenessNote(incompleteness)}
					</p>
				)}
				<div className="grid stats-grid items-center gap-x-3 gap-y-row-loose text-row">
					<span />
					{/* the reference column is named for where the values came from.
					    stable's are all the header's. a native report's are mostly the
					    block's, but maxCombo and totalScore are read off the header
					    (the block carries neither), so "file" is the one title true of
					    every row rather than trading one mislabel for another */}
					<span className="text-right text-mini-label uppercase text-muted-foreground">
						{report.profile === "native" ? "file" : "header"}
					</span>
					<span className="text-right text-mini-label uppercase text-muted-foreground">simulated</span>
					<span />
					{report.rows.map((row) => {
						const verdict = rowVerdict(row, incompleteness);
						return (
							<div key={row.field} className="contents">
								<span className="text-muted-foreground">{integrityRowLabel(row.field)}</span>
								<span
									className={`text-right tabular-nums ${
										verdict === "differs" ? "text-destructive" : "text-foreground"
									}`}
								>
									{integrityRowValue(row.field, row.header)}
								</span>
								<span className="text-right tabular-nums text-foreground">
									{integrityRowValue(row.field, row.simulated)}
								</span>
								{verdict === "match" ? (
									<Check className="size-3 shrink-0 text-grade-ok" aria-label="matches" />
								) : verdict === "expected" ? (
									<Minus
										className="size-3 shrink-0 text-muted-foreground"
										aria-label="differs (play ended early)"
									/>
								) : (
									<X className="size-3 shrink-0 text-destructive" aria-label="differs" />
								)}
							</div>
						);
					})}
				</div>
				{report.crossCheck !== null && (
					<div
						className={`mt-2.5 border-t border-border pt-2 text-caption-tight tabular-nums ${consistent ? "text-muted-foreground" : "text-destructive"}`}
					>
						{describeCrossCheck(report.crossCheck)}
					</div>
				)}
				{/* never gated: the note answers for every state the graph has,
				    the native profile's absent one included, and gating it on the
				    cross-check -- a separately nullable field -- is what would
				    make that answer unreachable. it takes the separator when the
				    cross-check line above is not there to carry one */}
				<div
					className={`text-caption-plain text-muted-foreground tabular-nums ${report.crossCheck === null ? "mt-2.5 border-t border-border pt-2" : "mt-1"}`}
				>
					{lifeBarGraphNote(report.lifeBarGraph)}
				</div>
				{report.block != null && (
					<div
						className={`mt-2.5 border-t border-border pt-2 text-caption-tight tabular-nums ${report.block.rankMatch ? "text-muted-foreground" : "text-destructive"}`}
					>
						{blockNote(report.block)}
					</div>
				)}
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
			<div className="mt-stack card text-row">
				{lattice === null || summary === null ? (
					<p className="text-muted-foreground">
						no lattice inferred — the coordinates fit no known fullscreen quantisation (windowed play), so
						off-lattice analysis is unavailable
					</p>
				) : summary.runCount === 0 ? (
					<p className="text-muted-foreground">
						every frame sits on the {formatLatticeStep(lattice)} lattice — no interpolated or synthesized
						input detected
					</p>
				) : (
					<>
						<div className="text-foreground tabular-nums">
							{summary.runCount.toLocaleString()} off-lattice {summary.runCount === 1 ? "run" : "runs"} ·{" "}
							{summary.offLatticeFrames.toLocaleString()}{" "}
							{summary.offLatticeFrames === 1 ? "frame" : "frames"} off the {formatLatticeStep(lattice)}{" "}
							lattice
						</div>
						<div className="mt-1.5 flex flex-col gap-inset font-mono text-meta text-foreground-soft">
							{summary.longestRuns.map((run) => (
								<div key={run.startIndex} className="tabular-nums">
									frames {run.startIndex.toLocaleString()}–{run.endIndex.toLocaleString()} ·{" "}
									{formatTime(run.startTime)}–{formatTime(run.endTime)} ·{" "}
									{(run.endIndex - run.startIndex + 1).toLocaleString()} long
								</div>
							))}
						</div>
						{summary.runCount > summary.longestRuns.length && (
							<div className="mt-1 text-meta text-muted-foreground">
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
			<div className="mt-stack rounded-card border border-border bg-surface-card p-2">
				<svg viewBox="0 0 600 40" preserveAspectRatio="none" className="h-10 w-full">
					{points !== null && (
						<>
							<polygon
								points={`0,40 ${points} 600,40`}
								className="fill-graph-velocity"
								fillOpacity={0.14}
							/>
							<polyline points={points} fill="none" className="stroke-graph-velocity" strokeWidth={1.6} />
						</>
					)}
				</svg>
			</div>
			<div className="mt-1.5 text-row text-foreground-soft tabular-nums">
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
	// the timing and hp sections display a timeline, authoritative or
	// approximate; the integrity section below is the exact one, and the
	// scene ships it only for an authoritative simulation
	const timeline = simulated(simulation);
	const authoritative = timeline !== null;
	// judgedTime (analysis.ts) returns null for a miss -- it carries no press
	// to measure an error against -- so an authoritative simulation can still
	// finish with zero countable hit errors (a miss-only play, or a map with
	// no circle/slider-head objects at all). gate the timing half on both
	// conditions together, or a miss-only replay renders a fabricated 0.00 UR
	// and a histogram of floored bars instead of admitting there's nothing to
	// measure
	const hasTimedHits = authoritative && analysis.errors.length > 0;

	// totals ride every timeline, approximate included -- an absent trailing is
	// the honest header for a replay whose judgements were never simulated
	const judgedTrailing =
		timeline !== null
			? `${(
					timeline.totals.count300 +
					timeline.totals.count100 +
					timeline.totals.count50 +
					timeline.totals.countMiss
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
										<div className="text-stat font-bold tabular-nums text-foreground-bright">
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
											className="text-stat font-bold tabular-nums"
											style={{ color: "var(--grade-great)" }}
										>
											{signedMs(analysis.meanError)}
											<span className="text-title text-muted-foreground">ms</span>
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

				{authoritative && <HpSection hp={derived.hp} report={scene.integrity} />}

				<VelocityChart
					velocity={analysis.velocity}
					peakVelocity={analysis.peakVelocity}
					meanVelocity={analysis.meanVelocity}
				/>

				<dl className="grid dl-grid gap-x-3 gap-y-stack text-row">
					<StatRow label="peak tap rate" value={`${Math.round(analysis.peakTapBpm)} bpm`} />
					<StatRow label="mean hold" value={`${Math.round(analysis.meanHoldMs)}ms`} />
					<StatRow label="frames" value={analysis.frameCount.toLocaleString()} />
					<StatRow label="median Δt" value={`${analysis.medianDeltaMs.toFixed(1)}ms`} />
					{/* the slider elements the cursor let go of, summed off the object
					lane's own drop lists in the lane's own words (derive.ts's
					describeDrops), so this row and a slider's hover readout can
					never disagree. under the stable profile only sliders that still
					scored carry drop state -- a fully missed one says everything
					with its miss -- while under the native profile every slider
					reports what lazer dropped, whatever its head graded */}
					{authoritative && <StatRow label="dropped" value={describeDrops(derived.drops) ?? "none"} />}
				</dl>

				{scene.integrity !== null && (
					<IntegritySection report={scene.integrity} incompleteness={scene.incompleteness} />
				)}

				<OffLatticeSection lattice={editor?.lattice ?? null} summary={editor?.offLattice ?? null} />
			</div>
		</>
	);
}
