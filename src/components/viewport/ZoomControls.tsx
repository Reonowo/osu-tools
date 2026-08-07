// the viewport's zoom cluster. bottom-centre is the one position free in both
// modes -- ToolPalette holds top-left, CoordinateReadout bottom-right, WatchHud
// bottom-left and right -- and the floating-panel treatment is ToolPalette's,
// so the two read as the same class of thing. the percentage doubles as the
// reset button rather than sitting beside a fourth icon nobody would recognise

import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VIEWPORT_ZOOM_STEP } from "@/renderer/playfield";
import { useViewerStore } from "@/state/store";

const STEP_PERCENT = Math.round(VIEWPORT_ZOOM_STEP * 100);

export function ZoomControls({ onStep }: { onStep: (direction: 1 | -1) => void }) {
	const zoom = useViewerStore((s) => s.viewportZoom);
	const resetViewport = useViewerStore((s) => s.resetViewport);

	return (
		<div className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-0.5 rounded-[10px] border border-border bg-surface-panel/[.92] p-1 shadow-[0_12px_24px_-8px_rgba(0,0,0,.6)] backdrop-blur-[8px]">
			<Tooltip>
				<TooltipTrigger
					render={
						<Button size="icon-sm" variant="ghost" aria-label="zoom out" onClick={() => onStep(-1)}>
							<Minus />
						</Button>
					}
				/>
				<TooltipContent side="top">zoom out {STEP_PERCENT}% — ctrl+wheel zooms at the pointer</TooltipContent>
			</Tooltip>

			<Tooltip>
				<TooltipTrigger
					render={
						<Button
							size="sm"
							variant="ghost"
							onClick={resetViewport}
							className="min-w-[52px] px-2 font-mono text-[11px] tabular-nums text-[#a1a1aa]"
						>
							{Math.round(zoom * 100)}%
						</Button>
					}
				/>
				<TooltipContent side="top">reset to 100%, centred — hold space or middle-drag to pan</TooltipContent>
			</Tooltip>

			<Tooltip>
				<TooltipTrigger
					render={
						<Button size="icon-sm" variant="ghost" aria-label="zoom in" onClick={() => onStep(1)}>
							<Plus />
						</Button>
					}
				/>
				<TooltipContent side="top">zoom in {STEP_PERCENT}% — ctrl+wheel zooms at the pointer</TooltipContent>
			</Tooltip>
		</div>
	);
}
