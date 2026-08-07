// the pre-load landing screen: drop target, recents, and the honest
// osu! stable footer. own three-row grid (48px/1fr/26px) mirroring the
// shell's silhouette so switching between this and AppShell (App.tsx's
// scene === null branch) reads as the same application, not two skins

import { FileUp, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Identity } from "@/components/shell/TopBar";
import { PanelHeader } from "@/components/shell/SidePanel";
import { formatAccuracy, formatRelativeTime } from "@/lib/format";
import { pickReplay } from "@/lib/openers";
import type { RecentReplay } from "@/lib/scene-types";
import { useViewerStore } from "@/state/store";

function RecentEntry({
	entry,
	nowMs,
	openReplay
}: {
	entry: RecentReplay;
	nowMs: number;
	openReplay: (osrPath: string) => Promise<void>;
}) {
	return (
		<button
			type="button"
			onClick={() => void openReplay(entry.osrPath)}
			className="flex w-full flex-col gap-1 rounded-[9px] border border-transparent px-2.5 py-[9px] text-left hover:bg-[#16161a]"
		>
			<div className="truncate text-[12px] font-medium text-[#e4e4e7]">
				{entry.title} <span className="text-[#71717a]">[{entry.version}]</span>
			</div>
			<div className="truncate font-mono text-[10px] text-[#71717a]">
				{entry.playerName ?? "unknown"} · {formatAccuracy(entry.accuracy)} · {entry.maxCombo}x ·{" "}
				{formatRelativeTime(entry.openedAtMs, nowMs)}
			</div>
		</button>
	);
}

export function StartScreen({ onOpenSettings }: { onOpenSettings: () => void }) {
	const settings = useViewerStore((s) => s.settings);
	const loading = useViewerStore((s) => s.loading);
	const openReplay = useViewerStore((s) => s.openReplay);
	const clearRecents = useViewerStore((s) => s.clearRecents);

	const recents = settings?.recents ?? [];
	// a static snapshot, not a ticking clock: this screen never re-renders on
	// its own between opens, and formatRelativeTime only needs "now" once
	const nowMs = Date.now();

	// get_settings only ever returns the user's override path -- the app
	// resolves no install directory of its own (no ipc command does that yet,
	// see TODO.md's task 20 entry). the null-state footer copy below says "no
	// path set" rather than "auto-detected": the latter is a past participle,
	// it reads as "we looked and found it", and that lookup never happens --
	// don't restore that wording, it was the exact bug this comment guards
	const stablePath = settings?.osuStablePath ?? null;

	return (
		<div className="grid h-screen w-screen grid-rows-[48px_minmax(0,1fr)_26px] overflow-hidden bg-surface-viewport font-sans text-[#e4e4e7]">
			<header className="flex min-w-0 items-center border-b border-border bg-surface-bar px-2 pl-2.5">
				<Identity />
				<Button
					size="icon-sm"
					variant="ghost"
					aria-label="settings"
					className="ml-auto"
					onClick={onOpenSettings}
				>
					<Settings2 />
				</Button>
			</header>

			<div className="grid min-h-0 grid-cols-[minmax(0,1fr)_400px]">
				<div className="flex min-h-0 items-center justify-center">
					<div className="ease-out-quint flex w-full max-w-[420px] flex-col items-center gap-3 rounded-[14px] border-[1.5px] border-dashed border-border-strong bg-surface-panel/60 px-8 py-11 text-center transition-all duration-300 hover:border-primary/50 hover:bg-primary/[.03]">
						<FileUp className="size-[30px] text-[#71717a]" />
						<p className="text-[15px] font-semibold text-[#f4f4f5]">drop a replay to open it</p>
						<p className="text-[11.5px] leading-[1.55] text-[#71717a]">
							drop a <span className="font-mono">.osr</span> file anywhere in this window. its beatmap is
							found through your osu! stable install, and you'll be asked for it if it can't be.
						</p>
						<Button
							onClick={() => void pickReplay()}
							disabled={loading}
							className="mt-2 h-[34px] rounded-[9px] bg-primary px-4 text-primary-foreground"
						>
							{loading ? "loading…" : "browse for a replay"}
						</Button>
					</div>
				</div>

				<aside className="flex min-h-0 flex-col border-l border-border bg-surface-panel">
					<PanelHeader
						title="recent"
						trailing={
							recents.length > 0 ? (
								<button
									type="button"
									onClick={() => void clearRecents()}
									className="hover:text-[#e4e4e7]"
								>
									clear
								</button>
							) : undefined
						}
					/>
					<div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1.5">
						{recents.length === 0 ? (
							<p className="px-2.5 py-3 text-center text-[11px] text-[#71717a]">no replays opened yet</p>
						) : (
							recents.map((entry) => (
								<RecentEntry key={entry.osrPath} entry={entry} nowMs={nowMs} openReplay={openReplay} />
							))
						)}

						<button
							type="button"
							disabled
							className="mt-1 flex w-full flex-col gap-1 rounded-[9px] border border-dashed border-border px-2.5 py-[9px] text-left disabled:cursor-not-allowed"
						>
							<span className="flex items-center justify-between gap-2">
								<span className="text-[11px] text-[#71717a]">browse local replays</span>
								<Badge variant="secondary">soon</Badge>
							</span>
							<span className="text-[10px] text-[#8a8a93]">from scores.db and the Replays folder</span>
						</button>
					</div>
				</aside>
			</div>

			<footer className="flex min-w-0 items-center gap-1.5 border-t border-border bg-surface-rail px-2.5 font-mono text-[10.5px] text-[#8a8a93]">
				<span
					className={`size-[5px] shrink-0 rounded-full ${stablePath !== null ? "bg-[#88b300]" : "bg-[#8a8a93]"}`}
				/>
				<span>osu! stable {stablePath !== null ? "path set" : "no path set"}</span>
				<span className="text-[#3f3f46]">·</span>
				<span className="truncate">{stablePath ?? "auto-detect"}</span>
			</footer>
		</div>
	);
}
