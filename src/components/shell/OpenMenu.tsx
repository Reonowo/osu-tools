// the top bar's open menu: the app's one in-session surface for getting a
// different replay in. before it, `scene` went non-null on the first load and
// nothing ever put it back, so the start screen -- which held the only browse
// button and the only rendering of the recents -- became unreachable for the
// life of the process.
//
// the trigger is LABELLED, not another icon-only ghost button: undiscoverability
// is the bug being fixed, and this app is already full of icon-only ghost
// buttons that did not stop the user concluding the feature was absent. the
// chevron is what makes it read as a menu rather than a one-shot action, which
// is what suggests there is something behind it.
//
// the open state lives in the store because Ctrl+O registers at the App root
// (it has to work on the start screen too, where this component does not
// mount), which is above this popover's own lifetime

import { ChevronDown, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RecentEntry } from "@/components/RecentEntry";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { menuRecents } from "@/lib/open-menu";
import { pickReplay } from "@/lib/openers";
import { keybindSuffix } from "@/playback/keybinds";
import { useViewerStore } from "@/state/store";

export function OpenMenu() {
	const open = useViewerStore((s) => s.openMenuOpen);
	const setOpen = useViewerStore((s) => s.setOpenMenuOpen);
	const settings = useViewerStore((s) => s.settings);
	const loading = useViewerStore((s) => s.loading);
	const osrPath = useViewerStore((s) => s.osrPath);
	const openReplay = useViewerStore((s) => s.openReplay);
	const keybinds = useViewerStore((s) => s.effectiveKeybinds);

	// minus the replay already loaded -- the rule and its reasons live in
	// lib/open-menu.ts, where a headless test can hold them
	const recents = menuRecents(settings?.recents ?? [], osrPath);
	// read per render rather than ticked: the popover re-renders when it opens,
	// which is the only moment these relative labels are looked at
	const nowMs = Date.now();

	function openAndClose(path: string) {
		// closed first, so the app gets on with the load instead of narrating it.
		// failures surface on the existing error toast and leave the current
		// scene up, so there is nothing for the popover to stay open for
		setOpen(false);
		void openReplay(path);
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button size="sm" variant="ghost" className="gap-1 pr-1.5 text-[#a1a1aa]">
									<FolderOpen />
									open
									<ChevronDown className="size-3 text-[#71717a]" />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>
					browse for a replay, or reopen a recent one{keybindSuffix(keybinds, "openMenu")}
				</TooltipContent>
			</Tooltip>

			{/* wider than the primitive's w-72: the rows below were built for the
			start screen's 400px aside and are rendered here verbatim. the popup's
			own cap is the backstop -- the list's cap below is what actually
			scrolls, and this keeps the whole thing inside a short window */}
			<PopoverContent align="start" className="max-h-[calc(100dvh-5rem)] w-[340px] gap-1.5 p-1.5">
				{/* first, and the first focusable row, so Ctrl+O then Enter reaches
				the OS file picker. disabled while a load is in flight, mirroring
				the start screen's browse button */}
				<button
					type="button"
					disabled={loading}
					onClick={() => {
						setOpen(false);
						void pickReplay();
					}}
					className="flex w-full shrink-0 items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-[12px] font-medium text-[#e4e4e7] hover:bg-[#16161a] disabled:cursor-not-allowed disabled:opacity-50"
				>
					<FolderOpen className="size-3.5 text-[#71717a]" />
					{loading ? "loading…" : "browse…"}
				</button>

				<Separator className="shrink-0" />

				<div className="shrink-0 px-2.5 text-[10px] font-semibold tracking-[.08em] text-[#71717a] uppercase">
					recent
				</div>
				{recents.length === 0 ? (
					// in the start screen's voice: a fact, not a failure
					<p className="px-2.5 py-2 text-center text-[11px] text-[#71717a]">
						nothing else opened yet — browse for one
					</p>
				) : (
					// ~4 rows visible, so a longer history reads as scrollable rather
					// than as the whole list. the cap is what keeps twelve entries
					// from producing a popover taller than the window
					<ScrollArea className="min-h-0 max-h-[236px]">
						<div className="flex flex-col">
							{recents.map((entry) => (
								<RecentEntry key={entry.osrPath} entry={entry} nowMs={nowMs} onOpen={openAndClose} />
							))}
						</div>
					</ScrollArea>
				)}
			</PopoverContent>
		</Popover>
	);
}
