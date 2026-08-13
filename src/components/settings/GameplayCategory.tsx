// gameplay: what the replay itself looks like -- the effects master and the
// five rows it gates. skinning lands here when it does (TODO.md)

import { ToggleRow } from "@/components/settings/ToggleRow";
import { useViewerStore, type EffectSettings } from "@/state/store";

// the master first, then the five it gates -- mirrors settings.rs EffectPrefs
export const EFFECT_TOGGLES: { key: keyof EffectSettings; label: string; description: string }[] = [
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

export function GameplayCategory() {
	const effects = useViewerStore((s) => s.effects);
	const setEffect = useViewerStore((s) => s.setEffect);

	return (
		<div className="space-y-2">
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
		</div>
	);
}
