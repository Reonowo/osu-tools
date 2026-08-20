import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { gesturePreview } from "@/editor/preview";
import { isFullFrames, remapIndex } from "@/editor/splice";
import { audioExtendedBounds } from "@/lib/timeline";
import { audioGraph } from "@/playback/audio-graph";
import { htmlAudioAdapter } from "@/playback/clock";
import { buildHitsoundPlan } from "@/playback/hitsound-plan";
import {
	bundledSampleUrlSet,
	hitsoundScheduler,
	sampleStore,
	setBeatmapSampleSource,
	setSkinSampleSource
} from "@/playback/hitsounds";
import { beatmapSampleSource, resolveSample, sampleSources, skinSampleSource } from "@/playback/sample-sources";
import { SAMPLE_EXTENSIONS } from "@/skin/sample-extensions";
import { sameSelection } from "@/skin/picker";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import type { LoadedScene } from "@/lib/scene-types";
import { GameplayRenderer, type EditChromeSources } from "@/renderer/GameplayRenderer";
import { effectiveOverlays } from "@/state/defaults";
import { useViewerStore, viewerStore, type ViewerState } from "@/state/store";

// the one wiring of the renderer's edit-chrome getters: selection straight
// off the store, preview and shapes off the imperative gesture module. a
// module const because both attach points (renderer creation and the mode
// effect) must hand over the identical sources
const editChromeSources: EditChromeSources = {
	selection: () => viewerStore.getState().editor?.frameSelection ?? [],
	preview: () => gesturePreview.snapshot(),
	shape: () => gesturePreview.shape,
	brush: () => gesturePreview.brush
};

/** hit samples are audible only when their whole gain chain is: the master
 * times the hitsound channel. a zero anywhere is the mute, and a muted channel
 * is skipped rather than scheduled silently (skinnablesound.cs) */
function hitsoundsAudible(state: ViewerState): boolean {
	return state.volume > 0 && state.audio.hitsoundVolume > 0;
}

/**
 * rebuild the hit-sound plan for the currently simulated play and make sure
 * every sample it can ask for is decoded.
 *
 * called on every scene install and every landed edit, which is what keeps
 * what is heard equal to what is currently simulated. the warm-up is fire and
 * forget: a sample still decoding when its judgement arrives is silent rather
 * than late, and the bundled set is already resident from startup
 */
function installHitsounds(scene: LoadedScene): void {
	const state = viewerStore.getState();
	const plan = buildHitsoundPlan(scene, {
		positionalLevel: state.gameplay.positionalHitsoundLevel,
		alwaysPlayFirstComboBreak: state.gameplay.alwaysPlayFirstComboBreak,
		playfieldWidth: scene.renderPlan.playfield.width
	});
	hitsoundScheduler.setPlan(plan);

	// the map's own files, ahead of the bundled default. rebuilt here rather
	// than held, because the ignore-beatmap-hitsounds toggle changes what this
	// source answers and the chain reads it live
	const beatmap = beatmapSampleSource({
		files: scene.sampleFiles,
		toUrl: convertFileSrc,
		ignoreBeatmapHitsounds: state.audio.ignoreBeatmapHitsounds
	});
	setBeatmapSampleSource(beatmap);

	// the selected skin's own files, between the beatmap and the bundled
	// default -- the chain's middle slot, which was deliberately empty until
	// skinning landed. rebuilt here rather than held for the same reason the
	// beatmap source is: what it answers depends on live state
	// gated on the ERA rather than on whether the skin ships any sample files:
	// a legacy skin that switched layered hit sounds off has something to say
	// even with no samples of its own, and that answer is EMPTY, which a
	// file-count gate would drop on the floor
	const manifest = state.skin;
	const skin =
		manifest === null || manifest.era !== "legacy"
			? null
			: skinSampleSource({
					files: manifest.files,
					toUrl: convertFileSrc,
					extensions: SAMPLE_EXTENSIONS,
					layeredHitSounds: manifest.config.layeredHitSounds
				});
	setSkinSampleSource(skin);

	// resolve every distinct request the plan can make, and decode what the
	// chain answered. resolution is cheap and the store dedupes by url, so the
	// map's whole sample set is warmed with one pass rather than one fetch per
	// judgement
	const sources = sampleSources(beatmap, skin);
	const urls = new Set<string>();
	for (const sample of plan) {
		const answer = resolveSample(sources, sample.request);
		if (answer.answer === "found") urls.add(answer.value.url);
	}
	void sampleStore.loadAll(urls);
}

