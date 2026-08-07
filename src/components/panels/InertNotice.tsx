// the shared "not wired yet" affordance every inert editing panel opens
// with. names exactly what unblocks the panel rather than leaving a dead
// control unexplained -- replay editing has no ipc surface yet (the engine's
// ReplayDocument exists, the tauri layer doesn't expose it), so every control
// below this notice is disabled and every value shown is real scene data

import type { ReactNode } from "react";
import { Lock } from "lucide-react";

export function InertNotice({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-start gap-2 rounded-[9px] border border-dashed border-border bg-surface-card/60 px-3 py-2.5 text-[10.5px] leading-[1.55] text-[#71717a]">
			<Lock className="mt-px size-3 shrink-0" aria-hidden />
			<p>{children}</p>
		</div>
	);
}
