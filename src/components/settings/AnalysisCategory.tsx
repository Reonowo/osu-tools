// analysis: which marks get drawn over the replay, across the two surfaces
// that draw them. two subgroups under one category because they answer one
// question -- this is the only category that earns subheads

import { SectionLabel } from "@/components/panels/SectionLabel";
import { ToggleRow } from "@/components/settings/ToggleRow";
import { NumberField } from "@/components/ui/number-field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { DISPLAY_LENGTH_MAX, DISPLAY_LENGTH_MIN, PLAYFIELD_GRID_SPACINGS } from "@/state/defaults";
import { useViewerStore, type OverlaySettings, type TimelineSettings } from "@/state/store";

export const OVERLAY_TOGGLES: { key: keyof OverlaySettings; label: string; description: string }[] = [
	{
		key: "clickMarkers",
		label: "show click markers",
		description: "draws a dot on the playfield wherever a press landed, within the display length below"
	},
	{
		key: "frameMarkers",
		label: "show frame markers",
		description: "draws one dot per replay frame, so sample density and pauses are visible"
	},
	{
		key: "tintIdleMarkers",
		label: "tint idle frame markers",
		description: "darkens the dot of a frame with no button held, which otherwise blends into the cursor path"
	},
	{
		key: "cursorPath",
		label: "show cursor path",
		description: "traces the line the cursor travelled through the display length below"
	},
	{
		key: "hideCursor",
		label: "hide gameplay cursor",
		description: "hides the cursor and its trail so the path and markers read clearly on their own"
	},
	{ key: "keyOverlay", label: "show key overlay", description: "the K1/K2/M1/M2 press counters beside the playfield" }
];

// mirrors settings.rs TimelinePrefs -- the timeline dock's per-layer
// visibility. the selected press's extended tether is selection chrome and
// stays visible whatever these say
export const TIMELINE_TOGGLES: { key: keyof TimelineSettings; label: string; description: string }[] = [
	{
		key: "hitWindowBands",
		label: "show hit-window bands",
		description: "the great/ok/meh timing bands behind each object on the object lane"
	},
	{
		key: "tethers",
		label: "show tethers",
		description:
			"the hairline joining each object to the press that judged it, its length the hit error; the selected press's extended tether always draws"
	},
	{
		key: "nestedMarks",
		label: "show slider heads, repeats and tails",
		description: "the marks inside each slider's span for the moments that demand an input"
	},
	{
		key: "severityTicks",
		label: "show severity ticks",
		description: "the miss/meh/ok marks on the whole-replay overview strip, taller meaning worse"
	}
];

export function AnalysisCategory({
	draftLength,
	onDraftChange,
	onCommit
}: {
	draftLength: number | null;
	onDraftChange: (value: number | null) => void;
	onCommit: (value: number | null) => void;
}) {
	const overlays = useViewerStore((s) => s.overlays);
	const setOverlay = useViewerStore((s) => s.setOverlay);
	const timeline = useViewerStore((s) => s.timeline);
	const setTimeline = useViewerStore((s) => s.setTimeline);

	return (
		<div className="grid gap-4">
			<section className="space-y-2">
				<SectionLabel>playfield</SectionLabel>
				{OVERLAY_TOGGLES.map(({ key, label, description }) => (
					<ToggleRow
						key={key}
						label={label}
						description={description}
						checked={overlays[key] as boolean}
						onCheckedChange={(v) => setOverlay(key, v as OverlaySettings[typeof key])}
					/>
				))}
				{/* display length sits with the playfield group: it governs the
				    three overlays above it, not the timeline's layers */}
				<label className="flex items-center justify-between gap-4 text-sm">
					display length
					<span className="flex items-center gap-2">
						<Tooltip>
							<TooltipTrigger render={<span />}>
								<NumberField
									min={DISPLAY_LENGTH_MIN}
									max={DISPLAY_LENGTH_MAX}
									step={50}
									largeStep={200}
									value={draftLength}
									onValueChange={onDraftChange}
									onValueCommitted={onCommit}
								/>
							</TooltipTrigger>
							<TooltipContent side="left">
								how much replay either side of the playhead the three overlays above cover, in
								milliseconds
							</TooltipContent>
						</Tooltip>
						<span className="text-zinc-400">ms</span>
					</span>
				</label>

				{/* one enum rather than a flag plus a size: off is a spacing, so
				    the setting cannot reach an incoherent state.
				    a div, not a label like the row above: base ui's toggle items
				    are buttons, which are labelable, so a label would forward a
				    click on this text to the first item and silently set the grid
				    to off. Transport.tsx's rate group is bare for the same reason;
				    the display-length row gets away with a label because a
				    NumberField is a real input */}
				<div className="flex items-center justify-between gap-4 text-sm">
					<span>playfield grid</span>
					<Tooltip>
						<TooltipTrigger render={<span />}>
							<ToggleGroup
								aria-label="playfield grid"
								value={[String(overlays.playfieldGrid)]}
								onValueChange={(next) => {
									// base-ui's group value is array-valued even in
									// single-select mode, and clicking the active item
									// empties it -- the group stays controlled by the
									// preference, so an empty result is ignored rather
									// than clearing it (Transport.tsx's rate group
									// carries the same note)
									const chosen = next[0];
									if (chosen !== undefined) setOverlay("playfieldGrid", Number(chosen));
								}}
								className="h-[26px] rounded-[7px] border border-border bg-[#131316] p-0.5"
							>
								{PLAYFIELD_GRID_SPACINGS.map((spacing) => (
									<ToggleGroupItem
										key={spacing}
										value={String(spacing)}
										className="h-full rounded-[5px] px-2 text-[10.5px] text-[#71717a] aria-pressed:bg-primary aria-pressed:font-bold aria-pressed:text-primary-foreground"
									>
										{spacing === 0 ? "off" : spacing}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</TooltipTrigger>
						<TooltipContent side="left">
							a reference grid over the playfield at this spacing in osu!px, plus the playfield's own
							border. it never snaps anything -- snapping is the lattice's job
						</TooltipContent>
					</Tooltip>
				</div>
			</section>

			<section className="space-y-2">
				<SectionLabel>timeline</SectionLabel>
				{TIMELINE_TOGGLES.map(({ key, label, description }) => (
					<ToggleRow
						key={key}
						label={label}
						description={description}
						checked={timeline[key]}
						onCheckedChange={(v) => setTimeline(key, v)}
					/>
				))}
			</section>
		</div>
	);
}
