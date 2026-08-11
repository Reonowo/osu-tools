import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useViewerStore } from "@/state/store";

export function MismatchDialog() {
	const pending = useViewerStore((s) => s.pendingMismatch);
	const confirm = useViewerStore((s) => s.confirmMismatch);
	const dismiss = useViewerStore((s) => s.dismissMismatch);
	return (
		<Dialog
			open={pending !== null}
			onOpenChange={(o) => {
				if (!o) dismiss();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>beatmap doesn't match this replay</DialogTitle>
					{/* select-text: the two hashes are diagnostic copy opt-ins (index.css) */}
					<DialogDescription className="space-y-2 select-text">
						<span className="block">
							the replay was set on a beatmap with hash{" "}
							<code className="text-xs">{pending?.expectedMd5}</code>, but the picked file hashes to{" "}
							<code className="text-xs">{pending?.actualMd5}</code>.
						</span>
						<span className="block">
							you can load it anyway: positions and timing may be wrong, and judgements stay disabled.
						</span>
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={dismiss}>
						cancel
					</Button>
					<Button variant="destructive" onClick={() => void confirm()}>
						load anyway
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
