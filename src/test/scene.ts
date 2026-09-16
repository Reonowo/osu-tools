import type { LoadedScene, PlayConfiguration } from "../lib/scene-types";

/** the stable NoMod configuration: authoritative under its own profile with
 * every capability allowed */
export function stableConfiguration(): PlayConfiguration {
	return {
		profile: "stable",
		mods: [],
		provenance: "bitfield",
		rate: 1,
		capabilities: {
			simulate: { status: "authoritative", profile: "stable" },
			editFrames: { allowed: true },
			regenerateExport: { allowed: true }
		}
	};
}

/** the reason the engine authors for a lazer-native play judged under the
 * stable profile -- copied from configuration.rs so a test reads the same
 * words a scene would carry */
export const APPROXIMATE_REASON =
	"this lazer-native play is simulated under the stable profile as an approximation, so frame edits and a regenerating export would re-derive it under the wrong rules; metadata editing stays available";

/** the shared fixture as a lazer-native play: a lazer version, a present
 * score-info block, and the shipping resolution -- native profile,
 * authoritative under native with both gates open, the totals carrying the
 * statistics map. the same judgements and totals as testScene, so a test can
 * hold the two side by side */
export function nativeTestScene(overrides: Partial<LoadedScene> = {}): LoadedScene {
	const base = testScene();
	if (base.simulation.status !== "authoritative") throw new Error("the shared fixture simulates");
	return testScene({
		replay: nativeReplayMeta(base),
		configuration: {
			profile: "native",
			mods: [],
			provenance: "block",
			rate: 1,
			capabilities: {
				simulate: { status: "authoritative", profile: "native" },
				editFrames: { allowed: true },
				regenerateExport: { allowed: true }
			}
		},
		simulation: {
			...base.simulation,
			totals: { ...base.simulation.totals, statistics: [{ result: "ok", count: 1 }] }
		},
		...overrides
	});
}

/** the same lazer-native play under the resolver's approximate branch --
 * judged under stable as an approximation, frame edits and regeneration
 * refused with the engine's reason. no shipping configuration reaches it
 * now that the native walk has landed, but it stays a durable state, and the
 * surfaces that label it are pinned here */
export function approximateNativeTestScene(overrides: Partial<LoadedScene> = {}): LoadedScene {
	const base = testScene();
	if (base.simulation.status !== "authoritative") throw new Error("the shared fixture simulates");
	const { status: _status, ...payload } = base.simulation;
	return testScene({
		replay: nativeReplayMeta(base),
		configuration: {
			profile: "native",
			mods: [],
			provenance: "block",
			rate: 1,
			capabilities: {
				simulate: { status: "approximate", profile: "stable" },
				editFrames: { allowed: false, reason: APPROXIMATE_REASON },
				regenerateExport: { allowed: false, reason: APPROXIMATE_REASON }
			}
		},
		simulation: { status: "approximate", profile: "stable", ...payload },
		...overrides
	});
}

function nativeReplayMeta(base: LoadedScene): LoadedScene["replay"] {
	return {
		...base.replay,
		version: 30000016,
		scoreInfo: {
			status: "present",
			statistics: [
				{ result: "great", count: 1 },
				{ result: "slider_tail_hit", count: 0 }
			],
			maximumStatistics: [{ result: "great", count: 1 }],
			// the engine's fold over the two maps above: one great achieved out
			// of one great possible, the dropped tail weighing nothing on either
			// side because the maximum map does not carry one
			accuracy: 1,
			rank: "x",
			totalScoreWithoutMods: 1000000,
			clientVersion: "2026.401.0-lazer",
			onlineId: "-1",
			userId: 7,
			pauseCount: 0
		}
	};
}

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
			accuracy: 1,
			rank: "x",
			timestampTicks: "0",
			onlineScoreId: "0",
			beatmapMd5: "m",
			scoreInfo: { status: "opaque" }
		},
		configuration: stableConfiguration(),
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
			hpCurve: [],
			// the one judgement's own step: an ok at combo 0 scores its bare
			// base, so the running total is 100 from 980ms on
			scoreCurve: [[980, 100]],
			events: [
				{
					time: 980,
					objectIndex: 0,
					kind: { type: "circle", grade: "ok" },
					comboAfter: 1,
					accuracyAfter: 100 / 300
				}
			],
			totals: { count300: 0, count100: 1, count50: 0, countMiss: 0, maxCombo: 1, accuracy: 100 / 300, rank: "d" }
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
