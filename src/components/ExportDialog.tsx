// the replay export flow. task 8 left this a stub; every control here stays
// inert until the replay-document ipc and the score/hp-drain ports it needs
// land (TODO.md), except cancel -- the dialog still has to open and close
// like a real one

import { Check, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SectionLabel } from "@/components/panels/SectionLabel";
import { useViewerStore } from "@/state/store";

const REGENERATED_FIELDS: { label: string; warning?: boolean }[] = [
	{ label: "hit counts" },
	{ label: "geki / katu" },
	{ label: "max combo" },
	{ label: "perfect flag" },
	{ label: "total score" },
	{ label: "life bar (empty)", warning: true }
];

export function ExportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	// the loaded replay's own path stands in for the destination row -- there
	// is no export target to compute yet, and this is the only real path on
	// hand rather than a fabricated one
	const osrPath = useViewerStore((s) => s.osrPath);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[452px]">
				<DialogHeader>
					<DialogTitle>export replay</DialogTitle>
					<DialogDescription>
						every derived header field is regenerated from the recomputed judgement timeline. nothing is
						carried over from the source.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-2">
					<SectionLabel>destination</SectionLabel>
					<div className="flex items-center gap-2 text-sm">
						<Input disabled readOnly value={osrPath ?? ""} className="min-w-0 flex-1" />
						<Button size="sm" variant="secondary" disabled>
							browse
						</Button>
					</div>
				</div>

				<div className="rounded-[9px] border border-border bg-surface-card px-3 py-[9px]">
					<SectionLabel>regenerated fields</SectionLabel>
					<div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-[7px]">
						{REGENERATED_FIELDS.map(({ label, warning }) => {
							const Icon = warning ? TriangleAlert : Check;
							return (
								<span key={label} className="flex items-center gap-1.5 text-[11px] text-[#8a8a93]">
									<Icon
										className={
											warning
												? "size-3 shrink-0 text-[#ffcc22]"
												: "size-3 shrink-0 text-[#88b300]"
										}
										aria-hidden
									/>
									{label}
								</span>
							);
						})}
					</div>
				</div>

				<div className="flex items-start gap-2 rounded-[9px] border border-[rgba(245,158,11,.35)] bg-[rgba(69,26,3,.55)] px-3 py-2.5 text-[10.5px] leading-[1.55] text-[#fbbf24]">
					<TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
					<p>
						export is not wired yet: regenerating total score needs the OsuLegacyScoreSimulator port tracked
						in TODO.md, and the life bar needs an HP-drain port. until both land, a dirty document could
						only be written with fields that describe a different play.
					</p>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						cancel
					</Button>
					<Button disabled>export .osr</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
