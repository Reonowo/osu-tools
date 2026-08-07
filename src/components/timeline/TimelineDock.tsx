// the timeline dock: row 3 of the shell grid, composing the timeline's three
// tiers -- the overview strip (task 14), the zoomable detail lanes (task 15,
// gated to edit mode), and the transport row (task 16) -- this file only
// composes layout and never their internals

import { useViewerStore } from "@/state/store";
import { DetailLanes } from "./DetailLanes";
import { OverviewStrip } from "./OverviewStrip";
import { Transport } from "./Transport";

export function TimelineDock() {
	const mode = useViewerStore((s) => s.mode);

	return (
		<div className="border-t border-border bg-surface-bar">
			<OverviewStrip />
			{mode === "edit" && <DetailLanes />}
			<Transport />
		</div>
	);
}
