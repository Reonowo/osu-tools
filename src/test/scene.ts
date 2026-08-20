import type { LoadedScene } from "../lib/scene-types";

export function testScene(overrides: Partial<LoadedScene> = {}): LoadedScene {
	return {
		epoch: 1,
		beatmap: {
			title: "t",
			artist: "a",
			creator: "c",
			version: "v",
			beatmapId: 1,
			beatmapSetId: 1,
			formatVersion: 14,
			audioLeadIn: 1500,
			circleSize: 4,
			approachRate: 9,
			overallDifficulty: 5,
			hpDrainRate: 5,
			md5: "m"
		},
		replay: {
			playerName: "p",
			version: 20240101,
			mods: 0,
			count300: 1,
			count100: 0,
			count50: 0,
			countGeki: 0,
			countKatsu: 0,
			countMiss: 0,
			totalScore: 300,
			maxCombo: 1,
			perfect: true,
			timestampTicks: "0",
			onlineScoreId: "0",
			beatmapMd5: "m"
		},
		frames: [
			{ time: -1200, x: 0, y: 0, buttons: 0 },
			{ time: 980, x: 100, y: 100, buttons: 1 },
			{ time: 1100, x: 100, y: 100, buttons: 0 }
		],
		renderPlan: {
			playfield: { width: 512, height: 384 },
			comboColours: [[241, 116, 0, 255]],
			hitWindows: { great: 49.5, ok: 99.5, meh: 149.5, miss: 400 },
			scale: 0.5,
			preempt: 600,
			fadeIn: 400,
			objects: [
				{
					startTime: 1000,
					endTime: 1000,
					position: [100, 100],
					stackHeight: 0,
					comboColourIndex: 1,
					comboIndex: 1,
					indexInCombo: 0,
					preempt: 600,
					fadeIn: 400,
					samples: [],
					kind: { type: "circle" }
				}
			]
		},
		simulation: {
			status: "authoritative",
			events: [
				{
					time: 980,
					objectIndex: 0,
					kind: { type: "circle", grade: "ok" },
					comboAfter: 1,
					accuracyAfter: 100 / 300
				}
			],
			totals: { count300: 0, count100: 1, count50: 0, countMiss: 0, maxCombo: 1 }
		},
		audioPath: null,
		backgroundPath: null,
		sampleFiles: {},
		textureFiles: {},
		warnings: [],
		integrity: null,
		incompleteness: null,
		...overrides
	};
}
