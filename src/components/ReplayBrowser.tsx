// the replay browser: one dialog over every replay stable knows about --
// its local leaderboards' plays out of `Data/r`, and the install's own
// Replays folder -- as one newest-first list with a search box and a source
// toggle.
//
// the thin shell over `lib/replay-browser.ts`, which owns every decision this
// makes: the matching, the source filter, the loaded mark, the title fallback
// and the footer. what is here is layout, the keyboard flow, and one call to
// the store's single `openReplay` -- so a click from this dialog reaches the
// beatmap association, the stable lookup, the mismatch consent and the
// discard prompt exactly as a drop or a recents card does (docs/adr/0005).
//
// app-rooted like the help overlay and mounted for the app's lifetime, since
// its keybind registers at the App root and has to work on the start screen

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { FolderSearch, HardDrive, Settings2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatAccuracy, formatMods } from "@/lib/format";
import {
	browserFooter,
	isLoadedRow,
	rowDifficulty,
	rowTitle,
	visibleRows,
	type BrowserSourceFilter
} from "@/lib/replay-browser";
import type { BrowserRow } from "@/lib/scene-types";
import { cn } from "@/lib/utils";
import { describeIpcError } from "@/state/errors";
import { useViewerStore } from "@/state/store";

/** one row's height in the virtual list. a constant rather than a measurement
 * because every row is the same two lines, and measuring thousands of them
 * would cost exactly what virtualising is meant to save */
const ROW_HEIGHT = 52;

const SOURCE_FILTERS: { value: BrowserSourceFilter; label: string }[] = [
	{ value: "both", label: "all" },
	{ value: "localPlay", label: "local plays" },
	{ value: "replaysFolder", label: "Replays" }
];

