// gameplay: what the replay itself looks like -- the background dim, then the
// effects master and the five rows it gates. skinning lands here when it does
// (TODO.md)

import { SectionLabel } from "@/components/panels/SectionLabel";
import { ToggleRow } from "@/components/settings/ToggleRow";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BACKGROUND_DIM_MAX, BACKGROUND_DIM_MIN } from "@/state/defaults";
import { useViewerStore, type EffectSettings } from "@/state/store";

// the master first, then the five it gates -- mirrors settings.rs EffectPrefs.
// backgroundDim rides on the same group but is not one of these: it has its
// own row above, outside this registry, so the master never disables it
export const EFFECT_TOGGLES: { key: keyof EffectSettings; label: string; description: string }[] = [
	{
		key: "enabled",
		label: "gameplay effects",
		description:
			"the master switch for the five effects below it -- the background dim above is not an effect and keeps applying. turning it off hides them all at once and keeps each one's own setting, so they come back exactly as you left them"
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

export function GameplayCategory() {
	const effects = useViewerStore((s) => s.effects);
	const setEffect = useViewerStore((s) => s.setEffect);

	return (
		<div className="grid gap-4">
			{/* above the effects rather than below them: placed under the master
			    it would read as gated by it, which it deliberately is not */}
			<section className="space-y-2">
				<SectionLabel>background</SectionLabel>
				<label className="flex items-center justify-between gap-4 text-sm">
					background dim
					<span className="flex items-center gap-2">
						<Tooltip>
							<TooltipTrigger render={<span />}>
								<Slider
									// shrink-0 keeps the track from collapsing to its
									// thumb inside the flex row (Transport.tsx's volume
									// slider carries the same note)
									className="w-[110px] shrink-0"
									aria-label="background dim"
									min={BACKGROUND_DIM_MIN}
									max={BACKGROUND_DIM_MAX}
									step={1}
									value={[effects.backgroundDim]}
									onValueChange={(v) => setEffect("backgroundDim", Array.isArray(v) ? v[0] : v)}
								/>
							</TooltipTrigger>
							<TooltipContent side="left">
								how far the beatmap background is darkened; 100 is fully black. objects, cursor and
								overlays are drawn above it and stay at full brightness
							</TooltipContent>
						</Tooltip>
						<span className="w-[30px] text-right font-mono text-[10.5px] text-[#71717a] tabular-nums">
							{effects.backgroundDim}%
						</span>
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
							// the group now carries one number, so the registry's
							// value type is boolean | number -- the same cast the
							// analysis category makes around display length
							checked={effects[key] as boolean}
							disabled={gated}
							onCheckedChange={(v) => setEffect(key, v as EffectSettings[typeof key])}
						/>
					);
				})}
			</section>
		</div>
	);
}
