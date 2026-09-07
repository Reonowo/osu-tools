// the timeline dock: row 3 of the shell grid, composing the timeline's three
// tiers -- the overview strip (task 14), the zoomable detail lanes (task 15,
// gated to edit mode), and the transport row (task 16) -- this file only
// composes layout and never their internals. the one behaviour it owns is
// the dock-wide ctrl+wheel span zoom: one rule for every tier, mirroring how
// ctrl+wheel zooms the viewport canvas, while plain wheel keeps frame-
// stepping here like everywhere else (the global listener handles that; the
// webview's own ctrl+wheel page zoom is suppressed app-wide in App.tsx).
// onOpenSettings passes straight through to the transport's audio button:
// App.tsx owns dialog open-ness, which is the existing pattern -- moving it
// into the store would make a piece of chrome a piece of viewer state

import type { SettingsCategory } from "@/components/settings/categories";
import { detailSpanForWheel } from "@/lib/timeline-view";
import { useShellPresence } from "@/lib/use-presence";
import { cn } from "@/lib/utils";
import { useViewerStore } from "@/state/store";
import { DetailLanes } from "./DetailLanes";
import { OverviewStrip } from "./OverviewStrip";
import { Transport } from "./Transport";

export function TimelineDock({ onOpenSettings }: { onOpenSettings: (category?: SettingsCategory) => void }) {
	const mode = useViewerStore((s) => s.mode);
	const detailSpanMs = useViewerStore((s) => s.detailSpanMs);
	const setDetailSpan = useViewerStore((s) => s.setDetailSpan);
	const editing = mode === "edit";
	// the lanes' half of the edit tier. the grid wrapper is always in the dom
	// and only its ROW SIZE moves, so the reveal reverses mid-motion and a
	// replay opening straight into edit mode paints its lanes in place; the
	// body inside is presence-gated, staying mounted and inert until the
	// reveal has finished closing (lib/presence.ts)
	const lanes = useShellPresence(editing, "grid-template-rows");

	return (
		<div
			onWheel={(e) => {
				const next = detailSpanForWheel(detailSpanMs, e);
				if (next !== null) setDetailSpan(next);
			}}
			className="border-t border-border bg-surface-bar"
		>
			<OverviewStrip />
			{/* the edit tier reveals downward by MASK: the grid row animates from
			0fr to 1fr and the inner track clips, so no lane content is ever
			scaled and no height is ever measured. min-h-0 on the inner box is
			what lets a grid item shrink below its content, which is the whole
			mechanism (index.css) */}
			<div
				data-motion-row="shell"
				inert={lanes.exiting || undefined}
				onTransitionEnd={lanes.onTransitionEnd}
				className={cn("shell-edit-tier grid", editing ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
			>
				<div className="min-h-0 overflow-hidden">{lanes.mounted && <DetailLanes />}</div>
			</div>
			<Transport onOpenSettings={onOpenSettings} />
		</div>
	);
}
