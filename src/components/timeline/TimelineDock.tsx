// the timeline dock: row 3 of the shell grid, composing the timeline's three
// tiers -- the overview strip (task 14), the zoomable detail lanes (task 15,
// gated to edit mode), and the transport row (task 16) -- this file only
// composes layout and never their internals. the one behaviour it owns is
// the dock-wide ctrl+wheel span zoom: one rule for every tier, mirroring how
// ctrl+wheel zooms the viewport canvas, while plain wheel keeps frame-
// stepping here like everywhere else (the global listener handles that; the
// webview's own ctrl+wheel page zoom is suppressed app-wide in App.tsx)

import { detailSpanForWheel } from "@/lib/timeline-view";
import { useViewerStore } from "@/state/store";
import { DetailLanes } from "./DetailLanes";
import { OverviewStrip } from "./OverviewStrip";
import { Transport } from "./Transport";

export function TimelineDock() {
	const mode = useViewerStore((s) => s.mode);
	const detailSpanMs = useViewerStore((s) => s.detailSpanMs);
	const setDetailSpan = useViewerStore((s) => s.setDetailSpan);

	return (
		<div
			onWheel={(e) => {
				const next = detailSpanForWheel(detailSpanMs, e);
				if (next !== null) setDetailSpan(next);
			}}
			className="border-t border-border bg-surface-bar"
		>
			<OverviewStrip />
			{mode === "edit" && <DetailLanes />}
			<Transport />
		</div>
	);
}
