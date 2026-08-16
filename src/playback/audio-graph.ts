// the one WebAudio graph every sound in this app passes through:
//
//     music element -> MediaElementAudioSourceNode -.
//                                                    +-> master gain -> output
//     scheduled hit samples -> hitsound gain -------'
//
// one tree so the three volume channels compose by construction (effective
// gain is master x channel, and zero anywhere is the mute) rather than by two
// unrelated mechanisms that have to be kept agreeing.
//
// every level decision this makes is pure and lives in audio-levels.ts; what
// is left here is the part `bun test` cannot run, so this module builds
// nothing at import time and degrades to silence rather than throwing when
// there is no AudioContext to be had

import { channelGain, type VolumeLevels } from "./audio-levels";

/**
 * hit samples never decode above this, whatever the output device runs at.
 *
 * `decodeAudioData` resamples into whichever context decodes, so on a 192kHz
 * device every 44.1kHz hitsound file inflates more than fourfold -- and the
 * store's byte budget (`engine::limits::MAX_SAMPLE_BYTES`) is charged on
 * DECODED pcm, so it is spent more than four times as fast. that made the same
 * map fit on one machine and go silent on another: one heavily hitsounded map
 * measured 93MB at 44.1kHz and 405MB at 192kHz against the 256MiB cap, and
 * since the store remembers a refusal permanently, 64 of its 215 sample files
 * were silent for the whole session -- every note using them, all play long.
 *
 * 48kHz because a hit sample is a 44.1kHz file whose content stops well under
 * that Nyquist: there is nothing in a hitsound above 24kHz to lose. an
 * `AudioBufferSourceNode` resamples a buffer whose rate differs from its
 * context, so playback on a higher-rate device is unchanged
 */
export const MAX_SAMPLE_DECODE_RATE = 48000;

/** the rate hit samples decode at: the output device's own, capped. a device
 * BELOW the cap decodes natively rather than being upsampled to meet it, which
 * would spend memory to add nothing */
export function sampleDecodeRate(outputRate: number): number {
	if (!Number.isFinite(outputRate) || outputRate <= 0) return MAX_SAMPLE_DECODE_RATE;
	return Math.min(outputRate, MAX_SAMPLE_DECODE_RATE);
}

/** a context that exists only to decode: it is never rendered, so one frame of
 * one channel is the whole of it. null where there is no `OfflineAudioContext`
 * (or it refuses the rate), which falls the caller back to the output context
 * -- the behaviour before the cap existed, and inflated rather than silent */
function offlineDecoder(rate: number): BaseAudioContext | null {
	if (typeof OfflineAudioContext === "undefined") return null;
	try {
		return new OfflineAudioContext(1, 1, rate);
	} catch {
		return null;
	}
}

export class AudioGraph {
	private context: AudioContext | null = null;
	private master: GainNode | null = null;
	private music: GainNode | null = null;
	private hitsound: GainNode | null = null;
	/** an element may be routed exactly once in its lifetime
	 * (createMediaElementSource throws on a second call), so the node is kept
	 * beside the element it was made from and both are dropped together */
	private musicSource: MediaElementAudioSourceNode | null = null;
	private musicElement: HTMLAudioElement | null = null;
	private levels: VolumeLevels = { master: 100, music: 100, hitsound: 100 };
	private unavailable = false;
	/** what hit samples decode through -- deliberately NOT the output context;
	 * see MAX_SAMPLE_DECODE_RATE. built on the first decode and kept, because
	 * every sample has to land at one rate for the budget to mean anything */
	private decoder: BaseAudioContext | null = null;

	/** builds the graph on first use and returns it, or null when this
	 * environment has no WebAudio (headless tests, and any webview that ever
	 * drops it). callers treat null as "no sound", never as an error */
	private ensure(): AudioContext | null {
		if (this.context !== null) return this.context;
		if (this.unavailable) return null;
		const Ctor = typeof AudioContext === "undefined" ? undefined : AudioContext;
		if (Ctor === undefined) {
			this.unavailable = true;
			return null;
		}
		const context = new Ctor();
		this.master = context.createGain();
		this.music = context.createGain();
		this.hitsound = context.createGain();
		this.music.connect(this.master);
		this.hitsound.connect(this.master);
		this.master.connect(context.destination);
		this.context = context;
		this.applyLevels();
		return context;
	}

