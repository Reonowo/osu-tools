import { PlaybackClock } from "./clock";

/** the app-wide clock; playerview drives tick(), chrome reads it */
export const playbackClock = new PlaybackClock();
