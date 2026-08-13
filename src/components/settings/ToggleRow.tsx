// the one row shape every settings category is built from: label left,
// switch right, description in a tooltip. shared here rather than living in
// whichever category happened to need it first

import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** the trigger is a wrapping span, not the switch: a natively disabled
 * element fires no hover events, so the tooltip would never open on the rows
 * that most need one (ToolPalette.tsx uses the same wrapper for the same
 * reason). focus still reaches the switch inside and bubbles to the span */
export function ToggleRow({
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
