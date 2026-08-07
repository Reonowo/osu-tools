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

	return (
		<aside className="flex min-h-0 w-80 shrink-0 flex-col border-l border-border bg-surface-panel">
			{panelTab === "replay" && <ReplayPanel />}
			{panelTab === "analysis" && <AnalysisPanel />}
			{panelTab === "frames" && <FramesPanel />}
			{panelTab === "keys" && <KeypressPanel />}
			{panelTab === "meta" && <MetadataPanel />}
			{panelTab === "history" && <HistoryPanel />}
		</aside>
	);
}
