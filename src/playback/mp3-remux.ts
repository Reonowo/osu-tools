// the music element never plays an mp3 as it is on disk. chromium -- and so
// webview2 -- seeks an mp3 "fast but inaccurate": ffmpeg's mp3 demuxer jumps
// to a byte position ESTIMATED from the xing toc (vbr) or from the bitrate
// (cbr) and labels whatever frame it lands on with the time that was asked
// for. the element then reports the seek target while playing audio from
// somewhere else, and keeps doing so until the next seek. measured against a
// linear decode of the same file: -395ms to +252ms over one 134s vbr song,
// 15ms to 36ms on a cbr one, fixed for a given target. the clock follows the
// element's reported time, so any seek could leave the song audibly off the
// playfield and the hit samples until the next one.
//
// an mp4 carries a sample table -- the size and duration of every frame -- so
// its demuxer seeks by lookup instead. this repackages the mp3's own frames,
// byte for byte, into one: nothing is re-encoded, and the decoder is handed
// exactly the frames it was handed before.
//
// two details make the result land where the mp3 did, rather than merely seek
// exactly:
//
// - the gapless trim. ffmpeg's mp3 demuxer drops a lame tag's encoder delay
//   (plus its own decoder delay) from the front and the end padding from the
//   back. the mp4's edit list says the same, so the music meets the playfield
//   at the very sample it always did
// - a trimmed silent lead. the demuxer starts every seek early by however far
//   the stream begins before zero, and that head start is the decoder's
//   preroll: an mp3 frame borrows bytes from the frames before it (the bit
//   reservoir), and a decoder dropped cold onto the target frame measurably
//   misplaces it. silent frames in front, cut by the same edit list, buy the
//   preroll without moving one audible sample
//
// every rule below that decides WHICH bytes are audio -- where the first
// frame is, which frame is a tag, what the trim is -- is ffmpeg's
// (libavformat/mp3dec.c), because matching it is what keeps the music exactly
// where it was. anything this does not recognise returns null and plays from
// the file as before

const MPEG1 = 3;
const MPEG2 = 2;
const LAYER_3 = 1;

/** ffmpeg's `MP3_MASK`: the header bits two frames must agree on before the
 * demuxer trusts it has found the stream -- sync, version, layer, sample
 * rate, channel mode, copyright, original, emphasis */
const STREAM_MASK = 0xfffe0ccf;

/** how far past the id3v2 tags the demuxer looks for the first frame */
const FIRST_FRAME_SEARCH_BYTES = 64 * 1024;

/** mp3dec.c: `start_skip_samples = start_pad + 528 + 1` -- the decoder's own
 * output delay, trimmed on top of the encoder's */
const DECODER_DELAY_SAMPLES = 529;

/** silent lead frames beyond the deepest bit-reservoir reach. the edge was
 * measured on an 80kbps mpeg-2 file whose frames borrow from up to two frames
 * back: a one-frame lead left its seeks up to 17ms off, a two-frame lead was
 * exact. the margin is headroom over that edge, and a lead frame is a few
 * dozen bytes */
const LEAD_MARGIN_FRAMES = 2;

const BITRATES_KBPS: Readonly<Record<number, readonly number[]>> = {
	[MPEG1]: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
	[MPEG2]: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
};
const SAMPLE_RATES: Readonly<Record<number, readonly number[]>> = {
	[MPEG1]: [44100, 48000, 32000],
	[MPEG2]: [22050, 24000, 16000]
};

interface FrameHeader {
	word: number;
	mpeg1: boolean;
	sampleRate: number;
	channels: 1 | 2;
	length: number;
	samplesPerFrame: number;
	sideInfoBytes: number;
	crc: boolean;
}

interface AudioFrame {
	offset: number;
	length: number;
	/** how many bytes of earlier frames' main data this frame starts in */
	mainDataBegin: number;
	/** this frame's own main-data bytes, which later frames may borrow */
	mainDataBytes: number;
}

/**
 * the same audio as an mp4, or null when `bytes` is not an mp3 this can
 * repackage: another container under an .mp3 name, mpeg-2.5, layer i or ii,
 * a free-format bitrate, or a stream that changes sample rate or channel
 * count part way. null means "play the file as it is", never an error
 */
