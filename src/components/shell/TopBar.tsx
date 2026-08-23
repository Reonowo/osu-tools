// the docked top bar: identity, the loaded beatmap/player line, mod chips,
// and the watch/edit switcher plus the edit-history controls

import { Download, Redo2, Settings2, Undo2 } from "lucide-react";
import type { SettingsCategory } from "@/components/settings/categories";
import { OpenMenu } from "@/components/shell/OpenMenu";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatMods, formatTime } from "@/lib/format";
import { keybindSuffix } from "@/playback/keybinds";
import { useViewerStore, type ViewerMode } from "@/state/store";

// osu!'s own logotype slant, reused for the identity tile and every mod chip;
// glyphs inside get the mirrored skew so their text stays upright
const LOGO_SKEW = "skew-x-[-11.3deg]";
const LOGO_COUNTER_SKEW = "skew-x-[11.3deg]";

// the "R" tile + wordmark, shared verbatim with StartScreen's header so the
// skew constants above stay defined in exactly one place
export function Identity() {
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			<div className={`flex size-[22px] ${LOGO_SKEW} items-center justify-center rounded-[5px] bg-primary`}>
				<span className={`${LOGO_COUNTER_SKEW} text-xs font-bold text-primary-foreground`}>R</span>
			</div>
			<span className="text-[11px] font-semibold uppercase tracking-[.1em] text-[#71717a]">replay viewer</span>
		</div>
	);
}

export function TopBar({
	onOpenSettings,
	onOpenExport
}: {
	onOpenSettings: (category?: SettingsCategory) => void;
	onOpenExport: () => void;
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
	const mods = formatMods(scene?.replay.mods ?? 0);
	const modChips = mods === "none" ? ["NM"] : mods.split(" ");

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
				<div className="truncate text-[13.5px] font-semibold text-[#f4f4f5]">
					{title} <span className="text-[11.5px] font-medium text-[#ff87bc]">[{version}]</span>
				</div>
				<div className="truncate text-[10.5px] text-[#71717a]">
					{artist} <span className="text-[#3f3f46]">·</span> {playerName}{" "}
					<span className="text-[#3f3f46]">·</span> <span className="tabular-nums">{duration}</span>
				</div>
			</div>

			{/* mod chips */}
			<div className="ml-3 flex shrink-0 items-center gap-1">
				{modChips.map((chip) => (
					<div key={chip} className={`flex h-[19px] ${LOGO_SKEW} items-center rounded bg-[#1c1c20] px-1.5`}>
						<span className={`${LOGO_COUNTER_SKEW} text-[9.5px] font-bold tracking-[.08em] text-[#a1a1aa]`}>
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
					className="h-7 rounded-lg border border-border bg-[#131316] p-0.5"
				>
					<ToggleGroupItem
						value="watch"
						className="h-6 rounded-md px-[11px] text-[11.5px] font-semibold text-[#71717a] aria-pressed:bg-primary aria-pressed:text-primary-foreground"
					>
						watch
					</ToggleGroupItem>
					<ToggleGroupItem
						value="edit"
						className="h-6 rounded-md px-[11px] text-[11.5px] font-semibold text-[#71717a] aria-pressed:bg-primary aria-pressed:text-primary-foreground"
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
							<span className="rounded-full border border-primary/40 bg-primary/[.13] px-2 py-0.5 text-[10px] text-primary">
								unsaved edits
							</span>
						</TooltipTrigger>
						<TooltipContent>
							this document differs from the file on disk; export writes the edited version
						</TooltipContent>
					</Tooltip>
				)}

				{/* the span wrapper predates the live dialog and was load-bearing
				when this button could be disabled: a natively `disabled` button
				suppresses mouse events outright (not just via pointer-events
				css), so base-ui's hover tooltip needed a non-disabled ancestor
				to listen on. TooltipTrigger could likely target the button
				directly now, but that's unverified without a DOM pass, so the
				wrapper stays -- a working tooltip matters more than one less
				span */}
				<Tooltip>
					<TooltipTrigger render={<span />}>
						<Button size="sm" variant="secondary" onClick={onOpenExport}>
							<Download /> export
						</Button>
					</TooltipTrigger>
					<TooltipContent>write the current document to a .osr</TooltipContent>
				</Tooltip>

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
