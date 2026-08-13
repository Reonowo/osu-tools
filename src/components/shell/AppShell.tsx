// the docked application shell: a four-row grid (top bar, viewport row,
// timeline dock, status bar) that replaces the old floating-overlay chrome.
// every row is real now (TopBar, SidePanel, TabRail, TimelineDock,
// StatusBar), so this file only composes layout and never their internals

import type { SettingsCategory } from "@/components/settings/categories";
import { TimelineDock } from "@/components/timeline/TimelineDock";
import { Viewport } from "@/components/viewport/Viewport";
import { usePlaybackShortcuts } from "@/playback/use-playback-shortcuts";
import { useViewerStore } from "@/state/store";
import { SidePanel } from "./SidePanel";
import { StatusBar } from "./StatusBar";
import { TabRail } from "./TabRail";
import { TopBar } from "./TopBar";

export function AppShell({
	onOpenSettings,
	onOpenExport
}: {
	onOpenSettings: (category?: SettingsCategory) => void;
	onOpenExport: () => void;
}) {
	const panelOpen = useViewerStore((s) => s.panelOpen);

	// Controls.tsx was the only caller before the shell replaced it; the shell
	// is now the permanent home for shortcuts regardless of which region is
	// focused, so the hook lives here rather than in any one row
	usePlaybackShortcuts();

	return (
		<div className="grid h-screen w-screen grid-rows-[48px_minmax(0,1fr)_auto_26px] overflow-hidden bg-surface-viewport font-sans text-[#e4e4e7]">
			<TopBar onOpenSettings={onOpenSettings} onOpenExport={onOpenExport} />
			<div className="flex min-h-0 min-w-0">
				<Viewport />
				{panelOpen && <SidePanel />}
				<TabRail />
			</div>
			<TimelineDock />
			<StatusBar />
		</div>
	);
}
