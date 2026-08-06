// playback controls, keyboard shortcuts, and the live combo/accuracy hud.
// the `current / total` readout and the hud values are continuous consumers
// (decision 6): they read playbackClock in their own rAF loop and write dom
// text directly, never through react state. play/pause and rate are discrete
// toggles, so those flow through the store, which task 12's PlayerView
// forwards to the clock. seeks call playbackClock.seekTo directly -- they
// never call setBounds, which is scene-load-only (task 9's review note)

import { useEffect, useRef } from "react";
import { Pause, Play, SkipBack, StepBack, StepForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAccuracy, formatTime } from "@/lib/format";
import { statsAt } from "@/lib/timeline";
import { playbackClock } from "@/playback/instance";
import { useViewerStore, viewerStore } from "@/state/store";
import { Timeline } from "./Timeline";

const RATES = [0.25, 0.5, 0.75, 1, 1.5, 2];

function stepFrame(direction: 1 | -1) {
  const { scene } = viewerStore.getState();
  if (scene === null) return;
  const t = playbackClock.currentTime();
  const times = scene.frames.map((f) => f.time);
  const next = direction === 1
    ? times.find((time) => time > t)
    : [...times].reverse().find((time) => time < t);
  if (next !== undefined) playbackClock.seekTo(next);
}

export function Controls() {
  const scene = useViewerStore((s) => s.scene);
  const playing = useViewerStore((s) => s.playing);
  const rate = useViewerStore((s) => s.rate);
  const setPlaying = useViewerStore((s) => s.setPlaying);
  const setRate = useViewerStore((s) => s.setRate);
  const timeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (timeRef.current !== null) {
        timeRef.current.textContent =
          `${formatTime(playbackClock.currentTime())} / ${formatTime(playbackClock.maxTime)}`;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // buttons and other interactive controls keep their native key
      // handling (space on a focused button must activate it, not toggle
      // playback out from under it)
      if (e.target instanceof HTMLElement && e.target.closest("input, textarea, select, button, [role=dialog]") !== null) return;
      if (viewerStore.getState().scene === null) return;
      switch (e.key) {
        case " ": e.preventDefault(); setPlaying(!viewerStore.getState().playing); break;
        case "ArrowLeft": playbackClock.seekTo(playbackClock.currentTime() - 1000); break;
        case "ArrowRight": playbackClock.seekTo(playbackClock.currentTime() + 1000); break;
        case ",": stepFrame(-1); break;
        case ".": stepFrame(1); break;
        case "Home": playbackClock.seekTo(playbackClock.minTime); break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPlaying]);

  if (scene === null) return null;
  return (
    <footer className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex flex-col gap-1 border-t border-zinc-800/60 bg-zinc-950/80 px-3 pb-2 pt-1 backdrop-blur">
      <Timeline />
      <div className="flex items-center gap-2">
        <Button size="icon" variant="ghost" aria-label="restart" onClick={() => playbackClock.seekTo(playbackClock.minTime)}>
          <SkipBack />
        </Button>
        <Button size="icon" aria-label={playing ? "pause" : "play"} className="bg-[#ff66ab] text-zinc-950 hover:bg-[#ff87bc]" onClick={() => setPlaying(!playing)}>
          {playing ? <Pause /> : <Play />}
        </Button>
        <Button size="icon" variant="ghost" aria-label="previous frame" onClick={() => stepFrame(-1)}><StepBack /></Button>
        <Button size="icon" variant="ghost" aria-label="next frame" onClick={() => stepFrame(1)}><StepForward /></Button>
        <span ref={timeRef} className="ml-2 text-xs tabular-nums text-zinc-400" />
        <div className="ml-auto flex items-center gap-0.5">
          {RATES.map((r) => (
            <Button
              key={r}
              size="sm"
              variant="ghost"
              className={r === rate ? "text-[#ff66ab]" : "text-zinc-500"}
              onClick={() => setRate(r)}
            >
              {r}x
            </Button>
          ))}
        </div>
      </div>
    </footer>
  );
}

/** live combo + accuracy, authoritative simulation only (spec: hidden with
 * popups and markers when not simulated) */
export function HudReadout() {
  const scene = useViewerStore((s) => s.scene);
  const comboRef = useRef<HTMLDivElement>(null);
  const accuracyRef = useRef<HTMLDivElement>(null);
  const authoritative = scene !== null && scene.simulation.status === "authoritative";

  useEffect(() => {
    if (!authoritative || scene === null) return;
    const events = scene.simulation.status === "authoritative" ? scene.simulation.events : [];
    let raf = 0;
    const loop = () => {
      const stats = statsAt(events, playbackClock.currentTime());
      if (comboRef.current !== null) comboRef.current.textContent = `${stats?.combo ?? 0}x`;
      if (accuracyRef.current !== null) {
        accuracyRef.current.textContent = stats === null ? "100.00%" : formatAccuracy(stats.accuracy);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [scene, authoritative]);

  if (!authoritative) return null;
  return (
    <>
      <div ref={comboRef} className="pointer-events-none absolute bottom-24 left-3 z-10 text-3xl font-bold tabular-nums text-white/90">0x</div>
      <div ref={accuracyRef} className="pointer-events-none absolute right-3 top-12 z-10 text-lg font-semibold tabular-nums text-white/80">100.00%</div>
    </>
  );
}
