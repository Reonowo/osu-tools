// the object lane row: the beatmap's own objects at their own times, the
// dock's fixed frame of reference -- nothing in this row moves under editing.
// prop-only, so the marker contract below can be rendered without a store
// (DetailLanes owns every one of these values and reads them off the store).
//
// the row's height must stay in lockstep with DetailLanes' OBJECT_ROW_PX,
// which the extended tether's y offsets are measured against

import type { ObjectLaneEntry } from "@/lib/derive";
import type { Grade, RenderObject } from "@/lib/scene-types";
import { aimTime } from "@/lib/analysis";
import { windowFraction, type TimeWindow } from "@/lib/timeline-view";

// osu!'s hit colours, demoted onto small elements rather than full-height
// bars so colour carries the grade without dominating the row; null grade
// (NotSimulated) draws neutral rather than fabricating an outcome
const GRADE_HEX: Record<Grade, string> = {
	great: "#66ccff",
	ok: "#88b300",
	meh: "#ffcc22",
	miss: "#ed1121"
};
const UNGRADED_HEX = "#8a8a93";

/** the hover readout: type, grade, and the exact hit error. a miss states
 * the absent hit error without claiming the object was never pressed -- the
 * event stream cannot reliably tell a press-caused miss from a timeout */
function objectTitle(object: RenderObject, entry: ObjectLaneEntry): string {
	const type = object.kind.type;
	if (entry.grade === null) return type;
	if (entry.tether !== null) {
		const error = entry.tether.toTime - entry.tether.fromTime;
		const value = Number.isInteger(error) ? `${error}` : error.toFixed(1);
		return `${type} · ${entry.grade} · ${error >= 0 ? "+" : ""}${value} ms`;
	}
	if (entry.grade === "miss") return `${type} · miss · no hit error`;
	return `${type} · ${entry.grade}`;
}

export interface SlicedObject {
	index: number;
	object: RenderObject;
	entry: ObjectLaneEntry;
}

/** circles are marks, sliders and spinners spans with head/repeat/tail marks
 * inside them, each coloured by its grade. hit-window bands sit behind the
 * marks and at-rest tethers between the two, every layer positioned once in
 * neighbourhood percent.
 *
 * the container's `data-object-lane` is what scopes DetailLanes' empty-space
 * clear to this row -- a literal on both sides, like the `data-hold-lane` and
 * `data-object-index` markers it joins. the click handler is bound to a
 * shared box covering the ruler, all four hold lanes and the velocity row,
 * and cancelling `pointerdown` does not suppress the `click` that follows, so
 * an unscoped clear would fire right after a hold-lane press had selected a
 * run and destroy the selection its own gesture just made */
export function ObjectLane({
	objects,
	neighbourhood,
	hitWindowBand,
	showHitWindowBands,
	showTethers,
	showNestedMarks
}: {
	objects: readonly SlicedObject[];
	neighbourhood: TimeWindow;
	/** null on a NotSimulated scene, or a scene with no meh window */
	hitWindowBand: { mehMs: number; background: string } | null;
	showHitWindowBands: boolean;
	showTethers: boolean;
	showNestedMarks: boolean;
}) {
	const span = neighbourhood.end - neighbourhood.start;
	const percentOf = (t: number) => `${windowFraction(neighbourhood, t) * 100}%`;

	return (
		<div data-object-lane="" className="relative h-[17px] border-b border-[#101013]">
			{showHitWindowBands &&
				hitWindowBand !== null &&
				objects.map(({ index, object }) => {
					const centre = aimTime(object);
					if (centre === null) return null;
					const width = ((2 * hitWindowBand.mehMs) / span) * 100;
					return (
						<div
							key={index}
							className="pointer-events-none absolute inset-y-[2px] rounded-[1px]"
							style={{
								left: percentOf(centre - hitWindowBand.mehMs),
								width: `${width}%`,
								background: hitWindowBand.background
							}}
						/>
					);
				})}
			{showTethers &&
				objects.map(({ index, entry }) => {
					// the at-rest tether: a hairline whose length is the hit error,
					// drawn inside the lane so a dense stream never becomes a hatched
					// mess; sub-pixel at coarse zoom by design
					const tether = entry.tether;
					if (tether === null) return null;
					const errorMs = Math.abs(tether.toTime - tether.fromTime);
					const width = (errorMs / span) * 100;
					return (
						<div
							key={index}
							className="pointer-events-none absolute bottom-[2px] h-px bg-[#e4e4e7]/70"
							style={{ left: percentOf(Math.min(tether.fromTime, tether.toTime)), width: `${width}%` }}
						/>
					);
				})}
			{objects.map(({ index, object, entry }) => {
				const colour = entry.grade === null ? UNGRADED_HEX : GRADE_HEX[entry.grade];
				const title = objectTitle(object, entry);
				const clickable = entry.tether !== null;
				if (object.kind.type === "circle") {
					return (
						<div
							key={index}
							data-object-index={index}
							title={title}
							className={`absolute inset-y-0 -ml-[3.5px] w-[7px] ${clickable ? "cursor-pointer" : ""}`}
							style={{ left: percentOf(object.startTime) }}
						>
							<div
								className="absolute inset-y-[4px] left-[2px] w-[3px] rounded-[1px]"
								style={{ background: colour }}
							/>
						</div>
					);
				}
				const left = windowFraction(neighbourhood, object.startTime);
				const right = windowFraction(neighbourhood, object.endTime);
				const spinner = object.kind.type === "spinner";
				return (
					<div
						key={index}
						data-object-index={index}
						title={title}
						className={`absolute inset-y-0 min-w-[3px] ${clickable ? "cursor-pointer" : ""}`}
						style={{ left: `${left * 100}%`, width: `${(right - left) * 100}%` }}
					>
						<div
							className="absolute inset-x-0 inset-y-[5px] rounded-[2px]"
							style={
								// spin sections read differently from tap sections: a
								// spinner's span is hatched where a slider's is solid
								spinner
									? {
											background: `repeating-linear-gradient(45deg, ${colour}8c 0 2px, transparent 2px 5px)`
										}
									: { background: `${colour}66` }
							}
						/>
						{!spinner &&
							showNestedMarks &&
							entry.nestedMarks.map((time, i) => {
								const objectSpan = object.endTime - object.startTime;
								const fraction = objectSpan > 0 ? (time - object.startTime) / objectSpan : 0;
								return (
									<div
										key={i}
										className="absolute inset-y-[3px] -ml-px w-[2px] rounded-[1px]"
										style={{ left: `${fraction * 100}%`, background: colour }}
									/>
								);
							})}
					</div>
				);
			})}
		</div>
	);
}
