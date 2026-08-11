import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { NumberField } from "@/components/ui/number-field";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { open } from "@tauri-apps/plugin-dialog";
import { SectionLabel } from "@/components/panels/SectionLabel";
import { DISPLAY_LENGTH_MAX, DISPLAY_LENGTH_MIN } from "@/state/defaults";
import { useViewerStore, type EditingSettings, type EffectSettings, type OverlaySettings } from "@/state/store";

const OVERLAY_TOGGLES: { key: keyof OverlaySettings; label: string; description: string }[] = [
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

const EDITING_TOGGLES: { key: keyof EditingSettings; label: string; description: string }[] = [
	{
		key: "snapToLattice",
		label: "snap frame edits to input lattice",
		description: "rounds edited coordinates onto the grid this replay's own untouched frames sit on"
	},
	{
		key: "warnOnOverwrite",
		label: "warn before overwriting a replay",
		description: "asks first when an export would replace an existing .osr"
	}
];

// the master first, then the five it gates -- mirrors settings.rs EffectPrefs
const EFFECT_TOGGLES: { key: keyof EffectSettings; label: string; description: string }[] = [
	{
		key: "enabled",
		label: "gameplay effects",
		description:
			"the master switch for the five below. turning it off hides them all at once and keeps each one's own setting, so they come back exactly as you left them"
	},
	{
		key: "hitAnimations",
		label: "hit animations",
		description: "the circle's explosion on being hit, and the slider tick and reverse-arrow pops"
	},
	{
		key: "hitEffects",
		label: "hit effects",
		description: "the judgement text and its ring burst; the objects themselves are unaffected"
	},
	{ key: "cursorGlow", label: "cursor glow", description: "the additive halo behind the cursor's centre dot" },
	{ key: "cursorTrail", label: "cursor trail", description: "the fading streak the cursor leaves as it moves" },
	{
		key: "followPoints",
		label: "follow points",
		description: "the chevrons connecting consecutive objects in a combo"
	}
];

/** shown instead of a granular effect's own description while the master is
 * off: the row explains what is stopping it, not what it would do */
const MASTER_OFF = "gameplay effects are off; this keeps its setting and applies again when they are switched back on";

/** the trigger is a wrapping span, not the switch: a natively disabled
 * element fires no hover events, so the tooltip would never open on the rows
 * that most need one (ToolPalette.tsx uses the same wrapper for the same
 * reason). focus still reaches the switch inside and bubbles to the span */
function ToggleRow({
	label,
	description,
	checked,
	disabled,
	onCheckedChange
}: {
	label: string;
	description: string;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (value: boolean) => void;
}) {
	return (
		<label className="flex items-center justify-between text-sm">
			<span className={disabled ? "text-zinc-500" : undefined}>{label}</span>
			<Tooltip>
				<TooltipTrigger render={<span />}>
					<Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
				</TooltipTrigger>
				<TooltipContent side="left">{description}</TooltipContent>
			</Tooltip>
		</label>
	);
}

export function SettingsDialog({ open: isOpen, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
	const settings = useViewerStore((s) => s.settings);
	const overlays = useViewerStore((s) => s.overlays);
	const setOverlay = useViewerStore((s) => s.setOverlay);
	const editing = useViewerStore((s) => s.editing);
	const setEditing = useViewerStore((s) => s.setEditing);
	const effects = useViewerStore((s) => s.effects);
	const setEffect = useViewerStore((s) => s.setEffect);
	const loadSettings = useViewerStore((s) => s.loadSettings);
	const saveStablePath = useViewerStore((s) => s.saveStablePath);
	const [saving, setSaving] = useState(false);

	// the field holds its own draft so a half-typed "5" of "500" is not clamped
	// to the 200 floor between keystrokes; the store only sees committed values
	// (blur, stepper press, arrow key) and clamps them there
	const displayLength = overlays.displayLength;
	const [draftLength, setDraftLength] = useState<number | null>(displayLength);
	useEffect(() => setDraftLength(displayLength), [displayLength]);

	function commitLength(value: number | null) {
		// an emptied field commits null: restore the last good value rather than
		// leaving the input blank with the store silently unchanged
		if (value === null) setDraftLength(displayLength);
		else setOverlay("displayLength", value);
	}

	useEffect(() => {
		if (isOpen) void loadSettings();
	}, [isOpen, loadSettings]);

	async function pickInstall() {
		const dir = await open({ directory: true, multiple: false });
		if (typeof dir !== "string") return;
		setSaving(true);
		await saveStablePath(dir).finally(() => setSaving(false));
	}

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-md">
				<DialogHeader>
					<DialogTitle>settings</DialogTitle>
				</DialogHeader>

				{/* the sections outgrow the shortest supported window (tauri.conf.json
				    pins minHeight 640) and already overrun the default one. the popup
				    is fixed and centred, so anything past the viewport edge cannot be
				    scrolled to at all -- it has to scroll within itself. horizontal
				    overflow is clipped the way every panel body clips it: the switch
				    control's deliberately oversized hit target pokes past this box,
				    and without the clip that gap becomes a scrollbar */}
				<div className="grid gap-4 overflow-x-hidden overflow-y-auto">
					<section className="space-y-2">
						<SectionLabel>osu! stable install</SectionLabel>
						<div className="flex items-center gap-2 text-sm">
							<code className="min-w-0 flex-1 truncate rounded bg-zinc-800 px-2 py-1 text-xs">
								{settings?.osuStablePath ?? "auto-detect"}
							</code>
							<Button size="sm" variant="secondary" disabled={saving} onClick={() => void pickInstall()}>
								browse
							</Button>
							<Button
								size="sm"
								variant="ghost"
								disabled={saving || settings?.osuStablePath == null}
								onClick={() => void saveStablePath(null)}
							>
								reset
							</Button>
						</div>
					</section>

					<section className="space-y-2">
						<SectionLabel>analysis overlays</SectionLabel>
						{OVERLAY_TOGGLES.map(({ key, label, description }) => (
							<ToggleRow
								key={key}
								label={label}
								description={description}
								checked={overlays[key] as boolean}
								onCheckedChange={(v) => setOverlay(key, v as OverlaySettings[typeof key])}
							/>
						))}
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
											onValueChange={setDraftLength}
											onValueCommitted={commitLength}
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
					</section>

					<section className="space-y-2">
						<SectionLabel>effects</SectionLabel>
						{EFFECT_TOGGLES.map(({ key, label, description }) => {
							// the granular rows go disabled under a switched-off master,
							// but their stored values stay exactly as the user left them
							const gated = key !== "enabled" && !effects.enabled;
							return (
								<ToggleRow
									key={key}
									label={label}
									description={gated ? MASTER_OFF : description}
									checked={effects[key]}
									disabled={gated}
									onCheckedChange={(v) => setEffect(key, v)}
								/>
							);
						})}
					</section>

					<section className="space-y-2">
						<SectionLabel>editing</SectionLabel>
						{EDITING_TOGGLES.map(({ key, label, description }) => (
							<ToggleRow
								key={key}
								label={label}
								description={description}
								checked={editing[key]}
								onCheckedChange={(v) => setEditing(key, v)}
							/>
						))}
						<p className="text-xs text-zinc-500">
							the lattice is inferred per replay from its own untouched frames. turning snapping off
							produces coordinates no real client would emit.
						</p>
					</section>
				</div>
			</DialogContent>
		</Dialog>
	);
}