export function remuxMp3(bytes: Uint8Array): Uint8Array<ArrayBuffer> | null {
	let audioStart = skipId3v2(bytes);
	const tag = readVbrTag(bytes, audioStart);
	if (tag.skipsFrame) audioStart += tag.frameLength;
	const first = findFirstFrame(bytes, audioStart);
	if (first === null) return null;
	const reference = readHeader(bytes, first)!;
	const frames = walkFrames(bytes, first, reference);
	if (frames === null || frames.length === 0) return null;

	const samplesPerFrame = reference.samplesPerFrame;
	const lead = silentFrame(reference);
	const leadCount = reservoirReach(frames) + LEAD_MARGIN_FRAMES;
	const frameCount = leadCount + frames.length;
	const mediaStart = leadCount * samplesPerFrame + tag.startTrim;
	const playable = frameCount * samplesPerFrame - mediaStart - tag.endTrim;
	if (playable <= 0) return null;

	const sizes = [...Array.from({ length: leadCount }, () => lead.length), ...frames.map((frame) => frame.length)];
	const payloadLength = sizes.reduce((sum, size) => sum + size, 0);
	const head = mp4Head({
		sampleRate: reference.sampleRate,
		channels: reference.channels,
		objectType: reference.mpeg1 ? 0x6b : 0x69,
		samplesPerFrame,
		sizes,
		mediaStart,
		playable,
		payloadLength
	});

	const out = new Uint8Array(head.length + payloadLength);
	out.set(head, 0);
	let at = head.length;
	for (let i = 0; i < leadCount; i++) {
		out.set(lead, at);
		at += lead.length;
	}
	// consecutive frames are consecutive on disk except across junk, so they
	// copy as a handful of runs rather than one call per frame
	let runStart = frames[0].offset;
	let runEnd = runStart;
	for (const frame of frames) {
		if (frame.offset !== runEnd) {
			out.set(bytes.subarray(runStart, runEnd), at);
			at += runEnd - runStart;
			runStart = frame.offset;
		}
		runEnd = frame.offset + frame.length;
	}
	out.set(bytes.subarray(runStart, runEnd), at);
	return out;
}

function readHeader(bytes: Uint8Array, at: number): FrameHeader | null {
	if (at < 0 || at + 4 > bytes.length) return null;
	const word = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
	if (word >>> 21 !== 0x7ff) return null;
	const version = (word >>> 19) & 3;
	const layer = (word >>> 17) & 3;
	if ((version !== MPEG1 && version !== MPEG2) || layer !== LAYER_3) return null;
	const bitrateIndex = (word >>> 12) & 15;
	const rateIndex = (word >>> 10) & 3;
	if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
	const mpeg1 = version === MPEG1;
	const bitrate = BITRATES_KBPS[version][bitrateIndex] * 1000;
	const sampleRate = SAMPLE_RATES[version][rateIndex];
	const padding = (word >>> 9) & 1;
	const mono = ((word >>> 6) & 3) === 3;
	return {
		word,
		mpeg1,
		sampleRate,
		channels: mono ? 1 : 2,
		length: Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding,
		samplesPerFrame: mpeg1 ? 1152 : 576,
		sideInfoBytes: mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17,
		crc: ((word >>> 16) & 1) === 0
	};
}

/** past every id3v2 tag at the head of the file, footers included */
function skipId3v2(bytes: Uint8Array): number {
	let at = 0;
	while (
		at + 10 <= bytes.length &&
		bytes[at] === 0x49 &&
		bytes[at + 1] === 0x44 &&
		bytes[at + 2] === 0x33 &&
		((bytes[at + 6] | bytes[at + 7] | bytes[at + 8] | bytes[at + 9]) & 0x80) === 0
	) {
		const size = (bytes[at + 6] << 21) | (bytes[at + 7] << 14) | (bytes[at + 8] << 7) | bytes[at + 9];
		const footer = (bytes[at + 5] & 0x10) !== 0 ? 10 : 0;
		at += 10 + size + footer;
	}
	return at;
}

interface VbrTag {
	/** whether the demuxer treats the tag's frame as a header, not audio */
	skipsFrame: boolean;
	frameLength: number;
	startTrim: number;
	endTrim: number;
}

/**
 * mp3_parse_vbr_tags + mp3_parse_info_tag + mp3_parse_vbri_tag. only a frame
 * sitting exactly where the id3v2 tags end is ever read as a tag -- the
 * demuxer looks nowhere else -- and it is skipped as a header only when it
 * supplied a frame count or a byte size. the gapless trim is read from the
 * lame extension regardless
 */
