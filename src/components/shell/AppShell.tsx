// the docked application shell: a four-row grid (top bar, viewport row,
// timeline dock, status bar) that replaces the old floating-overlay chrome.
// every row is real now (TopBar, SidePanel, TabRail, TimelineDock,
// StatusBar), so this file only composes layout and never their internals

import type { SettingsCategory } from "@/components/settings/categories";
import { TimelineDock } from "@/components/timeline/TimelineDock";
import { Viewport } from "@/components/viewport/Viewport";
import { useShellPresence } from "@/lib/use-presence";
import { cn } from "@/lib/utils";
import { usePlaybackShortcuts } from "@/playback/use-playback-shortcuts";
import { useViewerStore } from "@/state/store";
import { SidePanel } from "./SidePanel";
import { StatusBar } from "./StatusBar";
import { TabRail } from "./TabRail";
import { TopBar } from "./TopBar";

export function AppShell({
	onOpenSettings,
	onOpenExportReplay,
	onOpenExportVideo
}: {
	onOpenSettings: (category?: SettingsCategory) => void;
	onOpenExportReplay: () => void;
	onOpenExportVideo: () => void;
}) {
	const panelOpen = useViewerStore((s) => s.panelOpen);
	// the panel's column is always in the dom and only its WIDTH moves, which
	// is what makes the slide reverse from wherever it is and first paint
	// silent; the presence hook governs the body inside it, keeping a leaving
	// panel mounted and inert until the width transition ends and unmounting it
	// at once when shell motion is off (lib/presence.ts)
	const panel = useShellPresence(panelOpen, "width");

	// Controls.tsx was the only caller before the shell replaced it; the shell
	// is now the permanent home for shortcuts regardless of which region is
	// focused, so the hook lives here rather than in any one row
	usePlaybackShortcuts();

	return (
		<div
			data-motion-row="shell"
			className="shell-load-fade grid h-screen w-screen grid-rows-[48px_minmax(0,1fr)_auto_26px] overflow-hidden bg-surface-viewport font-sans text-[#e4e4e7]"
		>
			<TopBar
				onOpenSettings={onOpenSettings}
				onOpenExportReplay={onOpenExportReplay}
				onOpenExportVideo={onOpenExportVideo}
			/>
			<div className="flex min-h-0 min-w-0">
				<Viewport />
				{/* the panel PUSHES rather than overlays (docs/adr/0010): this
				column's width is a real flex width, so the viewport genuinely
				shrinks as the panel slides and the canvas follows through the
				resize observer it already has. overflow-hidden is what clips the
				body, which keeps its full width and is anchored to this column's
				moving LEFT edge -- so it rides that edge in from the rail side
				rather than being wiped or squashed, which is lazer's own
				MoveToX(320 -> 0). `inert` while it leaves so a tab never lands
				inside a region on its way out.

				both visual states are spelled out here as utilities and only the
				timing lives in the stylesheet, which is the pattern every shell
				region follows: the width is the panel's geometry and is declared
				once, beside the body that shares it */}
				<div
					data-motion-row="shell"
					inert={panel.exiting || undefined}
					onTransitionEnd={panel.onTransitionEnd}
					className={cn(
						"shell-panel-transition relative shrink-0 overflow-hidden",
						panelOpen ? "w-80 opacity-100" : "w-0 opacity-0"
					)}
				>
					{panel.mounted && <SidePanel />}
				</div>
				<TabRail />
			</div>
			<TimelineDock onOpenSettings={onOpenSettings} />
			<StatusBar />
		</div>
	);
}