	/** the node scheduled hit samples connect to. null when there is no graph,
	 * which is the scheduler's cue to schedule nothing */
	get hitsoundDestination(): AudioNode | null {
		this.ensure();
		return this.hitsound;
	}

	/** the clock for scheduling, in seconds. null when there is no graph */
	get currentTime(): number | null {
		return this.ensure()?.currentTime ?? null;
	}

	/**
	 * decode hit-sample bytes into a buffer, at the capped rate.
	 *
	 * rejects when this environment has no audio at all, which the store
	 * already reads as "this sample is silent" rather than as a load failure.
	 * an `AudioBuffer` belongs to no context, so one decoded here plays
	 * perfectly well on the output graph
	 */
	async decodeSample(bytes: ArrayBuffer): Promise<AudioBuffer> {
		const output = this.ensure();
		if (output === null) throw new Error("no audio context");
		if (this.decoder === null) {
			this.decoder = offlineDecoder(sampleDecodeRate(output.sampleRate)) ?? output;
		}
		return this.decoder.decodeAudioData(bytes);
	}

	/** an AudioContext created before the first user gesture starts suspended;
	 * every path that is about to make a sound calls this first */
	resume(): void {
		const context = this.ensure();
		if (context !== null && context.state === "suspended") void context.resume().catch(() => {});
	}

	/**
	 * routes a music element into the graph, replacing whatever was routed
	 * before. pass null on teardown.
	 *
	 * the element MUST already have `crossOrigin = "anonymous"` set, before its
	 * src: tauri's asset protocol answers with an explicit
	 * `Access-Control-Allow-Origin` for the window's origin
	 * (tauri/src/protocol/asset.rs:21), and without the request opting into
	 * CORS the element loads in no-cors mode, which taints the source node and
	 * makes it output SILENCE rather than failing loudly. PlayerView owns that
	 * and this comment is the reason it looks unnecessary there
	 */
	attachMusic(element: HTMLAudioElement | null): void {
		if (element === this.musicElement) return;
		this.musicSource?.disconnect();
		this.musicSource = null;
		this.musicElement = null;
		if (element === null) return;

		const context = this.ensure();
		if (context === null || this.music === null) return;
		try {
			this.musicSource = context.createMediaElementSource(element);
		} catch {
			// already routed (a caller reusing an element), or the element is in
			// a state this webview refuses to route. leaving it unrouted means it
			// plays at its own element volume, outside the gain tree -- audible
			// rather than silent, which is the better failure
			return;
		}
		this.musicSource.connect(this.music);
		this.musicElement = element;
		// the element's own volume stays at 1 for its whole life: the music
		// channel is the gain node, and two places setting level would fight
		element.volume = 1;
	}

	setLevels(levels: VolumeLevels): void {
		this.levels = levels;
		if (this.context === null) return;
		this.applyLevels();
	}

	private applyLevels(): void {
		if (this.master === null || this.music === null || this.hitsound === null) return;
		// the master node carries 1 and the two children carry the product: a
		// scheduled sample's gain is then decided entirely at the moment it is
		// scheduled, so a level change mid-playback moves music and future
		// samples without retroactively re-gaining sounds already in flight
		this.master.gain.value = 1;
		this.music.gain.value = channelGain(this.levels.master, this.levels.music);
		this.hitsound.gain.value = channelGain(this.levels.master, this.levels.hitsound);
	}
}

/** the app's single graph. a module singleton for the same reason
 * playbackClock is one: there is exactly one output device and one set of
 * levels, and every consumer must be talking about the same one */
export const audioGraph = new AudioGraph();
