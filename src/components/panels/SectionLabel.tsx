// the small uppercase tracked heading every panel body uses above a
// sub-section (the score card, the frame table, the locked list, ...);
// shared here rather than copied per panel since the four sibling panels'
// copies were byte-for-byte identical

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn("text-section-label font-semibold text-muted-foreground uppercase", className)}>
			{children}
		</div>
	);
}
