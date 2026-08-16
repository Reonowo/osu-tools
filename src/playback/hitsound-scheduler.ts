// the lookahead scheduler: turns the hitsound plan into `start(when)` calls on
// the audio graph, a window at a time.
//
// scheduling ahead is not an optimisation here, it is the requirement -- a
// sound placed by the rAF loop lands wherever the frame lands, which is up to a
// frame of jitter on every hit. WebAudio's own clock is sample-accurate, so
// every sample is handed to it slightly early with the exact time it should
// start, and the graph does the rest.
//
// the windowing and the beatmap-time -> context-time mapping are pure and live
// at the top of this file; everything below `HitsoundScheduler` is the part
// that needs an AudioContext.

import type { AudioGraph } from "./audio-graph";
import type { ScheduledSample } from "./hitsound-plan";
import { resolveSample, type SampleSource } from "./sample-sources";
import type { SampleStore } from "./sample-store";

/** how far ahead of the playhead samples are handed to the audio clock. long
 * enough that a stalled frame cannot starve it (three 60Hz frames is 50ms),
 * short enough that a seek never has much to throw away */
export const LOOKAHEAD_MS = 250;

/** how far the mapping may drift before it is re-taken. the playback clock
 * interpolates against the music element while samples are placed on the
 * AudioContext's clock, and the two are only nominally the same device -- over
 * a five-minute map even a hundredth of a percent is tens of milliseconds of
 * slide between a hit sound and its circle. 20ms is inside the tightest hit
 * window, so a correction can never be heard as a jump */
export const ANCHOR_DRIFT_MS = 20;

/** what maps a beatmap time onto the audio clock: the two times that were the
 * same instant, and the rate they are running at relative to each other */
export interface ClockAnchor {
	/** beatmap ms at the anchor instant */
	beatmapTime: number;
	/** AudioContext.currentTime (seconds) at that same instant */
	contextTime: number;
	/** playback rate; 2 means beatmap time runs twice as fast as real time */
	rate: number;
}

/**
 * the AudioContext time at which a beatmap time will arrive.
 *
 * a rate of 0 (or worse) has no answer -- nothing is arriving -- so it reports
 * null rather than an infinity that would be handed to `start()`
 */
export function contextTimeFor(beatmapTime: number, anchor: ClockAnchor): number | null {
	if (!(anchor.rate > 0) || !Number.isFinite(anchor.rate)) return null;
	const seconds = (beatmapTime - anchor.beatmapTime) / 1000 / anchor.rate;
	const at = anchor.contextTime + seconds;
	return Number.isFinite(at) ? at : null;
}

/**
 * the slice of a time-ordered plan that falls in `[from, until)`, plus the
 * index to resume from.
 *
 * the cursor is an index rather than a time so a run of samples sharing one
 * millisecond -- a stack of objects judged on the same frame -- is fully
 * consumed instead of being re-scheduled or skipped on the next window
 */
export function windowOf(
	plan: readonly ScheduledSample[],
	fromIndex: number,
	from: number,
	until: number
): { items: ScheduledSample[]; nextIndex: number } {
	let index = Math.max(0, fromIndex);
	// anything already behind the window is gone: a sample whose time has
	// passed is not played late, it is not played. the ear notices a hit sound
	// arriving after the hit far more than one missing
	while (index < plan.length && plan[index].time < from) index += 1;
	const items: ScheduledSample[] = [];
	while (index < plan.length && plan[index].time < until) {
		items.push(plan[index]);
		index += 1;
	}
	return { items, nextIndex: index };
}

/** where the cursor has to restart after a seek: the first sample at or after
 * the new time. binary search, because a seek to the end of a long map would
 * otherwise walk the whole plan */
export function indexAtOrAfter(plan: readonly ScheduledSample[], time: number): number {
	let low = 0;
	let high = plan.length;
	while (low < high) {
		const mid = (low + high) >> 1;
		if (plan[mid].time < time) low = mid + 1;
		else high = mid;
	}
	return low;
}

/** the beatmap time the anchor says it is now, given the audio clock. the
 * inverse of `contextTimeFor`, and what the drift check compares against */
export function beatmapTimeAt(contextTime: number, anchor: ClockAnchor): number {
	return anchor.beatmapTime + (contextTime - anchor.contextTime) * 1000 * anchor.rate;
}

/** whether the mapping has slid far enough to be worth re-taking. re-anchoring
 * only moves where FUTURE samples are placed -- the cursor is monotonic and
 * every window starts at the playhead, so nothing already scheduled is
 * disturbed and nothing is scheduled twice */
export function anchorHasDrifted(anchor: ClockAnchor, beatmapTime: number, contextTime: number): boolean {
	return Math.abs(beatmapTimeAt(contextTime, anchor) - beatmapTime) > ANCHOR_DRIFT_MS;
}

export interface SchedulerDeps {
	graph: Pick<AudioGraph, "hitsoundDestination" | "currentTime">;
	store: Pick<SampleStore, "get">;
	sources: () => readonly SampleSource[];
}

/**
 * the imperative half. holds the plan, a cursor into it, and the nodes it has
 * started; `update` is driven from the app's one rAF loop and `flush` is the
 * "everything you scheduled is wrong now" button every discontinuity presses.
 */
export class HitsoundScheduler {
	private plan: readonly ScheduledSample[] = [];
	private cursor = 0;
	private anchor: ClockAnchor | null = null;
	private started: AudioScheduledSourceNode[] = [];
	private enabled = true;
	private lastSeekVersion: number | null = null;
	private wasPlaying = false;

	constructor(private readonly deps: SchedulerDeps) {}

