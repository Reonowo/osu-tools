// the renderer status a store test's ipc stub answers with -- shared here so
// the five deps factories that need one do not each carry a copy

import type { VideoRendererStatus } from "@/lib/scene-types";

export function fakeRendererStatus(): VideoRendererStatus {
	return {
		installed: false,
		metadata: {
			id: "fake",
			name: "Fake Renderer",
			version: "1.2.3",
			downloadBytes: 42,
			source: "the test suite",
			notice: "a scripted stand-in",
			licenses: []
		},
		logPath: null
	};
}
