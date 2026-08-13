// the object lane's cross-boundary contract: its container has to ship the
// marker the click handler's ancestor walk looks for, because that marker is
// the whole of what scopes the empty-space clear to this row. prior art:
// FramesPanel.test.tsx, which renders a prop-only subcomponent to static
// markup and asserts the result carries the attributes the shell walks

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ObjectLaneEntry } from "@/lib/derive";
import type { RenderObject } from "@/lib/scene-types";
import { ObjectLane, type SlicedObject } from "./ObjectLane";

const circle: RenderObject = {
	startTime: 1000,
	endTime: 1000,
	position: [100, 100],
	stackHeight: 0,
	comboColourIndex: 0,
	comboIndex: 0,
	indexInCombo: 0,
	preempt: 600,
	fadeIn: 400,
	kind: { type: "circle" }
};

const entry: ObjectLaneEntry = {
	grade: "great",
	tether: { key: "K1", fromTime: 1000, toTime: 1004, pressFrameIndex: 12 },
	nestedMarks: []
};

const objects: SlicedObject[] = [{ index: 0, object: circle, entry }];

function markup(list: SlicedObject[]): string {
	return renderToStaticMarkup(
		<ObjectLane
			objects={list}
			neighbourhood={{ start: 0, end: 2000 }}
			hitWindowBand={null}
			showHitWindowBands={false}
			showTethers={false}
			showNestedMarks={false}
		/>
	);
}

describe("ObjectLane", () => {
	test("the row's container ships the marker the click walk resolves", () => {
		const rootTag = markup(objects).slice(0, markup(objects).indexOf(">") + 1);
		expect(rootTag).toContain("data-object-lane");
	});

	test("an empty slice still renders the container, so a gap click has a lane to land in", () => {
		// the clear must work on a stretch of replay with no objects at all --
		// without the container that click would resolve to no lane and do nothing
		expect(markup([])).toContain("data-object-lane");
	});

	test("object marks carry their index, and sit inside the container", () => {
		const rendered = markup(objects);
		expect(rendered.indexOf("data-object-lane")).toBeLessThan(rendered.indexOf('data-object-index="0"'));
	});
});
