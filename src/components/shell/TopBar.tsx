// the docked top bar: identity, the loaded beatmap/player line, mod chips,
// and the watch/edit switcher plus the edit-history controls

import { ChevronDown, Clapperboard, Download, FileDown, Redo2, Settings2, Undo2 } from "lucide-react";
import { useState } from "react";
import type { SettingsCategory } from "@/components/settings/categories";
import { OpenMenu } from "@/components/shell/OpenMenu";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatTime } from "@/lib/format";
import { modChipLabels } from "@/lib/metadata-panel";
import { exportMenuEntries } from "@/lib/video-export-flow";
import { keybindSuffix } from "@/playback/keybinds";
import { useViewerStore, type ViewerMode } from "@/state/store";

// osu!'s own logotype slant, reused for the identity tile and every mod chip;
// glyphs inside get the mirrored skew so their text stays upright
const LOGO_SKEW = "skew-x-brand";
const LOGO_COUNTER_SKEW = "skew-x-brand-inverse";

// the "R" tile + wordmark, shared verbatim with StartScreen's header so the
// skew constants above stay defined in exactly one place
export function Identity() {
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			<div className={`flex size-btn-jump ${LOGO_SKEW} items-center justify-center rounded-control bg-primary`}>
				<span className={`${LOGO_COUNTER_SKEW} text-xs font-bold text-primary-foreground`}>R</span>
			</div>
			<span className="text-wordmark font-semibold uppercase text-foreground-dim">replay viewer</span>
		</div>
	);
}

/** the export split as a labelled menu: entries come from the pure module
 * (lib/video-export-flow.ts), so the gate's answer is tested headless and
 * this component only renders it */
function ExportMenu({
	onOpenExportReplay,
	onOpenExportVideo
}: {
	onOpenExportReplay: () => void;
	onOpenExportVideo: () => void;
}) {
	const scene = useViewerStore((s) => s.scene);
	const [open, setOpen] = useState(false);
	const entries = scene === null ? [] : exportMenuEntries(scene);
	const onOpen: Record<string, () => void> = {
		replay: onOpenExportReplay,
		video: onOpenExportVideo
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Tooltip>
				<TooltipTrigger
					render={
						<PopoverTrigger
							render={
								<Button size="sm" variant="secondary" className="gap-1 pr-1.5">
									<Download /> export
									<ChevronDown className="size-3 opacity-60" />
								</Button>
							}
						/>
					}
				/>
				<TooltipContent>write the current document to a .osr, or render it to a video</TooltipContent>
			</Tooltip>
			<PopoverContent align="end" className="w-menu-w gap-0.5 p-1.5">
				{entries.map((entry) => {
					const row = (
						<button
							key={entry.id}
							type="button"
							disabled={entry.disabledReason !== null}
							onClick={() => {
								setOpen(false);
								onOpen[entry.id]();
							}}
							className="flex w-full items-center gap-2 rounded-card px-2.5 py-2 text-left text-title font-medium text-foreground hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
						>
							{entry.id === "replay" ? (
								<FileDown className="size-3.5 text-foreground-dim" />
							) : (
								<Clapperboard className="size-3.5 text-foreground-dim" />
							)}
							{entry.label}
						</button>
					);
					if (entry.disabledReason === null) return row;
					// a natively disabled button suppresses mouse events, so the
					// reason tooltip listens on a span around it
					return (
						<Tooltip key={entry.id}>
							<TooltipTrigger render={<span className="block w-full" />}>{row}</TooltipTrigger>
							<TooltipContent>{entry.disabledReason}</TooltipContent>
						</Tooltip>
					);
				})}
			</PopoverContent>
		</Popover>
	);
}