function readVbrTag(bytes: Uint8Array, at: number): VbrTag {
	const none: VbrTag = { skipsFrame: false, frameLength: 0, startTrim: 0, endTrim: 0 };
	const header = readHeader(bytes, at);
	if (header === null) return none;

	let frames = 0;
	let byteSize = 0;
	let startTrim = 0;
	let endTrim = 0;
	// the demuxer's offset table ignores the crc: the tag sits right after the
	// side info as if there were none
	const xingAt = at + 4 + header.sideInfoBytes;
	const id = ascii(bytes, xingAt, 4);
	if (id === "Xing" || id === "Info") {
		const flags = readU32(bytes, xingAt + 4);
		let field = xingAt + 8;
		if (flags & 1) {
			frames = readU32(bytes, field);
			field += 4;
		}
		if (flags & 2) {
			byteSize = readU32(bytes, field);
			field += 4;
		}
		if (flags & 4) field += 100;
		if (flags & 8) field += 4;
		const encoder = ascii(bytes, field, 4);
		if (encoder === "LAME" || encoder === "Lavf" || encoder === "Lavc") {
			// version (9), revision (1), lowpass (1), peak (4), two gains (2+2),
			// flags (1), bitrate (1): then 12 bits of start pad, 12 of end pad
			const pads = readU24(bytes, field + 21);
			const startPad = pads >>> 12;
			const endPad = pads & 0xfff;
			startTrim = startPad + DECODER_DELAY_SAMPLES;
			// first_discard_sample lands past last_discard_sample below this,
			// which discards nothing; and without a frame count it is never set
			if (frames !== 0) endTrim = Math.max(0, endPad - DECODER_DELAY_SAMPLES);
		}
	}
	// vbri always sits 32 bytes past the header, whatever the channel mode
	const vbriAt = at + 4 + 32;
	if (ascii(bytes, vbriAt, 4) === "VBRI" && readU16(bytes, vbriAt + 4) === 1) {
		byteSize = readU32(bytes, vbriAt + 10);
		frames = readU32(bytes, vbriAt + 14);
	}
	return { skipsFrame: frames !== 0 || byteSize !== 0, frameLength: header.length, startTrim, endTrim };
}

/** the demuxer's junk skip: the first header whose successor agrees with it
 * under STREAM_MASK */
function findFirstFrame(bytes: Uint8Array, from: number): number | null {
	const end = Math.min(bytes.length, from + FIRST_FRAME_SEARCH_BYTES);
	for (let at = from; at < end; at++) {
		const header = readHeader(bytes, at);
		if (header === null) continue;
		const next = readHeader(bytes, at + header.length);
		if (next !== null && (next.word & STREAM_MASK) === (header.word & STREAM_MASK)) return at;
	}
	return null;
}

/** frames may switch between stereo modes, and vbr switches bitrate every
 * frame; a change of version, rate or channel count is a different stream */
function sameStream(a: FrameHeader, b: FrameHeader): boolean {
	return a.mpeg1 === b.mpeg1 && a.sampleRate === b.sampleRate && a.channels === b.channels;
}

/** every audio frame from `first` on. bytes that are not a frame (trailing
 * tags, junk between frames) are stepped over to the next confirmed frame. a
 * header that parses but belongs to a different stream is null: that is a
 * file this does not understand, not junk */
function walkFrames(bytes: Uint8Array, first: number, reference: FrameHeader): AudioFrame[] | null {
	const frames: AudioFrame[] = [];
	let at = first;
	while (at < bytes.length) {
		const header = readHeader(bytes, at);
		if (header !== null && at + header.length <= bytes.length) {
			if (!sameStream(header, reference)) return null;
			frames.push(audioFrame(bytes, at, header));
			at += header.length;
			continue;
		}
		const next = resync(bytes, at + 1, reference);
		if (next === null) break;
		at = next;
	}
	return frames;
}

/** the next header of this stream that is either followed by another or ends
 * exactly at the end of the file. one lone sync pattern in a tag is not
 * enough to be believed */
function resync(bytes: Uint8Array, from: number, reference: FrameHeader): number | null {
	for (let at = from; at + 4 <= bytes.length; at++) {
		const header = readHeader(bytes, at);
		if (header === null || !sameStream(header, reference)) continue;
		const end = at + header.length;
		if (end === bytes.length) return at;
		const next = readHeader(bytes, end);
		if (next !== null && sameStream(next, reference)) return at;
	}
	return null;
}

