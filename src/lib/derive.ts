// everything computed once per scene: analysis edges, playback bounds,
// judgement lookups, and timeline markers

import { HIT_FADE_OUT_TIME } from "../engine/argon";
import { buttonEdges, pressEdges, type ButtonEdges, type Press } from "../engine/interpolation";
import type { JudgementEventDto, LoadedScene } from "./scene-types";

export interface DerivedScene {
  presses: Press[];
  edges: ButtonEdges;
  bounds: { minTime: number; maxTime: number };
  /** indexed by objectIndex; empty arrays when not simulated */
  judgementsByObject: JudgementEventDto[][];
  timelineMarkers: { time: number; grade: "ok" | "meh" | "miss" }[];
}

export function deriveScene(scene: LoadedScene): DerivedScene {
  const objects = scene.renderPlan.objects;
  const firstAppear = objects.length > 0 ? objects[0].startTime - objects[0].preempt : 0;
  const lastEnd = objects.reduce((max, o) => Math.max(max, o.endTime), 0);
  const firstFrame = scene.frames.length > 0 ? scene.frames[0].time : 0;
  const lastFrame = scene.frames.length > 0 ? scene.frames[scene.frames.length - 1].time : 0;

  const judgementsByObject: JudgementEventDto[][] = objects.map(() => []);
  const timelineMarkers: DerivedScene["timelineMarkers"] = [];
  // a late judgement extends its drawable's fade past the object's endTime
  // (objectLifetime in renderer/playfield.ts), and the playback bounds must
  // cover that full fade or the clock pauses mid-animation when the audio
  // is absent or shorter
  let lastEventTime = lastEnd;
  if (scene.simulation.status === "authoritative") {
    for (const event of scene.simulation.events) {
      lastEventTime = Math.max(lastEventTime, event.time);
      judgementsByObject[event.objectIndex]?.push(event);
      const kind = event.kind;
      if (kind.type === "circle" || kind.type === "sliderAggregate" || kind.type === "spinnerFinal") {
        if (kind.grade !== "great") timelineMarkers.push({ time: event.time, grade: kind.grade });
      }
    }
  }

  return {
    presses: pressEdges(scene.frames),
    edges: buttonEdges(scene.frames),
    bounds: {
      minTime: Math.min(0, -scene.beatmap.audioLeadIn, firstFrame, firstAppear),
      maxTime: Math.max(lastFrame, lastEventTime + HIT_FADE_OUT_TIME),
    },
    judgementsByObject,
    timelineMarkers,
  };
}
