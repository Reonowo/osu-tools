import { describe, expect, test } from "bun:test";
import { channelGain, FALLBACK_UNMUTE_VOLUME, speakerState, toggleMute } from "./audio-levels";

describe("channelGain", () => {
	test("is the product of the two linear percents", () => {
		expect(channelGain(100, 100)).toBe(1);
		expect(channelGain(50, 50)).toBe(0.25);
		expect(channelGain(70, 100)).toBeCloseTo(0.7, 10);
	});

	test("zero on either side is the mute", () => {
		// the whole point of a product rather than two independent volumes:
		// music to 0 silences music without touching hitsounds, and a master of
		// 0 silences everything
		expect(channelGain(0, 100)).toBe(0);
		expect(channelGain(100, 0)).toBe(0);
	});

	test("a hand-edited settings file cannot push a gain past unity", () => {
		expect(channelGain(900, 100)).toBe(1);
		expect(channelGain(100, -40)).toBe(0);
		expect(channelGain(Number.NaN, 100)).toBe(0);
	});
});

describe("speakerState", () => {
	test("scales by the master while anything is audible", () => {
		expect(speakerState({ master: 100, music: 100, hitsound: 100 })).toBe("high");
		expect(speakerState({ master: 50, music: 100, hitsound: 100 })).toBe("high");
		expect(speakerState({ master: 49, music: 100, hitsound: 100 })).toBe("low");
		expect(speakerState({ master: 1, music: 100, hitsound: 100 })).toBe("low");
	});

	test("a zero master is muted whatever the channels say", () => {
		expect(speakerState({ master: 0, music: 100, hitsound: 100 })).toBe("muted");
	});

	test("both channels at zero is muted even at a loud master", () => {
		// the clause that earns the rule: master 70 with both children silent is
		// a 70% slider and total silence, and a glyph reading "70%" there would
		// be lying about the only thing it exists to say
		expect(speakerState({ master: 70, music: 0, hitsound: 0 })).toBe("muted");
	});

	test("one channel alive is not muted", () => {
		expect(speakerState({ master: 70, music: 0, hitsound: 100 })).toBe("high");
		expect(speakerState({ master: 20, music: 100, hitsound: 0 })).toBe("low");
	});
});

describe("toggleMute", () => {
	test("unmutes to the level the mute replaced, not to a default", () => {
		// the whole reason the mute remembers anything: coming back to some
		// other volume is losing the user's place
		const muted = toggleMute(37, null);
		expect(muted).toEqual({ volume: 0, mutedFrom: 37 });
		expect(toggleMute(muted.volume, muted.mutedFrom)).toEqual({ volume: 37, mutedFrom: null });
	});

	test("a second mute remembers the newer level", () => {
		// mute, unmute, drag the slider somewhere else, mute again
		const first = toggleMute(80, null);
		const back = toggleMute(first.volume, first.mutedFrom);
		expect(back.volume).toBe(80);
		const second = toggleMute(25, back.mutedFrom);
		expect(second).toEqual({ volume: 0, mutedFrom: 25 });
	});

	test("unmuting with nothing to restore still makes a sound", () => {
		// launched already muted, so the session never saw a level to come back
		// to -- restoring silence would read as a dead button
		expect(toggleMute(0, null).volume).toBe(FALLBACK_UNMUTE_VOLUME);
	});

	test("a remembered zero is not a level to come back to", () => {
		// the slider dragged to 0 and then the speaker clicked twice: the first
		// click has nothing but silence to remember
		expect(toggleMute(0, 0).volume).toBe(FALLBACK_UNMUTE_VOLUME);
	});
});