function audioFrame(bytes: Uint8Array, at: number, header: FrameHeader): AudioFrame {
	const sideInfo = at + 4 + (header.crc ? 2 : 0);
	const mainDataBegin = header.mpeg1 ? (bytes[sideInfo] << 1) | (bytes[sideInfo + 1] >>> 7) : bytes[sideInfo];
	return {
		offset: at,
		length: header.length,
		mainDataBegin,
		mainDataBytes: Math.max(0, header.length - (sideInfo - at) - header.sideInfoBytes)
	};
}

/** the furthest back, in frames, any frame reaches into the bit reservoir */
function reservoirReach(frames: readonly AudioFrame[]): number {
	let reach = 0;
	for (let i = 0; i < frames.length; i++) {
		let owed = frames[i].mainDataBegin;
		let back = 0;
		while (owed > 0 && i - back - 1 >= 0) {
			owed -= frames[i - back - 1].mainDataBytes;
			back++;
		}
		reach = Math.max(reach, back);
	}
	return reach;
}

/**
 * one frame of this stream that decodes to exact silence -- zero global gain,
 * zero big values -- at the lowest bitrate. its granules claim every byte of
 * its own main data (all ones: count1 table a's one-bit code is a quadruple
 * of zeros), so it leaves the NEXT frame an empty bit reservoir, which is the
 * state a decoder starts a file in. that is what keeps a stream whose first
 * frame reaches back into a reservoir it never had (a cut from a longer file)
 * decoding exactly as it did: an ordinary silent frame would hand it zeros to
 * read as data instead
 */
function silentFrame(reference: FrameHeader): Uint8Array {
	const word = reference.word;
	// crc off, lowest bitrate, no padding, no private bit, no mode extension
	const head = [0xff, ((word >>> 16) & 0xff) | 0x01, (1 << 4) | ((word >>> 8) & 0x0c), word & 0xcf];
	const header = readHeader(Uint8Array.from(head), 0)!;
	const frame = new Uint8Array(header.length);
	frame.set(head, 0);
	const mainDataStart = 4 + header.sideInfoBytes;
	frame.fill(0xff, mainDataStart);

	const granules = header.mpeg1 ? 2 : 1;
	const slots = granules * header.channels;
	let bitsLeft = (header.length - mainDataStart) * 8;
	let bit = 0;
	const put = (value: number, width: number) => {
		for (let k = width - 1; k >= 0; k--) {
			if ((value >>> k) & 1) frame[4 + (bit >>> 3)] |= 0x80 >>> (bit & 7);
			bit++;
		}
	};
	put(0, header.mpeg1 ? 9 : 8); // main_data_begin
	put(0, header.mpeg1 ? (header.channels === 1 ? 5 : 3) : header.channels); // private bits
	if (header.mpeg1) put(0, 4 * header.channels); // scfsi
	for (let slot = 0; slot < slots; slot++) {
		// part2_3_length: this granule's share of the frame's main data
		const share = Math.ceil(bitsLeft / (slots - slot));
		bitsLeft -= share;
		put(share, 12);
		put(0, 9); // big_values
		put(0, 8); // global_gain
		put(0, header.mpeg1 ? 4 : 9); // scalefac_compress
		put(0, 1); // window_switching_flag
		put(0, 15); // table_select x3
		put(0, 4); // region0_count
		put(0, 3); // region1_count
		if (header.mpeg1) put(0, 1); // preflag
		put(0, 1); // scalefac_scale
		put(0, 1); // count1table_select: table a
	}
	return frame;
}

interface Mp4Layout {
	sampleRate: number;
	channels: number;
	/** 0x6b for mpeg-1 audio, 0x69 for mpeg-2 */
	objectType: number;
	samplesPerFrame: number;
	sizes: readonly number[];
	/** samples the edit list cuts from the front: the lead and the gapless trim */
	mediaStart: number;
	playable: number;
	payloadLength: number;
}

/** ftyp, moov and the mdat header, sized for a payload that follows them.
 * one track, one chunk; every duration is in samples */
