import { useEffect, useRef } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { audioExtendedBounds } from "@/lib/timeline";
import { htmlAudioAdapter } from "@/playback/clock";
import { playbackClock } from "@/playback/instance";
import { GameplayRenderer } from "@/renderer/GameplayRenderer";
import { useViewerStore, viewerStore } from "@/state/store";

export function PlayerView() {
	const hostRef = useRef<HTMLDivElement>(null);
	const rendererRef = useRef<GameplayRenderer | null>(null);
	const sceneId = useViewerStore((s) => s.sceneId);
	const overlays = useViewerStore((s) => s.overlays);
	const backgroundPath = useViewerStore((s) => s.scene?.backgroundPath ?? null);

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
			const { scene, derived, overlays: currentOverlays } = viewerStore.getState();
			renderer.setScene(scene, derived);
			renderer.setOverlays(currentOverlays);
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
		rendererRef.current?.setScene(scene, derived);
		if (scene === null || derived === null) return;

		playbackClock.setBounds(derived.bounds.minTime, derived.bounds.maxTime);
		playbackClock.seekTo(derived.bounds.minTime);
		if (scene.audioPath === null) return;

		const audio = new Audio(convertFileSrc(scene.audioPath));
		audio.preload = "auto";
		playbackClock.attachAudio(htmlAudioAdapter(audio));
		// closes over this effect run's `derived` -- must be torn down before the
		// next scene's effect run attaches its own audio, or a metadata event
		// that lands late (this element's fetch/decode outlives audio.pause())
		// stomps the new scene's clock bounds with this scene's stale derived
		const onLoadedMetadata = () => {
			// a metadata event can land after a newer scene installed but before
			// this effect's deferred cleanup removes the listener -- a stale
			// scene's audio must touch neither the clock nor the store (the store
			// write would otherwise stick forever when the new scene has no audio)
			if (viewerStore.getState().sceneId !== sceneId) return;
			const durationMs = audio.duration * 1000;
			// streaming sources report Infinity; that must not reach the bounds
			if (!Number.isFinite(durationMs)) return;
			const extended = audioExtendedBounds(derived.bounds, durationMs);
			playbackClock.setBounds(extended.minTime, extended.maxTime);
			// publish so the timeline maps against the same audio-extended bounds
			viewerStore.getState().setAudioDuration(durationMs);
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

	useEffect(() => {
		rendererRef.current?.setOverlays(overlays);
	}, [overlays]);

	return (
		<div className="absolute inset-0">
			{backgroundPath !== null && (
				<img
					src={convertFileSrc(backgroundPath)}
					alt=""
					className="absolute inset-0 h-full w-full object-cover opacity-30"
					draggable={false}
				/>
			)}
			<div ref={hostRef} className="absolute inset-0" />
		</div>
	);
}
