// general: the osu! stable install path, and the app chrome's own motion.
// later, the custom Songs directory and the resolved-install status -- both
// bespoke controls like the path one, which is why the install half of this
// category still covers no per-key pref (categories.ts)

import { SectionLabel } from "@/components/panels/SectionLabel";
import { ToggleRow } from "@/components/settings/ToggleRow";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { motionChoice, motionPreference, selectMotion, type MotionChoice } from "@/lib/motion";
import { useViewerStore, type InterfaceSettings } from "@/state/store";

// the master's three states, in the order they read as a scale: defer to the
// system, then the two explicit answers
const MOTION_STATES: { value: MotionChoice; label: string }[] = [
	{ value: "system", label: "system" },
	{ value: "on", label: "on" },
	{ value: "off", label: "off" }
];

// the rows the master gates -- mirrors settings.rs InterfacePrefs minus the
// master itself, which has its own control above them
export const MOTION_TOGGLES: { key: keyof InterfaceSettings; label: string; description: string }[] = [
	{
		key: "comboPop",
		label: "combo counter pop",
		description:
			"the watch HUD's combo counter scales up on every increment and flashes red on a break. the pop's phase is the replay's own time, so a seek lands mid-pop and a pause holds it"
	}
];

/** shown instead of a gated row's own description while the master is off:
 * the row explains what is stopping it, not what it would do. the gameplay
 * category's effects rows use the same substitution */
const MASTER_OFF = "interface motion is off; this keeps its setting and applies again when it is switched back on";

export function GeneralCategory({
	saving,
	onPickInstall
}: {
	/** a path write is in flight, so both buttons are locked. owned by the
	 * dialog rather than by this panel: the panels unmount on a category
	 * switch, and a lock that unmounted with its panel would be gone by the
	 * time the write it guards resolves */
	saving: boolean;
	onPickInstall: () => void;
}) {
	const settings = useViewerStore((s) => s.settings);
	const saveStablePath = useViewerStore((s) => s.saveStablePath);
	const interfacePrefs = useViewerStore((s) => s.interface);
	const setInterface = useViewerStore((s) => s.setInterface);
	// the resolved master, off the one resolver every consumer reads: `system`
	// resolves against the live OS query, so the rows below gate themselves the
	// moment the user changes their system setting, with no preference change
	const motionOn = useViewerStore(selectMotion);

	return (
		<div className="grid gap-4">
			<section className="space-y-2">
				<SectionLabel>osu! install</SectionLabel>
				<div className="flex items-center gap-2 text-sm">
					<code className="min-w-0 flex-1 truncate rounded bg-zinc-800 px-2 py-1 text-xs">
						{settings?.osuStablePath ?? "auto-detect"}
					</code>
					<Button size="sm" variant="secondary" disabled={saving} onClick={onPickInstall}>
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
				<SectionLabel>motion</SectionLabel>
				{/* a div rather than a label: base ui's toggle items are buttons,
				    which are labelable, so a label would forward a click on this
				    text to the first item and silently pick `system` (the analysis
				    category's playfield grid carries the same note) */}
				<div className="flex items-center justify-between gap-4 text-sm">
					<span>interface motion</span>
					<Tooltip>
						<TooltipTrigger render={<span />}>
							<ToggleGroup
								aria-label="interface motion"
								value={[motionChoice(interfacePrefs.motion)]}
								onValueChange={(next) => {
									// base-ui's group value is array-valued even in
									// single-select mode, and clicking the active item
									// empties it -- the group stays controlled by the
									// preference, so an empty result is ignored rather
									// than clearing it
									const chosen = next[0];
									if (chosen !== undefined) {
										setInterface("motion", motionPreference(chosen as MotionChoice));
									}
								}}
								className="h-[26px] rounded-[7px] border border-border bg-[#131316] p-0.5"
							>
								{MOTION_STATES.map(({ value, label }) => (
									<ToggleGroupItem
										key={value}
										value={value}
										className="h-full rounded-[5px] px-2 text-[10.5px] text-[#71717a] aria-pressed:bg-primary aria-pressed:font-bold aria-pressed:text-primary-foreground"
									>
										{label}
									</ToggleGroupItem>
								))}
							</ToggleGroup>
						</TooltipTrigger>
						<TooltipContent side="left">
							the master for the app's own animation — the combo pop, and every dialog, popover and hover
							transition in the chrome. `system` follows your OS reduce-motion setting as it changes; on
							and off override it. the playfield's gameplay effects have their own master in the gameplay
							category, and loading spinners keep spinning either way
						</TooltipContent>
					</Tooltip>
				</div>
				{MOTION_TOGGLES.map(({ key, label, description }) => (
					<ToggleRow
						key={key}
						label={label}
						description={motionOn ? description : MASTER_OFF}
						checked={interfacePrefs[key] as boolean}
						disabled={!motionOn}
						onCheckedChange={(v) => setInterface(key, v as InterfaceSettings[typeof key])}
					/>
				))}
			</section>
		</div>
	);
}
