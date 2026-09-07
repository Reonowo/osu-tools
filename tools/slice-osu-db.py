"""Cut a real osu!.db down to its header and one beatmap entry.

Usage: python tools/slice-osu-db.py <osu!.db> <out> [--truncated-source]

Walks every field of every entry in the source listing and writes nothing
unless that walk consumes the file exactly, so the slice is verified against
the whole file rather than assumed from a spec. Picks the first standard-mode
entry the player never played (metadata only, no play data), blanks the
player name, and keeps the entry's raw bytes untouched. Prints the values a
test should expect. See fixtures/stable/<version>/README.md.

--truncated-source relaxes exactly one thing, for the ticks-named backups
stable leaves beside the live listing: those are cut at a 4096-byte boundary,
so the walk runs clean for thousands of entries and then hits end-of-file
mid-entry. With the flag that end is accepted, only entries the walk finished
are candidates, and the summary says how many entries were verified and that
the end-of-file check could not run. Without it the refusal below stands.
"""

import struct
import sys

CHANGE_20140609 = 20140609
CHANGE_20191106 = 20191106

GRADE_UNPLAYED = 9
MODE_STANDARD = 0


class Truncated(Exception):
    """the walk reached end-of-file mid-entry"""


class Walker:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def u8(self):
        if self.pos >= len(self.data):
            raise Truncated(f"end of file at {self.pos}")
        v = self.data[self.pos]
        self.pos += 1
        return v

    def unpack(self, fmt):
        size = struct.calcsize(fmt)
        if self.pos + size > len(self.data):
            raise Truncated(f"end of file at {self.pos}")
        v = struct.unpack_from(fmt, self.data, self.pos)[0]
        self.pos += size
        return v

    def i16(self):
        return self.unpack("<h")

    def i32(self):
        return self.unpack("<i")

    def i64(self):
        return self.unpack("<q")

    def f32(self):
        return self.unpack("<f")

    def f64(self):
        return self.unpack("<d")

    def uleb(self):
        result = 0
        shift = 0
        while True:
            byte = self.u8()
            result |= (byte & 0x7F) << shift
            shift += 7
            if not byte & 0x80:
                return result

    def string(self):
        tag = self.u8()
        if tag == 0:
            return None
        if tag != 0x0B:
            raise ValueError(f"bad string tag 0x{tag:02x} at {self.pos - 1}")
        length = self.uleb()
        if self.pos + length > len(self.data):
            raise Truncated(f"end of file at {self.pos}")
        value = self.data[self.pos : self.pos + length].decode("utf-8", "replace")
        self.pos += length
        return value

    def star_pairs(self):
        # the value tag says whether the pair is int-double (before 20250107)
        # or int-float (from it), so the pair is read off the tag, not the
        # version
        pairs = []
        for _ in range(self.i32()):
            if self.u8() != 0x08:
                raise ValueError(f"bad pair int tag at {self.pos - 1}")
            mods = self.i32()
            tag = self.u8()
            if tag == 0x0D:
                pairs.append((mods, self.f64()))
            elif tag == 0x0C:
                pairs.append((mods, self.f32()))
            else:
                raise ValueError(f"bad pair value tag 0x{tag:02x} at {self.pos - 1}")
        return pairs

    def entry(self, version):
        e = {}
        if version < CHANGE_20191106:
            self.i32()  # entry size
        for key in ["artist", "artist_unicode", "title", "title_unicode", "creator", "difficulty", "audio", "md5", "file"]:
            e[key] = self.string()
        e["status"] = self.u8()
        e["circles"], e["sliders"], e["spinners"] = self.i16(), self.i16(), self.i16()
        e["modified"] = self.i64()
        if version < CHANGE_20140609:
            e["ar"], e["cs"], e["hp"], e["od"] = self.u8(), self.u8(), self.u8(), self.u8()
        else:
            e["ar"], e["cs"], e["hp"], e["od"] = self.f32(), self.f32(), self.f32(), self.f32()
        e["slider_velocity"] = self.f64()
        if version >= CHANGE_20140609:
            e["std"], e["taiko"], e["ctb"], e["mania"] = (self.star_pairs() for _ in range(4))
        else:
            e["std"] = e["taiko"] = e["ctb"] = e["mania"] = []
        e["drain"], e["total"], e["preview"] = self.i32(), self.i32(), self.i32()
        e["timing"] = [(self.f64(), self.f64(), self.u8()) for _ in range(self.i32())]
        e["beatmap_id"], e["set_id"], e["thread_id"] = self.i32(), self.i32(), self.i32()
        e["grades"] = tuple(self.u8() for _ in range(4))
        e["local_offset"] = self.i16()
        e["stack_leniency"] = self.f32()
        e["mode"] = self.u8()
        e["source"], e["tags"] = self.string(), self.string()
        e["online_offset"] = self.i16()
        e["title_font"] = self.string()
        e["unplayed"] = self.u8()
        e["last_played"] = self.i64()
        e["osz2"] = self.u8()
        e["folder"] = self.string()
        e["last_checked"] = self.i64()
        e["flags"] = [self.u8() for _ in range(5)]
        if version < CHANGE_20140609:
            self.i16()  # unknown short
        e["mod_time"] = self.i32()
        e["scroll_speed"] = self.u8()
        return e


