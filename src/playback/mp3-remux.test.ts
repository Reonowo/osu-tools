import { describe, expect, test } from "bun:test";
import { remuxMp3 } from "./mp3-remux";

// synthetic streams: the remux never decodes audio, so a frame is a real
// header, a side info whose main_data_begin is set, and zeros

interface FrameSpec {
	mpeg1?: boolean;
	bitrateIndex?: number;
	padding?: boolean;
	mono?: boolean;
	mainDataBegin?: number;
	/** 0: 44.1k / 22.05k */
	rateIndex?: number;
	layer?: number;
}

function frameHeader(spec: FrameSpec): number[] {
	const version = spec.mpeg1 === false ? 2 : 3;
	const layer = spec.layer ?? 1;
	return [
		0xff,
		0xe0 | (version << 3) | (layer << 1) | 1,
		((spec.bitrateIndex ?? 9) << 4) | ((spec.rateIndex ?? 0) << 2) | (spec.padding ? 2 : 0),
		spec.mono ? 0xc0 : 0x40
	];
}

function frameLength(spec: FrameSpec): number {
	const mpeg1 = spec.mpeg1 !== false;
	const kbps = (
		mpeg1
			? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
			: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
	)[spec.bitrateIndex ?? 9];
	const rate = (mpeg1 ? [44100, 48000, 32000] : [22050, 24000, 16000])[spec.rateIndex ?? 0];
	return Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / rate) + (spec.padding ? 1 : 0);
}

function frame(spec: FrameSpec = {}, fill = 0): Uint8Array {
	const out = new Uint8Array(frameLength(spec)).fill(fill);
	out.set(frameHeader(spec), 0);
	const begin = spec.mainDataBegin ?? 0;
	if (spec.mpeg1 === false) out[4] = begin & 0xff;
	else {
		out[4] = (begin >> 1) & 0xff;
		out[5] = (begin & 1) << 7;
	}
	return out;
}

interface TagSpec {
	id?: "Xing" | "Info";
	frames?: number;
	bytes?: number;
	toc?: boolean;
	encoder?: string;
	pads?: [number, number];
}

/** a xing/info frame, laid out as lame writes one */
function xingFrame(spec: TagSpec, frameSpec: FrameSpec = {}): Uint8Array {
	const out = frame(frameSpec);
	const mpeg1 = frameSpec.mpeg1 !== false;
	let at = 4 + (mpeg1 ? (frameSpec.mono ? 17 : 32) : frameSpec.mono ? 9 : 17);
	const write = (values: number[]) => {
		out.set(values, at);
		at += values.length;
	};
	const u32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
	write([...(spec.id ?? "Info")].map((c) => c.charCodeAt(0)));
	const flags = (spec.frames !== undefined ? 1 : 0) | (spec.bytes !== undefined ? 2 : 0) | (spec.toc ? 4 : 0);
	write(u32(flags));
	if (spec.frames !== undefined) write(u32(spec.frames));
	if (spec.bytes !== undefined) write(u32(spec.bytes));
	if (spec.toc) write(Array.from({ length: 100 }, () => 0));
	if (spec.encoder !== undefined) {
		const version = [...spec.encoder.padEnd(9, " ")].map((c) => c.charCodeAt(0));
		write(version);
		// revision, lowpass, peak, two gains, flags, bitrate
		write(Array.from({ length: 12 }, () => 0));
		const [start, end] = spec.pads ?? [576, 1000];
		write([(start >> 4) & 255, ((start & 15) << 4) | ((end >> 8) & 15), end & 255]);
	}
	return out;
}

function id3v2(bodyLength: number, footer = false): Uint8Array {
	const out = new Uint8Array(10 + bodyLength + (footer ? 10 : 0));
	out.set([0x49, 0x44, 0x33, 4, 0, footer ? 0x10 : 0], 0);
	out.set([(bodyLength >> 21) & 127, (bodyLength >> 14) & 127, (bodyLength >> 7) & 127, bodyLength & 127], 6);
	return out;
}

