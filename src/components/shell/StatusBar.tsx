// row 4 of the shell grid: the 26px status bar. every segment here is
// discrete or per-scene, never continuous -- the playback clock has its own
// rAF-driven readouts in Transport.tsx, and none of that belongs here

import { Fragment, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMods } from "@/lib/format";
import { formatLatticeStep } from "@/lib/lattice";
import { audioExtendedBounds } from "@/lib/timeline";
import { clampSpan, zoomFactor } from "@/lib/timeline-view";
import { selectWarnings, warningList } from "@/lib/warnings";
import { useViewerStore } from "@/state/store";

// mx-2's 8px sits either side of the glyph, matching the other hairline
// separators the shell draws as literal text (TopBar's "·" between
// beatmap/player/duration) rather than the ui/separator.tsx rule
function RunSeparator() {
	return <span className="mx-2 text-[#27272a]">│</span>;
}

// lowercase prose for SimulationDto's notSimulated reason -- mirrors
// warningText's shape (lib/warnings.ts) so the status bar never leaks a raw
// discriminant like "unsupportedMods" into a row that is otherwise all
// lowercase prose. local to StatusBar rather than lib/warnings.ts: this is a
// simulation concern, not a warning, and StatusBar is its only reader. no
// default case -- the parameter's own literal union makes an unhandled
// reason a typecheck failure (missing return, same guarantee warningText
// gets from its switch) rather than a silent raw-string fallback
function simulationReasonText(reason: "unsupportedMods" | "beatmapMismatch"): string {
	switch (reason) {
		case "unsupportedMods":
			// the replay uses mods the engine's simulator doesn't implement yet
			// (mods.rs is NoMod-only so far), so nothing was simulated at all
			return "mods not simulated";
		case "beatmapMismatch":
			// the loaded beatmap's md5 doesn't match the replay's -- same fact
			// warningText's beatmapMismatch case reports, worded to fit inline
			return "beatmap mismatch";
	}
}

export function StatusBar() {
	// AppShell only mounts once App.tsx has a loaded scene (same guarantee
	// TopBar relies on), so these reads are always populated in practice --
	// the fallbacks just keep the component well-typed against the store's
	// nullable fields
	const scene = useViewerStore((s) => s.scene);
	const timelineBounds = useViewerStore((s) => s.timelineBounds);
	const lattice = useViewerStore((s) => s.editor?.lattice ?? null);
	const detailSpanMs = useViewerStore((s) => s.detailSpanMs);
	const audioDurationMs = useViewerStore((s) => s.audioDurationMs);
	const snapToLattice = useViewerStore((s) => s.editing.snapToLattice);
	const selectedFrames = useViewerStore((s) => s.editor?.frameSelection.length ?? 0);
	const warnings = useViewerStore(selectWarnings);

	const simulation = scene?.simulation;
	const authoritative = simulation?.status === "authoritative";
	const simulationLabel =
		simulation === undefined
			? "simulation unknown"
			: authoritative
				? "simulation authoritative"
				: `simulation off (${simulationReasonText(simulation.reason)})`;

	// the same audio-extended window DetailLanes and OverviewStrip zoom
	// against (lib/timeline.ts's audioExtendedBounds) -- a replay's frames can
	// end before its audio does, and the zoom readout must describe the same
	// span the timeline actually renders rather than a narrower frame-only
	// one. timeline bounds for the same reason: the readout follows the
	// lanes' mapping, which holds still under editing
	const bounds = audioExtendedBounds(timelineBounds ?? { minTime: 0, maxTime: 0 }, audioDurationMs);
	// clampSpan mirrors windowAround inside the lanes: on a replay shorter
	// than the stored span the lanes render the whole replay at 1x, and the
	// readout must not claim a sub-1x zoom the timeline is not doing
	const zoom = zoomFactor(clampSpan(bounds, detailSpanMs), bounds);

	const latticeLabel = lattice ? `lattice ${formatLatticeStep(lattice)}` : "lattice unknown";

	const leftRun: ReactNode[] = [
		<span className="inline-flex items-center gap-1.5">
			<span className={`size-[5px] rounded-full ${authoritative ? "bg-[#88b300]" : "bg-[#ffcc22]"}`} />
			{simulationLabel}
		</span>,
		<span>{formatMods(scene?.replay.mods ?? 0).toLowerCase()}</span>,
		<span>{scene?.frames.length ?? 0} frames</span>,
		<span>{scene?.renderPlan.objects.length ?? 0} objects</span>,
		// the one segment nothing else in the app explains: a bare "1/512" says
		// neither what a lattice is nor where the number came from
		<Tooltip>
			<TooltipTrigger render={<span />}>{latticeLabel}</TooltipTrigger>
			<TooltipContent side="top">
				the coordinate grid this replay's own untouched frames land on, inferred from them at load. edits snap
				to it so they stay indistinguishable from what the client would have written.
			</TooltipContent>
		</Tooltip>
	];

	if (warnings.length > 0) {
		leftRun.push(
			<Popover>
				<PopoverTrigger className="inline-flex h-[18px] items-center gap-1 rounded-[5px] border border-[rgba(245,158,11,.35)] bg-[rgba(69,26,3,.55)] px-[7px] text-[10px] text-[#fbbf24]">
					<AlertTriangle className="size-3" />
					{warnings.length} warning{warnings.length === 1 ? "" : "s"}
				</PopoverTrigger>
				{/* the popup's own w-72 is a fixed width, not a cap -- twMerge
				keeps both it and max-w-md since they're different class groups, so
				w-auto is here to cancel w-72 and let max-w-md actually be the cap.
				select-text: warning prose is a copy opt-in (see index.css) */}
				<PopoverContent
					side="top"
					align="end"
					className="w-auto max-w-md border border-border bg-popover select-text"
				>
					{warningList(warnings).map((warning) => (
						<div key={warning.kind} className="flex items-start gap-2 text-xs text-[#e4e4e7]">
							<AlertTriangle className="size-3 shrink-0 text-[#fbbf24]" />
							{warning.text}
						</div>
					))}
				</PopoverContent>
			</Popover>
		);
	}

	return (
		<footer className="flex min-w-0 items-center border-t border-border bg-surface-rail px-2.5 font-mono text-[10.5px] text-[#8a8a93]">
			{leftRun.map((segment, index) => (
				<Fragment key={index}>
					{index > 0 && <RunSeparator />}
					{segment}
				</Fragment>
			))}

			<div className="ml-auto flex items-center">
				{selectedFrames > 0 && (
					<>
						{/* the frame selection's count -- cyan, the editor-state accent,
						so a 300-frame marquee reads at a glance */}
						<span className="text-[#66ccff]">
							{selectedFrames} frame{selectedFrames === 1 ? "" : "s"} selected
						</span>
						<RunSeparator />
					</>
				)}
				<span>snap {snapToLattice ? "on" : "off"}</span>
				<RunSeparator />
				<span>timeline {zoom.toFixed(1)}×</span>
			</div>
		</footer>
	);
}
