// the docked viewport: hosts the pixi playfield plus every viewport-scoped
// overlay -- watch mode's hud, and edit mode's (inert) tool palette and
// coordinate readout. purely compositional; the overlays implement themselves

import { PlayerView } from "@/components/PlayerView";
import { useViewerStore } from "@/state/store";
import { CoordinateReadout, ToolPalette } from "./ToolPalette";
import { WatchHud } from "./WatchHud";

export function Viewport() {
	const mode = useViewerStore((s) => s.mode);

	return (
		<div className="relative min-w-0 flex-1 overflow-hidden bg-surface-viewport">
			<PlayerView />
			<WatchHud />
			{mode === "edit" && (
				<>
					<ToolPalette />
					<CoordinateReadout />
				</>
			)}
		</div>
	);
}
