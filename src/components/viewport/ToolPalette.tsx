// edit-mode overlays: the tool palette and the coordinate readout. both are
// edit-mode-only and small enough that splitting the readout into its own
// file (the brief allots exactly three files for this task) would be a
// single-consumer module -- it lives here, next to the palette it visually
// pairs with, rather than in Viewport.tsx, which only composes

import { useEffect, useMemo, useRef } from "react";
import { Eraser, Lasso, type LucideIcon, Magnet, Move, MousePointer2, Spline } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cursorStateAt } from "@/engine/interpolation";
import { isOnLattice } from "@/lib/lattice";
import { cn } from "@/lib/utils";
import { playbackClock } from "@/playback/instance";
import { countAtOrBefore } from "@/renderer/overlays/analysis";
import { useViewerStore, type ToolId } from "@/state/store";

const IPC_BLOCKER = "needs the replay-document ipc commands";

const TOOLS: { id: ToolId; icon: LucideIcon; label: string }[] = [
	{ id: "select", icon: MousePointer2, label: "select" },
	{ id: "lasso", icon: Lasso, label: "lasso" },
	{ id: "move", icon: Move, label: "move" },
	{ id: "smooth", icon: Spline, label: "smooth" },
	{ id: "erase", icon: Eraser, label: "erase" }
];
const TOOL_IDS: readonly string[] = TOOLS.map((tool) => tool.id);

// the toggle-group item's default size variant carries min-w-8/px-2.5
// alongside h-8; twMerge only drops h-8 for size-7 (same group, min-w is a
// separate group), so min-w-0/p-0 clear the rest -- otherwise the button
// renders 32px wide with an off-centre icon instead of a 28px square
const ITEM_CLASS =
	"size-7 min-w-0 justify-center rounded-lg p-0 text-[#71717a] aria-pressed:border aria-pressed:border-primary/40 aria-pressed:bg-primary/[.16] aria-pressed:text-primary";

function PaletteButton({
	id,
	icon: Icon,
	label,
	tooltip
}: {
	id: ToolId;
	icon: LucideIcon;
	label: string;
	tooltip: string;
}) {
	return (
		<Tooltip>
			{/* a natively-disabled button fires no hover events, so the tooltip
			trigger is the wrapping span instead -- matches TopBar's disabled
			export button */}
			<TooltipTrigger render={<span />}>
				<ToggleGroupItem value={id} disabled aria-label={label} className={ITEM_CLASS}>
					<Icon aria-hidden />
				</ToggleGroupItem>
			</TooltipTrigger>
			<TooltipContent side="right">{tooltip}</TooltipContent>
		</Tooltip>
	);
}

export function ToolPalette() {
	const tool = useViewerStore((s) => s.tool);
	const setTool = useViewerStore((s) => s.setTool);
	const snapToLattice = useViewerStore((s) => s.editing.snapToLattice);

	return (
		<ToggleGroup
			orientation="vertical"
			value={[tool]}
			onValueChange={(next) => {
				// base-ui's toggle-group value is array-valued even in single-select
				// mode; every item here is disabled so this never actually fires,
				// but setTool stays wired for when the tools do
				const chosen = next[0];
				if (chosen !== undefined && TOOL_IDS.includes(chosen)) setTool(chosen as ToolId);
			}}
			className="absolute top-3 left-3 gap-1 rounded-[10px] border border-border bg-surface-panel/[.92] p-1 shadow-[0_12px_24px_-8px_rgba(0,0,0,.6)] backdrop-blur-[8px]"
		>
			{TOOLS.slice(0, 2).map(({ id, icon, label }) => (
				<PaletteButton key={id} id={id} icon={icon} label={label} tooltip={`${label} ${IPC_BLOCKER}`} />
			))}
			<Separator className="my-0.5" />
			{TOOLS.slice(2).map(({ id, icon, label }) => (
				<PaletteButton key={id} id={id} icon={icon} label={label} tooltip={`${label} ${IPC_BLOCKER}`} />
			))}
			<Separator className="my-0.5" />
			<Tooltip>
				<TooltipTrigger render={<span />}>
					{/* the indicator is live (driven by the real snapToLattice setting),
					but snapping itself still needs the replay-document ipc, so the
					item stays disabled -- it is not a tool selection, which is why
					ToolId excludes "snap" and the group's onValueChange never routes
					this value to setTool */}
					<ToggleGroupItem
						value="snap"
						disabled
						aria-label="snap to lattice"
						className={cn(ITEM_CLASS, snapToLattice && "text-[#66ccff]")}
					>
						<Magnet aria-hidden />
					</ToggleGroupItem>
				</TooltipTrigger>
				<TooltipContent side="right">
					snap to lattice {snapToLattice ? "on" : "off"} — needs the replay-document ipc to actually snap
				</TooltipContent>
			</Tooltip>
		</ToggleGroup>
	);
}

const LATTICE_UNKNOWN = "#71717a";
const LATTICE_ON = "#66ccff";
const LATTICE_OFF = "#ffcc22";

export function CoordinateReadout() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const xRef = useRef<HTMLSpanElement>(null);
	const yRef = useRef<HTMLSpanElement>(null);
	const frameRef = useRef<HTMLSpanElement>(null);
	const latticeRef = useRef<HTMLSpanElement>(null);

	// recomputed only when a new scene installs -- the loop below just
	// binary-searches this array each tick, same split as FramesPanel
	const frameTimes = useMemo(() => scene?.frames.map((f) => f.time) ?? [], [scene]);

	useEffect(() => {
		if (scene === null || derived === null) return;
		const frames = scene.frames;
		const lattice = derived.lattice;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const sample = cursorStateAt(frames, t);
			const frameIndex = frames.length > 0 ? Math.max(0, countAtOrBefore(frameTimes, t) - 1) : -1;

			if (xRef.current !== null) xRef.current.textContent = sample === null ? "—" : sample.x.toFixed(1);
			if (yRef.current !== null) yRef.current.textContent = sample === null ? "—" : sample.y.toFixed(1);
			if (frameRef.current !== null) frameRef.current.textContent = frameIndex < 0 ? "—" : String(frameIndex);

			const latticeEl = latticeRef.current;
			if (latticeEl !== null) {
				if (lattice === null) {
					latticeEl.textContent = "lattice unknown";
					latticeEl.style.color = LATTICE_UNKNOWN;
				} else {
					const onLattice =
						sample !== null && isOnLattice(sample.x, lattice.step) && isOnLattice(sample.y, lattice.step);
					latticeEl.textContent = onLattice ? "on lattice" : "off lattice";
					latticeEl.style.color = onLattice ? LATTICE_ON : LATTICE_OFF;
				}
			}
			raf = requestAnimationFrame(loop);
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [scene, derived, frameTimes]);

	if (scene === null || derived === null) return null;

	return (
		<div className="absolute right-3 bottom-3 flex items-center gap-2.5 rounded-lg border border-border bg-surface-panel/90 px-2.5 py-[5px] font-mono text-[10px] text-[#71717a] backdrop-blur-[8px]">
			<span>
				x{" "}
				<span ref={xRef} className="text-[#e4e4e7] tabular-nums">
					0.0
				</span>
			</span>
			<span>
				y{" "}
				<span ref={yRef} className="text-[#e4e4e7] tabular-nums">
					0.0
				</span>
			</span>
			<span>
				frame{" "}
				<span ref={frameRef} className="text-[#e4e4e7] tabular-nums">
					0
				</span>
			</span>
			<span ref={latticeRef} className="font-semibold">
				lattice unknown
			</span>
		</div>
	);
}
