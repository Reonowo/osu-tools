// edit-mode overlays: the tool palette and the coordinate readout. both are
// edit-mode-only and small enough that splitting the readout into its own
// file (the brief allots exactly three files for this task) would be a
// single-consumer module -- it lives here, next to the palette it visually
// pairs with, rather than in Viewport.tsx, which only composes

import { useEffect, useRef } from "react";
import { Eraser, Lasso, type LucideIcon, Magnet, Move, MousePointer2, Spline } from "lucide-react";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cursorStateAt } from "@/engine/interpolation";
import { isOnLattice } from "@/lib/lattice";
import { cn } from "@/lib/utils";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { useViewerStore, type ToolId } from "@/state/store";

const TOOL_BLOCKER = "not wired yet — the cursor-path tools are the next milestone";

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

// the same 28px-square geometry as ITEM_CLASS, minus its aria-pressed:*
// selected-tool styling -- the snap tile's aria-pressed genuinely tracks
// snapToLattice (unlike the disabled tool tiles above, where aria-pressed
// never fires), so reusing ITEM_CLASS here would have aria-pressed:text-primary
// (two classes' worth of specificity) beat the plain text-[#66ccff] tint
// below (one class) and paint the tile the tool-selected pink instead of the
// preference cyan
const PREFERENCE_TILE_CLASS = "size-7 min-w-0 justify-center rounded-lg p-0 text-[#71717a]";

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
	const setEditing = useViewerStore((s) => s.setEditing);

	return (
		<div className="absolute top-3 left-3 flex flex-col gap-1 rounded-[10px] border border-border bg-surface-panel/[.92] p-1 shadow-[0_12px_24px_-8px_rgba(0,0,0,.6)] backdrop-blur-[8px]">
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
				className="gap-1"
			>
				{TOOLS.slice(0, 2).map(({ id, icon, label }) => (
					<PaletteButton key={id} id={id} icon={icon} label={label} tooltip={`${label} ${TOOL_BLOCKER}`} />
				))}
				<Separator className="my-0.5" />
				{TOOLS.slice(2).map(({ id, icon, label }) => (
					<PaletteButton key={id} id={id} icon={icon} label={label} tooltip={`${label} ${TOOL_BLOCKER}`} />
				))}
			</ToggleGroup>
			<Separator className="my-0.5" />
			{/* a live preference toggle, not a tool selection -- it sits outside the
			ToggleGroup entirely so pressing it can never fight the group's
			single-select value (ToolId excludes "snap" for the same reason) */}
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							type="button"
							aria-label="snap to lattice"
							aria-pressed={snapToLattice}
							onClick={() => setEditing("snapToLattice", !snapToLattice)}
							className={cn(
								PREFERENCE_TILE_CLASS,
								"flex items-center",
								snapToLattice && "text-[#66ccff]"
							)}
						>
							<Magnet aria-hidden className="size-4" />
						</button>
					}
				/>
				<TooltipContent side="right">
					snap to lattice {snapToLattice ? "on" : "off"} — applies to nudge and drag commits; synthesized
					frames always snap when a lattice exists
				</TooltipContent>
			</Tooltip>
		</div>
	);
}

const LATTICE_UNKNOWN = "#71717a";
const LATTICE_ON = "#66ccff";
const LATTICE_OFF = "#ffcc22";

export function CoordinateReadout() {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const lattice = useViewerStore((s) => s.editor?.lattice ?? null);
	const xRef = useRef<HTMLSpanElement>(null);
	const yRef = useRef<HTMLSpanElement>(null);
	const frameRef = useRef<HTMLSpanElement>(null);
	const latticeRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		if (scene === null || derived === null) return;
		const frames = scene.frames;
		let raf = 0;
		const loop = () => {
			const t = playbackClock.currentTime();
			const selected = frames.length > 0 ? frameCursor.selectedIndex() : null;
			const frameIndex = frames.length > 0 ? frameCursor.currentIndex() : -1;
			// sampling by time resolves a tied-time run to its last frame, so an
			// exact selection has to be read off the frame itself: otherwise this
			// readout names one frame and prints another's coordinates, and the
			// lattice check below judges the frame the user did not select
			const sample = selected !== null ? frames[selected] : cursorStateAt(frames, t);

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
	}, [scene, derived, lattice]);

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
