// the pre-load landing screen: drop target, recents, and the honest
// osu! stable footer. own three-row grid (48px/1fr/26px) mirroring the
// shell's silhouette so switching between this and AppShell (App.tsx's
// scene === null branch) reads as the same application, not two skins

import { FileUp, FolderSearch, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Identity } from "@/components/shell/TopBar";
import { PanelHeader } from "@/components/shell/SidePanel";
import { RecentEntry } from "@/components/RecentEntry";
import type { SettingsCategory } from "@/components/settings/categories";
import type { StableStatus } from "@/lib/scene-types";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pickReplay } from "@/lib/openers";
import { keybindSuffix } from "@/playback/keybinds";
import { useViewerStore } from "@/state/store";

export function StartScreen({ onOpenSettings }: { onOpenSettings: (category?: SettingsCategory) => void }) {
	const settings = useViewerStore((s) => s.settings);
	const loading = useViewerStore((s) => s.loading);
	// the one open action, the same one the drop handler and the picker call:
	// the beatmap association is resolved backend-side from the .osr path, so
	// a card carries no privilege a browse does not have (docs/adr/0005)
	const openReplay = useViewerStore((s) => s.openReplay);
	const clearRecents = useViewerStore((s) => s.clearRecents);
	const setBrowserOpen = useViewerStore((s) => s.setBrowserOpen);
	const keybinds = useViewerStore((s) => s.effectiveKeybinds);
	// the resolved install, read at startup by the store. what makes this
	// footer able to say "detected" at all -- see the comment below it
	const stableStatus = useViewerStore((s) => s.stableStatus);

	const recents = settings?.recents ?? [];
	// a static snapshot, not a ticking clock: this screen never re-renders on
	// its own between opens, and formatRelativeTime only needs "now" once
	const nowMs = Date.now();

	// the footer says what the app actually resolved, which it can now do:
	// get_stable_status runs detection outside a load, so "detected" is a
	// past participle backed by a real lookup rather than the lie the old
	// copy guarded against. `settings` is still read for the recents above
	const footer = footerCopy(stableStatus);

	return (
		<div className="grid h-screen w-screen grid-rows-[48px_minmax(0,1fr)_26px] overflow-hidden bg-surface-viewport font-sans text-[#e4e4e7]">
			<header className="flex min-w-0 items-center border-b border-border bg-surface-bar px-2 pl-2.5">
				<Identity />
				<Tooltip>
					<TooltipTrigger
						render={
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="settings"
								className="ml-auto"
								// this button exists for the install path: landing anywhere
								// but general here would be a regression
								onClick={() => onOpenSettings("general")}
							>
								<Settings2 />
							</Button>
						}
					/>
					<TooltipContent>
						stable install path, analysis overlays, effects and editing preferences
					</TooltipContent>
				</Tooltip>
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
							// the whole list here, unlike the open menu's: nothing is
							// loaded, so no row can mean "you are already here"
							recents.map((entry) => (
								<RecentEntry
									key={entry.osrPath}
									entry={entry}
									nowMs={nowMs}
									onOpen={(osrPath) => void openReplay(osrPath)}
								/>
							))
						)}

						{/* live where the placeholder stood, in place and in the same
						shape: this row promised the browser before it existed */}
						<button
							type="button"
							onClick={() => setBrowserOpen(true)}
							className="mt-1 flex w-full flex-col gap-1 rounded-[9px] border border-dashed border-border px-2.5 py-[9px] text-left hover:border-border-strong hover:bg-[#16161a]"
						>
							<span className="flex items-center gap-1.5">
								<FolderSearch className="size-3.5 text-[#71717a]" />
								<span className="text-[11px] text-[#e4e4e7]">browse local replays</span>
								<span className="ml-auto font-mono text-[10px] text-[#5a5a63]">
									{keybindSuffix(keybinds, "replayBrowser").trim()}
								</span>
							</span>
							<span className="text-[10px] text-[#8a8a93]">from scores.db and the Replays folder</span>
						</button>
					</div>
				</aside>
			</div>

			<footer className="flex min-w-0 items-center gap-1.5 border-t border-border bg-surface-rail px-2.5 font-mono text-[10.5px] text-[#8a8a93]">
				<span
					className={`size-[5px] shrink-0 rounded-full ${footer.found ? "bg-[#88b300]" : "bg-[#8a8a93]"}`}
				/>
				<span>osu! stable {footer.state}</span>
				<span className="text-[#3f3f46]">·</span>
				<span className="truncate">{footer.detail}</span>
			</footer>
		</div>
	);
}

/** the footer's three states, in the voice they read in. the null case is
 * "the probe has not answered yet", which is a moment long at startup and
 * must not be spelled as a failure */
function footerCopy(status: StableStatus | null): { found: boolean; state: string; detail: string } {
	if (status === null) return { found: false, state: "…", detail: "looking for your install" };
	if (status.status === "notFound") {
		return {
			found: false,
			state: "not found",
			detail: status.searched.length === 0 ? "nowhere to look" : status.searched.join(" · ")
		};
	}
	return {
		found: true,
		state: status.fromOverride ? "path set" : "detected",
		detail: status.root
	};
}