function join(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const frames = (count: number, spec: FrameSpec = {}) => Array.from({ length: count }, (_, i) => frame(spec, i + 1));

// ---- reading the mp4 back ----

interface Box {
	type: string;
	start: number;
	body: Uint8Array;
}

function boxes(bytes: Uint8Array, from = 0, to = bytes.length): Box[] {
	const out: Box[] = [];
	let at = from;
	while (at < to) {
		const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
		const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
		out.push({ type, start: at, body: bytes.subarray(at + 8, at + size) });
		at += size;
	}
	return out;
}

function find(bytes: Uint8Array, path: string): Box {
	let level = boxes(bytes);
	let found: Box | undefined;
	for (const type of path.split("/")) {
		found = level.find((b) => b.type === type);
		if (found === undefined) throw new Error(`no ${type} in ${path}`);
		const offset = found.body.byteOffset - bytes.byteOffset;
		// stsd's children sit after its version, flags and entry count; mp4a's
		// after its 28-byte sample entry
		const skip = type === "stsd" ? 8 : type === "mp4a" ? 28 : 0;
		level = ["moov", "trak", "edts", "mdia", "minf", "stbl", "stsd", "mp4a", "dinf"].includes(type)
			? boxes(bytes, offset + skip, offset + found.body.length)
			: [];
	}
	return found!;
}

const view = (box: Box) => new DataView(box.body.buffer, box.body.byteOffset, box.body.length);

function sampleTable(mp4: Uint8Array) {
	const stts = view(find(mp4, "moov/trak/mdia/minf/stbl/stts"));
	const stsz = find(mp4, "moov/trak/mdia/minf/stbl/stsz");
	const count = view(stsz).getUint32(8);
	const sizes = Array.from({ length: count }, (_, i) => view(stsz).getUint32(12 + i * 4));
	const elst = view(find(mp4, "moov/trak/edts/elst"));
	return {
		frameCount: stts.getUint32(8),
		samplesPerFrame: stts.getUint32(12),
		sizes,
		segment: elst.getUint32(8),
		mediaStart: elst.getInt32(12),
		chunkOffset: view(find(mp4, "moov/trak/mdia/minf/stbl/stco")).getUint32(8)
	};
}

function payload(mp4: Uint8Array): Uint8Array {
	return find(mp4, "mdat").body;
}

/** the frames after the silent lead, as they sit in the mdat */
function audioPayload(mp4: Uint8Array): Uint8Array {
	const table = sampleTable(mp4);
	const lead = leadCount(mp4);
	const leadBytes = table.sizes.slice(0, lead).reduce((n, s) => n + s, 0);
	return payload(mp4).subarray(leadBytes);
}

/** lead frames are the ones the remux wrote: all-ones main data */
function leadCount(mp4: Uint8Array): number {
	const table = sampleTable(mp4);
	const data = payload(mp4);
	let at = 0;
	let count = 0;
	for (const size of table.sizes) {
		if (data[at + size - 1] !== 0xff) break;
		count++;
		at += size;
	}
	return count;
}

describe("remuxMp3: repackaging", () => {
	test("the audio frames are carried byte for byte after the lead", () => {
		const stream = frames(5);
		const mp4 = remuxMp3(join(...stream))!;
		expect(mp4).not.toBeNull();
		expect([...audioPayload(mp4)]).toEqual([...join(...stream)]);
	});

	test("the sample table indexes every frame, lead first, at 1152 samples each", () => {
		const stream = [
			frame({ bitrateIndex: 9 }),
			frame({ bitrateIndex: 11 }),
			frame({ bitrateIndex: 9, padding: true })
		];
		const mp4 = remuxMp3(join(...stream))!;
		const table = sampleTable(mp4);
		const lead = leadCount(mp4);
		expect(table.samplesPerFrame).toBe(1152);
		expect(table.frameCount).toBe(lead + 3);
		expect(table.sizes.slice(lead)).toEqual(stream.map((f) => f.length));
	});

	test("the chunk offset points at the first byte of the mdat payload", () => {
		const mp4 = remuxMp3(join(...frames(4)))!;
		const mdat = find(mp4, "mdat");
		expect(sampleTable(mp4).chunkOffset).toBe(mdat.body.byteOffset - mp4.byteOffset);
	});

	test("the sample entry names the stream's rate and channels", () => {
		const mp4 = remuxMp3(join(...frames(4, { mono: true, rateIndex: 1 })))!;
		const entry = view(find(mp4, "moov/trak/mdia/minf/stbl/stsd/mp4a"));
		expect(entry.getUint16(16)).toBe(1);
		expect(entry.getUint32(24) / 0x10000).toBe(48000);
	});

	test("mpeg-1 is object type 0x6b and mpeg-2 0x69 at 576 samples a frame", () => {
		const esdsType = (mp4: Uint8Array) => find(mp4, "moov/trak/mdia/minf/stbl/stsd/mp4a/esds").body[4 + 2 + 3 + 2];
		expect(esdsType(remuxMp3(join(...frames(3)))!)).toBe(0x6b);
		const lsf = remuxMp3(join(...frames(3, { mpeg1: false, bitrateIndex: 8 })))!;
		expect(esdsType(lsf)).toBe(0x69);
		expect(sampleTable(lsf).samplesPerFrame).toBe(576);
	});
});

describe("remuxMp3: the silent lead", () => {
	test("a stream that borrows nothing leads with two frames, cut by the edit list", () => {
		const mp4 = remuxMp3(join(...frames(6)))!;
		const table = sampleTable(mp4);
		expect(leadCount(mp4)).toBe(2);
		expect(table.mediaStart).toBe(2 * 1152);
		expect(table.segment).toBe(6 * 1152);
	});

	test("the lead grows with the deepest bit-reservoir reach", () => {
		// 128kbps mono at 44.1k: 417 bytes a frame, 396 of them main data, so a
		// 500-byte borrow reaches two frames back
		const spec = { mono: true, bitrateIndex: 9 };
		const stream = [frame(spec), frame(spec), frame(spec), frame({ ...spec, mainDataBegin: 500 }), frame(spec)];
		const mp4 = remuxMp3(join(...stream))!;
		expect(leadCount(mp4)).toBe(2 + 2);
		expect(sampleTable(mp4).mediaStart).toBe(4 * 1152);
		expect(sampleTable(mp4).segment).toBe(5 * 1152);
	});

	test("a lead frame is a silent frame of the same stream that uses up its own main data", () => {
		const mp4 = remuxMp3(join(...frames(3, { rateIndex: 1 })))!;
		const size = sampleTable(mp4).sizes[0];
		const lead = payload(mp4).subarray(0, size);
		// crc off, 32kbps (the lowest), 48k, no padding, joint stereo kept
		expect([...lead.subarray(0, 4)]).toEqual([0xff, 0xfb, 0x14, 0x40]);
		expect(size).toBe(96);

		const bits = new BitReader(lead.subarray(4));
		expect(bits.read(9)).toBe(0); // main_data_begin
		bits.read(3 + 8); // private, scfsi
		let claimed = 0;
		for (let slot = 0; slot < 4; slot++) {
			claimed += bits.read(12); // part2_3_length
			expect(bits.read(9)).toBe(0); // big_values
			expect(bits.read(8)).toBe(0); // global_gain
			bits.read(4 + 1 + 15 + 4 + 3 + 1 + 1);
			expect(bits.read(1)).toBe(0); // count1 table a
		}
		expect(claimed).toBe((96 - 4 - 32) * 8);
		expect([...lead.subarray(4 + 32)].every((b) => b === 0xff)).toBe(true);
	});
});

class BitReader {
	private bit = 0;
	constructor(private readonly bytes: Uint8Array) {}
	read(width: number): number {
		let value = 0;
		for (let k = 0; k < width; k++) {
			value = (value << 1) | ((this.bytes[this.bit >> 3] >> (7 - (this.bit & 7))) & 1);
			this.bit++;
		}
		return value;
	}
}

describe("remuxMp3: the demuxer's tag and trim rules", () => {
	test("a lame info tag is dropped and its delay and padding are trimmed like ffmpeg does", () => {
		const tag = xingFrame({ id: "Info", frames: 10, bytes: 4000, encoder: "LAME3.100", pads: [576, 1200] });
		const mp4 = remuxMp3(join(tag, ...frames(10)))!;
		const table = sampleTable(mp4);
		const lead = leadCount(mp4);
		expect(table.frameCount).toBe(lead + 10);
		// start pad + 529 decoder delay in front; end pad - 529 at the back
		expect(table.mediaStart).toBe(lead * 1152 + 576 + 529);
		expect(table.segment).toBe(10 * 1152 - 576 - 529 - (1200 - 529));
	});

	test("a vbr xing tag with a toc is dropped the same way", () => {
		const tag = xingFrame({
			id: "Xing",
			frames: 8,
			bytes: 3300,
			toc: true,
			encoder: "LAME3.99r",
			pads: [576, 600]
		});
		const mp4 = remuxMp3(join(tag, ...frames(8)))!;
		const table = sampleTable(mp4);
		expect(table.frameCount).toBe(leadCount(mp4) + 8);
		expect(table.mediaStart).toBe(leadCount(mp4) * 1152 + 1105);
		expect(table.segment).toBe(8 * 1152 - 1105 - (600 - 529));
	});

	test("an end pad under the decoder delay trims nothing at the back", () => {
		const tag = xingFrame({ id: "Info", frames: 4, bytes: 2000, encoder: "LAME3.100", pads: [576, 300] });
		const table = sampleTable(remuxMp3(join(tag, ...frames(4)))!);
		expect(table.segment).toBe(4 * 1152 - 1105);
	});

	test("a lavf-written tag trims too; one from another encoder does not", () => {
		const trim = (encoder: string) => {
			const tag = xingFrame({ id: "Info", frames: 4, bytes: 2000, encoder, pads: [1000, 0] });
			const mp4 = remuxMp3(join(tag, ...frames(4)))!;
			return sampleTable(mp4).mediaStart - leadCount(mp4) * 1152;
		};
		expect(trim("Lavf58.76")).toBe(1529);
		expect(trim("GOGO")).toBe(0);
	});

	test("a xing tag with neither a frame count nor a byte size stays in as audio", () => {
		const tag = xingFrame({ id: "Xing", encoder: "LAME3.100", pads: [576, 0] });
		const mp4 = remuxMp3(join(tag, ...frames(4)))!;
		const table = sampleTable(mp4);
		expect(table.frameCount).toBe(leadCount(mp4) + 5);
		// the lame delay is read all the same
		expect(table.mediaStart).toBe(leadCount(mp4) * 1152 + 1105);
	});

	test("a vbri tag is dropped and trims nothing", () => {
		const tag = frame();
		tag.set(
			[..."VBRI"].map((c) => c.charCodeAt(0)),
			36
		);
		tag.set([0, 1, 0, 0, 0, 0, 0, 0, 0x10, 0, 0, 0, 0, 4], 40);
		const mp4 = remuxMp3(join(tag, ...frames(4)))!;
		const table = sampleTable(mp4);
		expect(table.frameCount).toBe(leadCount(mp4) + 4);
		expect(table.mediaStart).toBe(leadCount(mp4) * 1152);
	});

	test("a tag is only a tag where the id3v2 tags end", () => {
		const tag = xingFrame({ id: "Info", frames: 4, bytes: 2000, encoder: "LAME3.100" });
		// one junk byte in front: the demuxer reads no tag there, then finds
		// the info frame as the first audio frame
		const mp4 = remuxMp3(join(new Uint8Array([0]), tag, ...frames(4)))!;
		const table = sampleTable(mp4);
		expect(table.frameCount).toBe(leadCount(mp4) + 5);
		expect(table.mediaStart).toBe(leadCount(mp4) * 1152);
	});
});

describe("remuxMp3: finding the frames", () => {
	test("id3v2 tags at the head are stepped over, footers and repeats included", () => {
		const stream = frames(4);
		const tag = xingFrame({ id: "Info", frames: 4, bytes: 2000, encoder: "LAME3.100" });
		const mp4 = remuxMp3(join(id3v2(300, true), id3v2(40), tag, ...stream))!;
		expect([...audioPayload(mp4)]).toEqual([...join(...stream)]);
		expect(sampleTable(mp4).mediaStart).toBe(leadCount(mp4) * 1152 + 1105);
	});

	test("junk before the first frame is skipped", () => {
		const stream = frames(4);
		const mp4 = remuxMp3(join(new Uint8Array(700).fill(0x20), ...stream))!;
		expect([...audioPayload(mp4)]).toEqual([...join(...stream)]);
	});

	test("junk between frames is stepped over and trailing tags are left out", () => {
		const [a, b, c, d] = frames(4);
		const trailing = new Uint8Array(128).fill(0x41);
		trailing.set([0x54, 0x41, 0x47], 0);
		const mp4 = remuxMp3(join(a, b, new Uint8Array(33).fill(7), c, d, trailing))!;
		expect([...audioPayload(mp4)]).toEqual([...join(a, b, c, d)]);
	});

	test("a truncated last frame is left out", () => {
		const stream = frames(3);
		const cut = frame().subarray(0, 100);
		const mp4 = remuxMp3(join(...stream, cut))!;
		expect([...audioPayload(mp4)]).toEqual([...join(...stream)]);
	});

	test("a stream that switches between stereo and joint stereo is still one stream", () => {
		// the first frame still needs a successor that agrees on the mode --
		// that is the demuxer's rule for trusting a sync -- but not every frame
		const stereo = frame();
		stereo[3] = 0x00;
		const stream = [frame(), frame(), stereo, frame()];
		expect(sampleTable(remuxMp3(join(...stream))!).frameCount).toBe(2 + 4);
	});
});

describe("remuxMp3: declining", () => {
	test("another container under an mp3 name plays as it is", () => {
		const ogg = new Uint8Array(4096);
		ogg.set([0x4f, 0x67, 0x67, 0x53], 0);
		const mp4 = new Uint8Array(4096);
		mp4.set([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70], 0);
		expect(remuxMp3(ogg)).toBeNull();
		expect(remuxMp3(mp4)).toBeNull();
		expect(remuxMp3(new Uint8Array(0))).toBeNull();
	});

	test("layer ii and mpeg-2.5 are left to the element", () => {
		expect(remuxMp3(join(...frames(4, { layer: 2 })))).toBeNull();
		const mpeg25 = frames(4).map((f) => {
			const copy = f.slice();
			copy[1] &= ~0x18;
			return copy;
		});
		expect(remuxMp3(join(...mpeg25))).toBeNull();
	});

	test("a stream that changes rate or channel count part way is left to the element", () => {
		expect(remuxMp3(join(...frames(3), ...frames(3, { rateIndex: 1 })))).toBeNull();
		expect(remuxMp3(join(...frames(3), ...frames(3, { mono: true })))).toBeNull();
	});
});
