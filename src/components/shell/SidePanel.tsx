// the docked side panel frame: a fixed-width column that switches its body
// on panelTab. PanelHeader is the shared title-row chrome every panel tab
// reuses (tasks 11, 12, 18); this file only composes and switches -- panel
// bodies (header + scrolling content together) live under components/panels

import type { ReactNode } from "react";
import { AnalysisPanel } from "@/components/panels/AnalysisPanel";
import { FramesPanel } from "@/components/panels/FramesPanel";
import { HistoryPanel } from "@/components/panels/HistoryPanel";
import { KeypressPanel } from "@/components/panels/KeypressPanel";
import { MetadataPanel } from "@/components/panels/MetadataPanel";
import { ReplayPanel } from "@/components/panels/ReplayPanel";
import { useContentFade } from "@/lib/use-content-fade";
import { cn } from "@/lib/utils";
import { useViewerStore } from "@/state/store";

export function PanelHeader({ title, trailing }: { title: string; trailing?: ReactNode }) {
	return (
		<div className="flex items-center justify-between border-b border-border px-3.5 pt-[11px] pb-2.5">
			<h2 className="text-[11px] font-semibold tracking-[.14em] text-[#a1a1aa] uppercase">{title}</h2>
			{trailing != null && <span className="font-mono text-[9.5px] text-[#8a8a93]">{trailing}</span>}
		</div>
	);
}

export function SidePanel() {
	const panelTab = useViewerStore((s) => s.panelTab);
	const panelOpen = useViewerStore((s) => s.panelOpen);
	// the body-fade rule, shared with the settings dialog's category body
	// (lib/content-fade.ts). passing null while the panel is CLOSING is what
	// buys both halves: the body keeps showing the tab it was closed on for the
	// whole slide out, and a rail tab clicked mid-exit -- which re-enters
	// without ever unmounting -- reads as the panel's own entry, so the slide
	// back in carries no second fade on top of it
	const body = useContentFade(panelOpen ? panelTab : null, panelTab);

	return (
		/* absolute and left-anchored inside AppShell's clipping column: the body
		keeps its full width while the column narrows, so it rides the column's
		moving left edge in from the rail side rather than reflowing at every
		width the slide passes through */
		<aside className="absolute inset-y-0 left-0 flex w-80 flex-col border-l border-border bg-surface-panel">
			{/* keyed on the tab so the fade restarts on every change rather than
			running once; the key is also what makes it an animation's business
			rather than a transition's, since the incoming body is a fresh element
			with nothing to transition from */}
			<div
				key={body.shown}
				data-motion-row="shell"
				className={cn("flex min-h-0 flex-1 flex-col", body.fading && "chrome-content-fade")}
			>
				{body.shown === "replay" && <ReplayPanel />}
				{body.shown === "analysis" && <AnalysisPanel />}
				{body.shown === "frames" && <FramesPanel />}
				{body.shown === "keys" && <KeypressPanel />}
				{body.shown === "meta" && <MetadataPanel />}
				{body.shown === "history" && <HistoryPanel />}
			</div>
		</aside>
	);
}
