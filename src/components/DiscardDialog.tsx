// the discard prompt: what stands between a request to open a replay and the
// destruction of an edited document. mounted at the app root beside
// MismatchDialog, and for the same reason -- it has to cover drop, which
// belongs to no component and is the easiest way to perform this by accident.
//
// only openReplay raises it, so this asks its question once per request; the
// mismatch override and the beatmap picker that can follow a confirmed discard
// load without a second dialog (state/store.ts).
//
// it deliberately counts nothing. the history is capped and evicts from the
// front, so "12 edits" would understate a long session -- and a number that can
// be wrong is worse here than no number at all

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

export function DiscardDialog() {
	const pending = useViewerStore((s) => s.pendingOpen);
	const confirm = useViewerStore((s) => s.confirmDiscard);
	const dismiss = useViewerStore((s) => s.dismissDiscard);

	return (
		<Dialog
			open={pending !== null}
			onOpenChange={(o) => {
				if (!o) dismiss();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>discard your unsaved edits?</DialogTitle>
					<DialogDescription className="space-y-2">
						<span className="block">
							opening another replay replaces this document. the edits you have made go with it, and so
							does the undo history — nothing brings either back.
						</span>
						<span className="block">export this replay first if you want to keep them.</span>
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={dismiss}>
						cancel
					</Button>
					<Button variant="destructive" onClick={() => void confirm()}>
						discard edits and open
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