export function PlayerView() {
	const hostRef = useRef<HTMLDivElement>(null);
	const rendererRef = useRef<GameplayRenderer | null>(null);
	const sceneId = useViewerStore((s) => s.sceneId);
	const editRevision = useViewerStore((s) => s.editRevision);
	const overlays = useViewerStore((s) => s.overlays);
	const mode = useViewerStore((s) => s.mode);
	const effects = useViewerStore((s) => s.effects);
	const viewportZoom = useViewerStore((s) => s.viewportZoom);
	const viewportPan = useViewerStore((s) => s.viewportPan);
	const backgroundPath = useViewerStore((s) => s.scene?.backgroundPath ?? null);
	const backgroundDim = useViewerStore((s) => s.effects.backgroundDim);

	// renderer + raf loop live for the component's lifetime
	useEffect(() => {
		let disposed = false;
		let raf = 0;
		void GameplayRenderer.create(hostRef.current!).then((renderer) => {
			if (disposed) {
				renderer.destroy();
				return;
			}
			rendererRef.current = renderer;
			const state = viewerStore.getState();
			// effects before the scene: hitAnimations is baked into the object
			// timelines, so setting it first means the very first build already
			// uses the persisted value instead of rebuilding to reach it
			renderer.setEffects(state.effects);
			// and the skin before the scene, for the same reason: the palette is
			// resolved at build time, so setting it first means the first build
			// already draws the right colours instead of rebuilding to reach them
			renderer.setSkin(state.skin);
			renderer.setScene(state.scene, state.derived);
			renderer.setOverlays(effectiveOverlays(state.overlays, state.mode));
			renderer.setViewport(state.viewportZoom, state.viewportPan);
			if (state.mode === "edit") renderer.setEditChromeSources(editChromeSources);
			// the app's only render clock (adr 0001, one render clock): pixi
			// draws nothing by itself, so every frame on screen is one this loop
			// updated first
			const loop = () => {
				const t = playbackClock.tick();
				renderer.render(t);
				// the app's one render clock also drives the audio clock's
				// lookahead: one tick decides the frame and the sounds inside it,
				// so a sample can never be scheduled against a time the frame did
				// not draw
				hitsoundScheduler.update(t, playbackClock.rate, playbackClock.playing, playbackClock.seekVersion);
				// reflect clock-side auto-pause (end of replay) back into the store
				if (viewerStore.getState().playing !== playbackClock.playing) {
					viewerStore.getState().setPlaying(playbackClock.playing);
				}
				raf = requestAnimationFrame(loop);
			};
			raf = requestAnimationFrame(loop);
		});
		return () => {
			disposed = true;
			cancelAnimationFrame(raf);
			rendererRef.current?.destroy();
			rendererRef.current = null;
		};
	}, []);

	// scene swaps: renderer content, audio element, clock bounds. the returned
	// cleanup both tears down the previous scene's audio before the next one
	// attaches and releases it if the component itself unmounts
	useEffect(() => {
		const { scene, derived } = viewerStore.getState();
		// nothing pending can outlive its session (install() already settled
		// the queued commits as cancelled)
		gesturePreview.discardAll();
		rendererRef.current?.setScene(scene, derived);
		if (scene === null || derived === null) return;

		playbackClock.setBounds(derived.bounds.minTime, derived.bounds.maxTime);
		frameCursor.setFrames(scene.frames.map((f) => f.time));
		playbackClock.seekTo(derived.bounds.minTime);
		// a scene swap drops the previous map's own sample files; the bundled
		// set is the same for every scene and stays resident. cleared HERE and
		// not in installHitsounds, which also runs on every landed edit -- an
		// edit changes when a sound plays, never which files exist
		sampleStore.clear(bundledSampleUrlSet());
		installHitsounds(scene);
		if (scene.audioPath === null) return;

		const audio = new Audio();
		// BEFORE the src, and load-bearing: routing this element through the
		// audio graph makes a MediaElementAudioSourceNode of it, and a source
		// node built from a cross-origin element loaded in no-cors mode is
		// tainted and outputs SILENCE rather than failing loudly. tauri's asset
		// protocol answers with an explicit Access-Control-Allow-Origin for the
		// window's own origin (tauri/src/protocol/asset.rs:21), so opting into
		// CORS here is both possible and required
		audio.crossOrigin = "anonymous";
		audio.src = convertFileSrc(scene.audioPath);
		audio.preload = "auto";
		playbackClock.attachAudio(htmlAudioAdapter(audio));
		// the graph carries the music level from here on; the element's own
		// volume stays at 1 for its whole life (audio-graph.ts)
		audioGraph.attachMusic(audio);
		const onLoadedMetadata = () => {
			// a metadata event can land late (this element's fetch/decode
			// outlives audio.pause()): after a newer scene installed but before
			// this effect's deferred cleanup removes the listener -- a stale
			// scene's audio must touch neither the clock nor the store (the store
			// write would otherwise stick forever when the new scene has no audio)
			const state = viewerStore.getState();
			if (state.sceneId !== sceneId || state.derived === null) return;
			const durationMs = audio.duration * 1000;
			// streaming sources report Infinity; that must not reach the bounds
			if (!Number.isFinite(durationMs)) return;
			// the live derived, never this effect run's closure: an edit landing
			// before the metadata rederives the bounds, and extending the
			// install-time ones here would stomp the clock's post-edit bounds at
			// both ends -- with nothing to re-correct them, since publishing the
			// duration below does not bump editRevision
			const extended = audioExtendedBounds(state.derived.bounds, durationMs);
			playbackClock.setBounds(extended.minTime, extended.maxTime);
			// publish so the timeline maps against the same audio-extended bounds
			state.setAudioDuration(durationMs);
		};
		audio.addEventListener("loadedmetadata", onLoadedMetadata);

		return () => {
			audio.removeEventListener("loadedmetadata", onLoadedMetadata);
			audio.pause();
			// pause() stops playback but not an in-flight metadata fetch; dropping
			// the src and reloading actually aborts it
			audio.removeAttribute("src");
			audio.load();
			playbackClock.attachAudio(null);
			audioGraph.attachMusic(null);
			setBeatmapSampleSource(null);
		};
	}, [sceneId]);

	// edit-driven frame-stream changes: re-feed content, keep continuity.
	// unlike the sceneId effect this never seeks, never touches audio, and
	// never resets the viewport -- editRevision exists so edits don't reset
	// what the user is looking at
	useEffect(() => {
		if (editRevision === 0) return;
		const { scene, derived, lastSplice, audioDurationMs } = viewerStore.getState();
		if (scene === null || derived === null) return;
		const selected = frameCursor.selectedIndex();
		rendererRef.current?.setScene(scene, derived);
		// only after the renderer holds the post-delta frames: dropping a
		// landed preview any earlier would flash the pre-edit state between
		// the store install and this re-feed
		gesturePreview.settleRendered();
		const bounds = audioExtendedBounds(derived.bounds, audioDurationMs);
		playbackClock.setBounds(bounds.minTime, bounds.maxTime);
		// every landed edit re-derives the judgement timeline, so what was
		// scheduled describes a simulation that no longer exists. rebuilding
		// flushes, which is also what makes the combo-break "first break of the
		// play" marker follow the edit rather than going stale
		installHitsounds(scene);
		frameCursor.setFrames(scene.frames.map((f) => f.time));
		// an exact selection survives an index delta by remapping through the
		// splice; a fullFrames delta has no splice, and the cursor's derived
		// index already re-resolves by time
		if (selected !== null && lastSplice !== null && !isFullFrames(lastSplice)) {
			const remapped = remapIndex(selected, lastSplice);
			if (remapped !== null) frameCursor.select(remapped);
		}
	}, [editRevision]);

	// store -> clock: playing + rate + the audio offset. store -> graph: the
	// three levels
	useEffect(() => {
		const levels = (state: ViewerState) => ({
			master: state.volume,
			music: state.audio.musicVolume,
			hitsound: state.audio.hitsoundVolume
		});
		// the persisted levels can land before or after this mount, so apply
		// whatever the store already holds instead of waiting for a change event
		audioGraph.setLevels(levels(viewerStore.getState()));
		hitsoundScheduler.setEnabled(hitsoundsAudible(viewerStore.getState()));
		playbackClock.setOffset(viewerStore.getState().audio.offsetMs);
		return viewerStore.subscribe((state, prev) => {
			if (state.playing !== prev.playing) {
				if (state.playing) {
					// a context built before the first gesture starts suspended;
					// pressing play is the gesture
					audioGraph.resume();
					playbackClock.play();
				} else playbackClock.pause();
			}
			if (state.rate !== prev.rate) playbackClock.setRate(state.rate);
			if (state.volume !== prev.volume || state.audio !== prev.audio) {
				audioGraph.setLevels(levels(state));
				// skinnablesound skips a sample whose aggregate volume is zero
				// rather than playing it; there is nothing to schedule either
				hitsoundScheduler.setEnabled(hitsoundsAudible(state));
			}
			// the positional level and the combo-break rule are baked into the
			// plan; the ignore-beatmap-hitsounds toggle and the SKIN both change
			// which source answers. a skin change therefore re-plans without
			// reloading the replay and without touching the playhead -- the clock
			// is not consulted here at all
			// compared by SELECTION, not identity: ipc hands back a fresh manifest
			// per call, and the startup null -> bundled flip is not a skin change
			// at all -- both draw Argon. treating either as one would re-plan and
			// re-decode for nothing, and at startup could land mid-playback
			const skinMoved = !sameSelection(state.skin, prev.skin);
			if (
				(state.gameplay !== prev.gameplay ||
					state.audio.ignoreBeatmapHitsounds !== prev.audio.ignoreBeatmapHitsounds ||
					skinMoved) &&
				state.scene !== null
			) {
				// a SKIN change is the one re-plan that changes which files exist,
				// not just when they play -- which is the premise the scene-swap
				// clear was written on. without dropping the previous skin's
				// buffers, comparing skins over one replay accumulates them against
				// a budget that refuses PERMANENTLY once crossed, so the samples
				// would go silent with no way back but loading another replay. the
				// beatmap's own files are re-warmed by the pass below
				if (skinMoved) sampleStore.clear(bundledSampleUrlSet());
				installHitsounds(state.scene);
			}
			if (state.audio.offsetMs !== prev.audio.offsetMs) playbackClock.setOffset(state.audio.offsetMs);
			// the skin swaps atomically: the whole manifest resolved before it
			// reached the store, and installing it rebuilds every drawable in one
			// step without touching the clock, so the playhead is kept
			if (skinMoved) rendererRef.current?.setSkin(state.skin);
		});
	}, []);

	// the fold, not the stored preferences: edit mode force-draws the cursor
	// path and frame markers (state/defaults.ts effectiveOverlays), and the
	// stored object is never rewritten, so leaving edit mode restores exactly
	// the configured view
	useEffect(() => {
		rendererRef.current?.setOverlays(effectiveOverlays(overlays, mode));
	}, [overlays, mode]);

	// the edit chrome exists only in edit mode: watch wires the sources to
	// null and every chrome visual vanishes without a scene rebuild. the
	// getters read live, so this effect runs on mode changes only
	useEffect(() => {
		rendererRef.current?.setEditChromeSources(mode === "edit" ? editChromeSources : null);
	}, [mode]);

	useEffect(() => {
		rendererRef.current?.setEffects(effects);
	}, [effects]);

	useEffect(() => {
		rendererRef.current?.setViewport(viewportZoom, viewportPan);
	}, [viewportZoom, viewportPan]);

	// the raw stored value, never effectiveEffects': the background dim is not
	// gated by the effects master (state/defaults.ts carries it through the
	// fold for the same reason). the scrim is a black layer between the image
	// and the pixi host rather than the image's own opacity, so it generalises
	// to the video and storyboard backgrounds TODO.md still defers -- and it
	// draws only when there is an image to darken, since the bare area is
	// already the app's own near-black
	return (
		<div className="absolute inset-0">
			{backgroundPath !== null && (
				<>
					<img
						src={convertFileSrc(backgroundPath)}
						alt=""
						className="absolute inset-0 h-full w-full object-cover"
						draggable={false}
					/>
					<div className="absolute inset-0 bg-black" style={{ opacity: backgroundDim / 100 }} />
				</>
			)}
			<div ref={hostRef} className="absolute inset-0" />
		</div>
	);
}
