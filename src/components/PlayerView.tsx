import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { gesturePreview } from "@/editor/preview";
import { isFullFrames, remapIndex } from "@/editor/splice";
import { audioExtendedBounds } from "@/lib/timeline";
import { htmlAudioAdapter } from "@/playback/clock";
import { frameCursor } from "@/playback/frame-cursor";
import { playbackClock } from "@/playback/instance";
import { GameplayRenderer, type EditChromeSources } from "@/renderer/GameplayRenderer";
import { effectiveOverlays } from "@/state/defaults";
import { useViewerStore, viewerStore } from "@/state/store";

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
		if (scene.audioPath === null) return;

		const audio = new Audio(convertFileSrc(scene.audioPath));
		audio.preload = "auto";
		playbackClock.attachAudio(htmlAudioAdapter(audio));
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
		frameCursor.setFrames(scene.frames.map((f) => f.time));
		// an exact selection survives an index delta by remapping through the
		// splice; a fullFrames delta has no splice, and the cursor's derived
		// index already re-resolves by time
		if (selected !== null && lastSplice !== null && !isFullFrames(lastSplice)) {
			const remapped = remapIndex(selected, lastSplice);
			if (remapped !== null) frameCursor.select(remapped);
		}
	}, [editRevision]);

	// store -> clock: playing + rate + volume
	useEffect(() => {
		// the persisted volume can land before or after this mount, so apply
		// whatever the store already holds instead of waiting for a change event
		playbackClock.setVolume(viewerStore.getState().volume / 100);
		return viewerStore.subscribe((state, prev) => {
			if (state.playing !== prev.playing) {
				if (state.playing) playbackClock.play();
				else playbackClock.pause();
			}
			if (state.rate !== prev.rate) playbackClock.setRate(state.rate);
			if (state.volume !== prev.volume) playbackClock.setVolume(state.volume / 100);
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