export function TopBar({
	onOpenSettings,
	onOpenExportReplay,
	onOpenExportVideo
}: {
	onOpenSettings: (category?: SettingsCategory) => void;
	onOpenExportReplay: () => void;
	onOpenExportVideo: () => void;
}) {
	const scene = useViewerStore((s) => s.scene);
	const derived = useViewerStore((s) => s.derived);
	const mode = useViewerStore((s) => s.mode);
	const setMode = useViewerStore((s) => s.setMode);
	const editor = useViewerStore((s) => s.editor);
	const undoEdit = useViewerStore((s) => s.undoEdit);
	const redoEdit = useViewerStore((s) => s.redoEdit);
	const keybinds = useViewerStore((s) => s.effectiveKeybinds);

	// AppShell only mounts once App.tsx has a loaded scene, so these are
	// always populated in practice -- the fallbacks just keep this component
	// well-typed against the store's nullable fields without reshaping the DOM
	const title = scene?.beatmap.title ?? "";
	const version = scene?.beatmap.version ?? "";
	const artist = scene?.beatmap.artist ?? "";
	const playerName = scene?.replay.playerName ?? "unknown";
	const duration = formatTime(derived?.bounds.maxTime ?? 0).split(".")[0];
	// the EFFECTIVE mods, never the legacy bitfield -- the same rule the status
	// bar and the metadata panel read. a lazer-only mod has no legacy bit, so
	// the bitfield would chip "NM" for a play the rest of the chrome names
	const modChips = scene === null ? ["NM"] : modChipLabels(scene);

	return (
		<header className="flex min-w-0 items-center border-b border-border bg-surface-bar px-2 pl-2.5">
			<Identity />

			{/* between the identity tile and the separator. the beatmap/player
			block below was considered as the trigger and rejected on a concrete
			ground: it carries select-text because metadata is a deliberate copy
			opt-in (index.css), and making it a button destroys drag-to-select */}
			<div className="ml-2 shrink-0">
				<OpenMenu />
			</div>

			<Separator orientation="vertical" className="mx-3 h-6" />

			{/* beatmap/player -- select-text: metadata is a copy opt-in (index.css) */}
			<div className="flex min-w-0 flex-col gap-px select-text">
				<div className="truncate text-display-sm font-semibold text-foreground-bright">
					{title} <span className="text-lede-plain font-medium text-primary-hover">[{version}]</span>
				</div>
				<div className="truncate text-caption-plain text-foreground-dim">
					{artist} <span className="text-foreground-ghost">·</span> {playerName}{" "}
					<span className="text-foreground-ghost">·</span> <span className="tabular-nums">{duration}</span>
				</div>
			</div>

			{/* mod chips */}
			<div className="ml-3 flex shrink-0 items-center gap-1">
				{modChips.map((chip) => (
					<div
						key={chip}
						className={`flex h-chip ${LOGO_SKEW} items-center rounded bg-surface-raised px-1.5`}
					>
						<span className={`${LOGO_COUNTER_SKEW} text-mini-label font-bold text-foreground-soft`}>
							{chip}
						</span>
					</div>
				))}
			</div>

			<div className="ml-auto flex shrink-0 items-center gap-2">
				<ToggleGroup
					value={[mode]}
					onValueChange={(next) => {
						// base-ui's toggle group value is an array even in single-select
						// mode, and clicking the already-active item empties it -- the
						// group stays controlled by `mode`, so an empty result is just
						// ignored rather than clearing the switcher
						const nextMode = next[0] as ViewerMode | undefined;
						if (nextMode) setMode(nextMode);
					}}
					className="h-7 rounded-lg border border-border bg-surface-sunken p-0.5"
				>
					{/* chrome-indicator-colour: the highlight fades across rather than
					flipping, so the toggle moves like the panel slide it triggers.
					data-motion-row shell, because this mark lives in the shell
					(index.css) */}
					<ToggleGroupItem
						value="watch"
						data-motion-row="shell"
						className="chrome-indicator-colour h-6 rounded-md px-card-loose text-lede-plain font-semibold text-foreground-dim aria-pressed:bg-primary aria-pressed:text-primary-foreground"
					>
						watch
					</ToggleGroupItem>
					<ToggleGroupItem
						value="edit"
						data-motion-row="shell"
						className="chrome-indicator-colour h-6 rounded-md px-card-loose text-lede-plain font-semibold text-foreground-dim aria-pressed:bg-primary aria-pressed:text-primary-foreground"
					>
						edit
					</ToggleGroupItem>
				</ToggleGroup>

				<Separator orientation="vertical" className="h-6" />

				{/* undo/redo are icon-only *and* disabled when there's nothing to do,
				so the span wrapper is load-bearing here for the reason the export
				button's no longer is: a natively disabled button suppresses mouse
				events outright, and the tooltip is the only thing that can say
				what the next step would be */}
				{(() => {
					const labels = editor?.history.labels ?? [];
					const cursor = editor?.history.cursor ?? 0;
					const nextUndo = cursor > 0 ? labels[cursor - 1] : null;
					const nextRedo = cursor < labels.length ? labels[cursor] : null;
					return (
						<div className="flex items-center gap-1">
							<Tooltip>
								<TooltipTrigger render={<span />}>
									<Button
										size="icon-sm"
										variant="ghost"
										aria-label="undo"
										disabled={editor?.canUndo !== true}
										onClick={() => void undoEdit()}
									>
										<Undo2 />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{nextUndo !== null ? `undo ${nextUndo}` : "nothing to undo"}
									{keybindSuffix(keybinds, "undo")}
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger render={<span />}>
									<Button
										size="icon-sm"
										variant="ghost"
										aria-label="redo"
										disabled={editor?.canRedo !== true}
										onClick={() => void redoEdit()}
									>
										<Redo2 />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									{nextRedo !== null ? `redo ${nextRedo}` : "nothing to redo"}
									{keybindSuffix(keybinds, "redo")}
								</TooltipContent>
							</Tooltip>
						</div>
					);
				})()}

				{editor?.dirty === true && (
					<Tooltip>
						<TooltipTrigger render={<span />}>
							<span className="rounded-full border border-primary/40 bg-primary-wash-strong px-2 py-0.5 text-meta text-primary">
								unsaved edits
							</span>
						</TooltipTrigger>
						<TooltipContent>
							this document differs from the file on disk; export writes the edited version
						</TooltipContent>
					</Tooltip>
				)}

				{/* the export button is a two-entry menu: the replay export and
				the video export each open their own dialog. the video entry can
				be gated (a consented-mismatch scene renders nothing an external
				renderer could resolve), so it disables in place with the reason
				-- the same posture the editing panels take */}
				<ExportMenu onOpenExportReplay={onOpenExportReplay} onOpenExportVideo={onOpenExportVideo} />

				<Tooltip>
					<TooltipTrigger
						render={
							// no category: reopens wherever the user last was
							<Button
								size="icon-sm"
								variant="ghost"
								aria-label="settings"
								onClick={() => onOpenSettings()}
							>
								<Settings2 />
							</Button>
						}
					/>
					<TooltipContent>
						stable install path, analysis overlays, effects and editing preferences
					</TooltipContent>
				</Tooltip>
			</div>
		</header>
	);
}
