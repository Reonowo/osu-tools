// the analysis tab's panel body: hit-timing stat cards, the error
// histogram, the cursor velocity trace, and the frame-stream stat list.
// header + scrolling body together, so SidePanel can mount this as a single
// self-contained panel

import type { ReactNode } from "react";
import { PanelHeader } from "@/components/shell/SidePanel";
import { ERROR_WINDOW_MS, type HistogramBin, type VelocitySample } from "@/lib/analysis";
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
			<div className="mt-[7px] flex h-[74px] items-end gap-[1.5px]">
				{histogram.map((bin) => {
					// an all-zero histogram must not divide by a zero max into NaN heights
					const share = maxCount === 0 ? 0 : bin.count / maxCount;
					const insideGreat = Math.abs(bin.centre) <= greatWindow;
					return (
						<div
							key={bin.centre}
							className="flex-1 rounded-t-[1.5px]"
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
							<StatCard label="unstable rate">
								<div className="text-[22px] font-bold tabular-nums text-[#f4f4f5]">
									{analysis.unstableRate.toFixed(2)}
								</div>
							</StatCard>
							<StatCard label="mean error">
								<div className="text-[22px] font-bold tabular-nums" style={{ color: "#66ccff" }}>
									{signedMs(analysis.meanError)}
									<span className="text-[12px] text-[#8a8a93]">ms</span>
								</div>
							</StatCard>
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
			</div>
		</>
	);
}