	/** the currently simulated play's sounds. replacing the plan flushes:
	 * every edit re-derives the judgement timeline, and what was scheduled
	 * describes a simulation that no longer exists */
	setPlan(plan: readonly ScheduledSample[]): void {
		this.plan = plan;
		this.flush();
	}

	/** whether hit samples may be scheduled at all. false while the aggregate
	 * hitsound volume is zero (skinnablesound skips a zero-volume sample rather
	 * than playing it), and while the user is scrubbing or frame-stepping --
	 * dragging the playhead across a stream must not machine-gun, and stepping
	 * is an analysis action rather than a listening one */
	setEnabled(enabled: boolean): void {
		if (enabled === this.enabled) return;
		this.enabled = enabled;
		if (!enabled) this.flush();
	}

	/** stop and forget everything already handed to the audio clock. called on
	 * every seek, rate change and landed edit: those all move sounds that were
	 * scheduled against the old mapping */
	flush(): void {
		this.lastSeekVersion = null;
		this.wasPlaying = false;
		this.stopStarted();
		this.anchor = null;
		this.cursor = 0;
	}

	/** stop what is queued and forget the mapping, WITHOUT moving the plan
	 * cursor -- the anchor going null is what makes the next playing frame
	 * recompute the cursor from where the playhead actually is */
	private silence(): void {
		this.stopStarted();
		this.anchor = null;
	}

	private stopStarted(): void {
		for (const node of this.started) {
			try {
				node.stop();
			} catch {
				// a node that already finished throws on stop; nothing to undo
			}
			node.disconnect();
		}
		this.started = [];
	}

	/**
	 * schedule everything now due, given where the playhead is.
	 *
	 * PAUSING IS NOT PASSIVE. `AudioContext.currentTime` runs on the audio
	 * device and knows nothing about this transport, so a node already handed
	 * to it with `start(when)` fires at that instant whether or not the replay
	 * is still playing -- pausing mid-stream would otherwise keep hitsounding
	 * for a whole lookahead window over silent music. the pause drops the
	 * anchor too, so resuming recomputes the cursor: the window that was
	 * already consumed has to be re-entered, or the first quarter-second after
	 * un-pausing comes back silent.
	 *
	 * a paused clock is what makes frame-stepping silent -- stepping is an
	 * analysis action, not a listening one.
	 *
	 * `seekVersion` is what keeps a SCRUB silent. dragging the playhead while
	 * playing is a seek per pointer move, and scheduling a fresh 250ms window
	 * at each one would machine-gun through a stream; a frame whose seek
	 * version moved schedules nothing at all. no settle constant is needed --
	 * the first frame with no new seek sounds again, so releasing the drag
	 * resumes immediately
	 */
	update(beatmapTime: number, rate: number, playing: boolean, seekVersion: number): void {
		if (!playing) {
			if (this.wasPlaying) this.silence();
			this.wasPlaying = false;
			return;
		}
		this.wasPlaying = true;
		if (!this.enabled || this.plan.length === 0) return;
		if (seekVersion !== this.lastSeekVersion) {
			const first = this.lastSeekVersion === null;
			this.lastSeekVersion = seekVersion;
			this.silence();
			// the very first frame after a flush is not a seek -- there was
			// nothing to seek away from -- so it schedules normally
			if (!first) return;
		}
		const destination = this.deps.graph.hitsoundDestination;
		const contextTime = this.deps.graph.currentTime;
		if (destination === null || contextTime === null) return;

		// a rate change moves every sound already handed to the audio clock,
		// because each was placed through the old mapping. that is a flush and
		// a reschedule, not a re-anchor
		if (this.anchor !== null && this.anchor.rate !== rate) {
			this.silence();
		}
		if (this.anchor === null) {
			this.anchor = { beatmapTime, contextTime, rate };
			this.cursor = indexAtOrAfter(this.plan, beatmapTime);
		} else if (anchorHasDrifted(this.anchor, beatmapTime, contextTime)) {
			// the mapping alone -- the cursor stays exactly where it is, so a
			// correction can neither replay a sample nor skip one
			this.anchor = { beatmapTime, contextTime, rate };
		}

		const { items, nextIndex } = windowOf(this.plan, this.cursor, beatmapTime, beatmapTime + LOOKAHEAD_MS * rate);
		this.cursor = nextIndex;
		for (const item of items) {
			const at = contextTimeFor(item.time, this.anchor);
			if (at === null) continue;
			this.start(item, Math.max(at, contextTime), destination);
		}
	}

	private start(item: ScheduledSample, at: number, destination: AudioNode): void {
		const answer = resolveSample(this.deps.sources(), item.request);
		// "answered, with nothing" is a decision the source made and is
		// respected exactly like a decline is: either way there is nothing to
		// play. what must never happen is falling through PAST an empty answer,
		// and that is the chain's job, not this one's
		if (answer.answer !== "found") return;
		const buffer = this.deps.store.get(answer.value.url);
		// still decoding: silent rather than late. a hit sound that arrives
		// after its hit is worse than one that does not arrive
		if (buffer === null) return;

		const context = destination.context;
		const source = context.createBufferSource();
		source.buffer = buffer;
		const gain = context.createGain();
		gain.gain.value = item.gain;
		// StereoPannerNode is the closest thing the platform has to
		// osu-framework's Balance, which is also a -1..1 left/right blend
		const panner = context.createStereoPanner();
		panner.pan.value = item.balance;
		source.connect(gain).connect(panner).connect(destination);
		source.onended = () => {
			panner.disconnect();
			gain.disconnect();
			this.started = this.started.filter((node) => node !== source);
		};
		source.start(at);
		this.started.push(source);
	}
}