def metadata_only(e):
    return (
        e["mode"] == MODE_STANDARD
        and e["unplayed"] == 1
        and e["last_played"] == 0
        and e["grades"] == (GRADE_UNPLAYED,) * 4
        and e["std"]
        and e["timing"]
        and e["md5"]
        and e["folder"]
        and e["file"]
    )


def main(src, out, truncated_source):
    data = open(src, "rb").read()
    w = Walker(data)
    version, folder_count, unlocked, unlock_date = w.i32(), w.i32(), w.u8(), w.i64()
    w.string()  # player name, never carried into the fixture
    count = w.i32()
    chosen = None
    verified = 0
    truncated_at = None
    for index in range(count):
        start = w.pos
        try:
            e = w.entry(version)
        except Truncated as end:
            if not truncated_source:
                raise SystemExit(
                    f"walk hit {end} inside entry {index} of {count}; pass --truncated-source if this"
                    " is one of stable's ticks-named backups, otherwise the field layout is wrong"
                )
            truncated_at = (index, w.pos)
            break
        verified += 1
        if chosen is None and metadata_only(e):
            chosen = (index, start, w.pos, e)
    if truncated_at is None:
        permissions = w.i32()
        if w.pos != len(data):
            raise SystemExit(f"walk consumed {w.pos} of {len(data)} bytes; the field layout is wrong, refusing to write")
    else:
        # the source's own trailing int is past the cut, so the slice carries
        # the neutral value rather than a byte the walk never saw
        permissions = 0
    if chosen is None:
        raise SystemExit("no unplayed standard-mode entry with ratings and timing points to pick")
    index, start, end, e = chosen

    fixture = bytearray()
    fixture += struct.pack("<i", version) + struct.pack("<i", 1) + bytes([unlocked]) + struct.pack("<q", unlock_date)
    fixture += bytes([0x0B, 0x00])  # empty player name
    fixture += struct.pack("<i", 1)
    fixture += data[start:end]
    fixture += struct.pack("<i", permissions)
    open(out, "wb").write(fixture)

    if truncated_at is None:
        print(f"source: version {version}, {count} beatmaps, {len(data)} bytes walked exactly")
    else:
        cut_index, cut_pos = truncated_at
        print(
            f"source: version {version}, {count} beatmaps declared, {verified} walked and verified;"
            f" TRUNCATED at byte {cut_pos} of {len(data)} inside entry {cut_index}."
        )
        print(
            "  --truncated-source: the end-of-file check could not run, so the layout is confirmed"
            f" only over the {verified} entries the walk finished; the slice was chosen from those"
            " and carries a zero user-permissions int of its own."
        )
    print(f"chosen entry {index} ({end - start} bytes) -> {out} ({len(fixture)} bytes)")
    for key in ["md5", "folder", "file", "artist", "title", "creator", "difficulty", "ar", "cs", "hp", "od"]:
        print(f"  {key}: {e[key]!r}")
    print(f"  std pairs: {len(e['std'])}, first {e['std'][0]!r}")
    print(f"  timing points: {len(e['timing'])}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--truncated-source"]
    truncated = "--truncated-source" in sys.argv[1:]
    if len(args) != 2:
        raise SystemExit(__doc__)
    main(args[0], args[1], truncated)
