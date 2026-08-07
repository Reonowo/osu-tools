// the small uppercase tracked heading every panel body uses above a
// sub-section (the score card, the frame table, the locked list, ...);
// shared here rather than copied per panel since the four sibling panels'
// copies were byte-for-byte identical

import type { ReactNode } from "react";

export function SectionLabel({ children }: { children: ReactNode }) {
	return <div className="text-[9.5px] font-semibold tracking-[.14em] text-[#8a8a93] uppercase">{children}</div>;
}