function mp4Head(layout: Mp4Layout): Uint8Array {
	const { sampleRate, channels, samplesPerFrame, sizes, mediaStart, playable } = layout;
	const frameCount = sizes.length;
	const matrix = [u32(0x10000), u32(0), u32(0), u32(0), u32(0x10000), u32(0), u32(0), u32(0), u32(0x40000000)];

	const esds = fullBox(
		"esds",
		0,
		0,
		descriptor(
			0x03,
			u16(1),
			u8(0),
			// audio stream (5 << 2 | reserved 1), no decoder-specific info: an
			// mp3 frame describes itself
			descriptor(0x04, u8(layout.objectType), u8(0x15), u24(0), u32(0), u32(0)),
			descriptor(0x06, u8(0x02))
		)
	);
	const mp4a = box(
		"mp4a",
		bytesOf(6),
		u16(1),
		bytesOf(8),
		u16(channels),
		u16(16),
		u16(0),
		u16(0),
		u32(sampleRate * 0x10000),
		esds
	);
	const sizeTable = new Uint8Array(frameCount * 4);
	const sizeView = new DataView(sizeTable.buffer);
	sizes.forEach((size, i) => sizeView.setUint32(i * 4, size));

	const moovFor = (payloadOffset: number) =>
		box(
			"moov",
			fullBox(
				"mvhd",
				0,
				0,
				u32(0),
				u32(0),
				u32(sampleRate),
				u32(playable),
				u32(0x10000),
				u16(0x100),
				bytesOf(10),
				...matrix,
				bytesOf(24),
				u32(2)
			),
			box(
				"trak",
				fullBox(
					"tkhd",
					0,
					7,
					u32(0),
					u32(0),
					u32(1),
					u32(0),
					u32(playable),
					bytesOf(8),
					u16(0),
					u16(0),
					u16(0x100),
					u16(0),
					...matrix,
					u32(0),
					u32(0)
				),
				box("edts", fullBox("elst", 0, 0, u32(1), u32(playable), u32(mediaStart), u16(1), u16(0))),
				box(
					"mdia",
					fullBox(
						"mdhd",
						0,
						0,
						u32(0),
						u32(0),
						u32(sampleRate),
						u32(frameCount * samplesPerFrame),
						u16(0x55c4),
						u16(0)
					),
					fullBox(
						"hdlr",
						0,
						0,
						u32(0),
						ascii4("soun"),
						bytesOf(12),
						Uint8Array.from("SoundHandler\0", (c) => c.charCodeAt(0))
					),
					box(
						"minf",
						fullBox("smhd", 0, 0, u16(0), u16(0)),
						box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1))),
						box(
							"stbl",
							fullBox("stsd", 0, 0, u32(1), mp4a),
							fullBox("stts", 0, 0, u32(1), u32(frameCount), u32(samplesPerFrame)),
							fullBox("stsc", 0, 0, u32(1), u32(1), u32(frameCount), u32(1)),
							fullBox("stsz", 0, 0, u32(0), u32(frameCount), sizeTable),
							fullBox("stco", 0, 0, u32(1), u32(payloadOffset))
						)
					)
				)
			)
		);

	const ftyp = box("ftyp", ascii4("M4A "), u32(0), ascii4("M4A "), ascii4("mp42"), ascii4("isom"));
	// the chunk offset is a fixed-width field, so the moov is the same size
	// whatever offset it holds: measure it once, then write the real one
	const moovLength = moovFor(0).length;
	const moov = moovFor(ftyp.length + moovLength + 8);
	return concat(ftyp, moov, u32(layout.payloadLength + 8), ascii4("mdat"));
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(...parts);
	return concat(u32(body.length + 8), ascii4(type), body);
}

function fullBox(type: string, version: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
	return box(type, u8(version), u24(flags), ...parts);
}

/** an mpeg-4 descriptor. every one written here is under 128 bytes, so its
 * length is the single-byte form */
function descriptor(tag: number, ...parts: Uint8Array[]): Uint8Array {
	const body = concat(...parts);
	return concat(u8(tag), u8(body.length), body);
}

function concat(...parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

const bytesOf = (length: number) => new Uint8Array(length);
const u8 = (value: number) => Uint8Array.of(value & 0xff);
const u16 = (value: number) => Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
const u24 = (value: number) => Uint8Array.of((value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
const u32 = (value: number) => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, value >>> 0);
	return out;
};
const ascii4 = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

function ascii(bytes: Uint8Array, at: number, length: number): string {
	if (at < 0 || at + length > bytes.length) return "";
	return String.fromCharCode(...bytes.subarray(at, at + length));
}

function readU16(bytes: Uint8Array, at: number): number {
	return at + 2 > bytes.length ? 0 : (bytes[at] << 8) | bytes[at + 1];
}

function readU24(bytes: Uint8Array, at: number): number {
	return at + 3 > bytes.length ? 0 : (bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2];
}

function readU32(bytes: Uint8Array, at: number): number {
	return at + 4 > bytes.length
		? 0
		: ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}