export function ReplayBrowser({ onOpenSettings }: { onOpenSettings: () => void }) {
	const open = useViewerStore((s) => s.browserOpen);
	const setOpen = useViewerStore((s) => s.setBrowserOpen);
	const listing = useViewerStore((s) => s.browserListing);
	const error = useViewerStore((s) => s.browserError);
	const status = useViewerStore((s) => s.stableStatus);
	const osrPath = useViewerStore((s) => s.osrPath);
	const openReplay = useViewerStore((s) => s.openReplay);

	const [query, setQuery] = useState("");
	const [source, setSource] = useState<BrowserSourceFilter>("both");
	// which row the arrows are on, -1 meaning "the search box has it". an
	// index into the VISIBLE rows, reset whenever that list changes shape
	const [cursor, setCursor] = useState(-1);
	const searchRef = useRef<HTMLInputElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	// every open starts clean: the toggle resets to both, so a narrowed list
	// never persists into a later session by surprise, and the search box takes
	// focus because typing is what this dialog is for
	useEffect(() => {
		if (!open) return;
		setQuery("");
		setSource("both");
		setCursor(-1);
	}, [open]);

	const rows = useMemo(
		() => visibleRows(listing?.rows ?? [], query, source, osrPath),
		[listing, query, source, osrPath]
	);
	const footer = listing === null ? null : browserFooter(listing, rows.length);

	const virtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => ROW_HEIGHT,
		overscan: 8
	});

	// a narrowed list can be shorter than the cursor was; clamping here rather
	// than in every handler keeps the invariant in one place
	useEffect(() => {
		setCursor((current) => (current >= rows.length ? rows.length - 1 : current));
	}, [rows.length]);

	function move(delta: number) {
		const next = Math.min(rows.length - 1, Math.max(-1, cursor + delta));
		setCursor(next);
		if (next < 0) searchRef.current?.focus();
		else virtualizer.scrollToIndex(next);
	}

	function openRow(row: BrowserRow) {
		// closed first, exactly as the open menu does: the app gets on with
		// the load instead of narrating it, and a failure surfaces on the
		// existing error toast over whatever scene is up
		setOpen(false);
		void openReplay(row.path);
	}

	function onKeyDown(e: React.KeyboardEvent) {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			move(1);
		} else if (e.key === "ArrowUp") {
			e.preventDefault();
			move(-1);
		} else if (e.key === "Enter" && cursor >= 0) {
			e.preventDefault();
			const row = rows[cursor];
			if (row !== undefined) openRow(row);
		} else if (
			// any printable key returns to the search box, so narrowing the
			// list never needs the mouse. modified chords are left alone --
			// they belong to the app's own accelerators
			cursor >= 0 &&
			e.key.length === 1 &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey
		) {
			setCursor(-1);
			searchRef.current?.focus();
		}
	}

	const noInstall = status !== null && status.status === "notFound";

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogContent
				className="flex h-[min(680px,calc(100dvh-4rem))] w-[min(760px,calc(100vw-4rem))] max-w-none flex-col gap-3 p-0 sm:max-w-none"
				onKeyDown={onKeyDown}
				// the search box, not the popup: typing is what this dialog is
				// for, and a user who has to click into the field first has been
				// handed a list rather than a finder
				initialFocus={searchRef}
			>
				<DialogHeader className="px-4 pt-4">
					<DialogTitle className="flex items-center gap-2">
						<FolderSearch className="size-4 text-[#71717a]" />
						browse local replays
					</DialogTitle>
				</DialogHeader>

				{noInstall ? (
					<NoInstall searched={status.searched} onOpenSettings={onOpenSettings} />
				) : (
					<>
						<div className="flex items-center gap-2 px-4">
							<Input
								ref={searchRef}
								value={query}
								placeholder="search by artist, title, difficulty or player…"
								onChange={(e) => {
									setQuery(e.target.value);
									setCursor(-1);
								}}
								className="h-8 flex-1 text-[12px]"
							/>
							<ToggleGroup
								aria-label="replay source"
								value={[source]}
								onValueChange={(next) => {
									const chosen = next[0];
									// base-ui empties the value when the active item is
									// clicked; the group stays controlled by this state,
									// so an empty result is ignored (GeneralCategory's
									// motion group carries the same note)
									if (chosen !== undefined) setSource(chosen as BrowserSourceFilter);
								}}
								className="h-8 shrink-0 rounded-[7px] border border-border bg-[#131316] p-0.5"
							>
								{SOURCE_FILTERS.map(({ value, label }) => (
									<ToggleGroupItem
										key={value}
										value={value}
										className="h-full rounded-[5px] px-2 text-[10.5px] text-[#71717a] aria-pressed:bg-primary aria-pressed:font-bold aria-pressed:text-primary-foreground"
									>
										{label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</div>

						<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2">
							{/* no listing at all means "not read yet", whether or not a
							read is in flight this instant — saying "none found" for a
							question that has not been asked is how an empty list reads
							as an answer */}
							{listing === null ? (
								<p className="px-2.5 py-6 text-center text-[11px] text-[#71717a]">
									reading your replays…
								</p>
							) : rows.length === 0 ? (
								<p className="px-2.5 py-6 text-center text-[11px] text-[#71717a]">
									{(listing?.rows.length ?? 0) === 0
										? "no replays found in your osu! install"
										: "nothing matches that search"}
								</p>
							) : (
								<div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
									{virtualizer.getVirtualItems().map((item) => {
										const row = rows[item.index];
										if (row === undefined) return null;
										return (
											<div
												key={row.path}
												className="absolute top-0 left-0 w-full"
												style={{
													height: item.size,
													transform: `translateY(${item.start}px)`
												}}
											>
												<BrowserRowButton
													row={row}
													focused={item.index === cursor}
													loaded={isLoadedRow(row, osrPath)}
													onOpen={openRow}
												/>
											</div>
										);
									})}
								</div>
							)}
						</div>

						<div className="flex flex-col gap-1 border-t border-border bg-muted/40 px-4 py-2 font-mono text-[10px] text-[#71717a]">
							{error !== null && (
								<span className="text-destructive">{describeIpcError(error).title}</span>
							)}
							{footer !== null && <span>{footer.counts}</span>}
							{footer?.notes.map((note) => (
								<span key={note} className="text-amber-500/80">
									{note}
								</span>
							))}
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** the no-install state: what was looked at, and the one click that fixes it */
function NoInstall({ searched, onOpenSettings }: { searched: string[]; onOpenSettings: () => void }) {
	return (
		<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
			<HardDrive className="size-7 text-[#71717a]" />
			<p className="text-[13px] font-medium text-[#e4e4e7]">no osu! stable install found</p>
			<p className="text-[11.5px] leading-[1.55] text-[#71717a]">
				this browser lists the plays your osu! client records and the replays in its Replays folder, so it needs
				to know where that install is.
			</p>
			{searched.length > 0 && (
				<div className="max-w-full font-mono text-[10px] text-[#5a5a63]">
					looked in:
					{searched.map((path) => (
						<div key={path} className="truncate">
							{path}
						</div>
					))}
				</div>
			)}
			<Button size="sm" variant="secondary" onClick={onOpenSettings} className="mt-1 gap-1.5">
				<Settings2 className="size-3.5" />
				set the install path
			</Button>
		</div>
	);
}

/** one row: title line, then the play's own facts. shaped like a recents
 * card on purpose -- the browser and the recents are one vocabulary */
function BrowserRowButton({
	row,
	focused,
	loaded,
	onOpen
}: {
	row: BrowserRow;
	focused: boolean;
	loaded: boolean;
	onOpen: (row: BrowserRow) => void;
}) {
	const difficulty = rowDifficulty(row);
	return (
		<button
			type="button"
			onClick={() => onOpen(row)}
			className={cn(
				"flex h-full w-full flex-col justify-center gap-1 rounded-[9px] border border-transparent px-2.5 text-left hover:bg-[#16161a]",
				focused && "border-border-strong bg-[#16161a]",
				// a play whose beatmap has left the library still opens -- the
				// picker is one dialog away -- so it is greyed, never disabled
				!row.titled && "opacity-60"
			)}
		>
			<div className="flex min-w-0 items-center gap-1.5">
				<span className="truncate text-[12px] font-medium text-[#e4e4e7]">
					{rowTitle(row)}
					{difficulty !== null && <span className="text-[#71717a]"> [{difficulty}]</span>}
				</span>
				{loaded && (
					<Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[9px]">
						open
					</Badge>
				)}
				{row.mods !== 0 && (
					<Badge variant="secondary" className="h-4 shrink-0 px-1.5 font-mono text-[9px]">
						{formatMods(row.mods)}
					</Badge>
				)}
				{row.lazerWritten && (
					<Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[9px]">
						lazer
					</Badge>
				)}
			</div>
			<div className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] text-[#71717a]">
				<span className="truncate">
					{row.playerName ?? "unknown"} · {formatAccuracy(row.accuracy)} · {row.maxCombo}x · {row.date}
				</span>
				<span className="ml-auto shrink-0 text-[9px] text-[#5a5a63]">
					{row.source === "localPlay" ? "local play" : "Replays"}
				</span>
			</div>
		</button>
	);
}
