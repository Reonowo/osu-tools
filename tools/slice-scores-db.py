"""Cut a real scores.db down to its header and one local play.

Usage: python tools/slice-scores-db.py <scores.db> <out> [--replays <Data/r>]

Walks every field of every row in the source database and writes nothing
unless that walk consumes the file exactly, so the slice is verified against
the whole file rather than assumed from a spec. Picks the first beatmap group
in file order holding a standard-mode NoMod score, preferring one whose
`Data/r` replay file exists (pass --replays to check, which is what the
committed slice was cut with), and keeps the chosen group key and row bytes
untouched except for the player name, which is blanked to the empty string
stable itself writes for a guest play. Prints the values a test should
expect.
See fixtures/stable/<version>/README.md.

Sibling of tools/slice-osu-db.py, same posture: real client bytes, an exact
field walk, and a refusal rather than a guess.
"""

import struct
import sys

MODE_STANDARD = 0

# osu!'s mod bitfield: the one mod that appends a trailing double to a row
MOD_TARGET_PRACTICE = 1 << 23

# .net ticks (0001-01-01) to windows file-time ticks (1601-01-01), which is
# what names a replay in Data/r
TICKS_0001_TO_1601 = 504911232000000000


class Walker:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def u8(self):
        if self.pos >= len(self.data):
            raise SystemExit(f"end of file at {self.pos}")
        v = self.data[self.pos]
        self.pos += 1
        return v

    def unpack(self, fmt):
        size = struct.calcsize(fmt)
        if self.pos + size > len(self.data):
            raise SystemExit(f"end of file at {self.pos}")
        v = struct.unpack_from(fmt, self.data, self.pos)[0]
        self.pos += size
        return v

    def i16(self):
        return self.unpack("<h")

    def i32(self):
        return self.unpack("<i")

    def i64(self):
        return self.unpack("<q")

    def u16(self):
        return self.unpack("<H")

    def u32(self):
        return self.unpack("<I")

    def u64(self):
        return self.unpack("<Q")

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
            raise SystemExit(f"bad string tag 0x{tag:02x} at {self.pos - 1}")
        length = self.uleb()
        if self.pos + length > len(self.data):
            raise SystemExit(f"end of file at {self.pos}")
        value = self.data[self.pos : self.pos + length].decode("utf-8", "replace")
        self.pos += length
        return value

    def row(self):
        r = {}
        # every field below is read at the WIDTH AND SIGN the engine's codec
        # reads it at, because these printed values are what the directory
        # README tells a maintainer to copy into that codec's test constants
        r["mode"] = self.u8()
        r["version"] = self.u32()
        r["md5"] = self.string()
        name_start = self.pos
        r["player"] = self.string()
        r["player_span"] = (name_start, self.pos)
        r["replay_md5"] = self.string()
        for key in ["c300", "c100", "c50", "geki", "katsu", "miss"]:
            r[key] = self.u16()
        r["score"] = self.u32()
        r["max_combo"] = self.u16()
        r["perfect"] = self.u8()
        r["mods"] = self.u32()
        r["life_graph"] = self.string()
        r["ticks"] = self.i64()
        # the null-array sentinel: scores.db never embeds replay bytes
        r["payload_length"] = self.i32()
        if r["payload_length"] > 0:
            self.pos += r["payload_length"]
        r["online_score_id"] = self.u64()
        if r["mods"] & MOD_TARGET_PRACTICE:
            r["target_accuracy"] = self.f64()
        return r


def replay_file_name(row):
    return f"{row['md5']}-{row['ticks'] - TICKS_0001_TO_1601}.osr"


def main(src, out, replays):
    data = open(src, "rb").read()
    w = Walker(data)
    version = w.i32()
    groups = w.i32()
    chosen = None
    fallback = None
    rows = 0
    for index in range(groups):
        key_start = w.pos
        key = w.string()
        key_end = w.pos
        count = w.i32()
        for _ in range(count):
            row_start = w.pos
            row = w.row()
            rows += 1
            if row["mode"] != MODE_STANDARD or row["mods"] != 0:
                continue
            candidate = (index, key_start, key_end, row_start, w.pos, key, row)
            if fallback is None:
                fallback = candidate
            if chosen is None and replays is not None:
                import os

                if os.path.isfile(os.path.join(replays, replay_file_name(row))):
                    chosen = candidate
    if w.pos != len(data):
        raise SystemExit(
            f"walk consumed {w.pos} of {len(data)} bytes; the field layout is wrong, refusing to write"
        )
    chosen = chosen or fallback
    if chosen is None:
        raise SystemExit("no standard-mode NoMod score to pick")
    index, key_start, key_end, row_start, row_end, key, row = chosen

    fixture = bytearray()
    fixture += struct.pack("<i", version) + struct.pack("<i", 1)
    fixture += data[key_start:key_end]
    fixture += struct.pack("<i", 1)
    # the row verbatim, except the player name: the account that played is
    # not what this fixture is for, and the listing slicer beside it blanks
    # the header's name for the same reason
    name_start, name_end = row["player_span"]
    fixture += data[row_start:name_start]
    fixture += bytes([0x0B, 0x00])
    fixture += data[name_end:row_end]
    open(out, "wb").write(fixture)

    print(f"source: version {version}, {groups} beatmap groups, {rows} rows, {len(data)} bytes walked exactly")
    print(f"chosen group {index} ({row_end - row_start} row bytes) -> {out} ({len(fixture)} bytes)")
    print(f"  group key: {key!r}")
    print("  player: '' (blanked in the slice)")
    for k in ["mode", "version", "md5", "replay_md5", "c300", "c100", "c50", "geki", "katsu",
              "miss", "score", "max_combo", "perfect", "mods", "life_graph", "ticks", "payload_length",
              "online_score_id"]:
        print(f"  {k}: {row[k]!r}")
    print(f"  Data/r file: {replay_file_name(row)!r}")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:]]
    replays = None
    if "--replays" in args:
        i = args.index("--replays")
        replays = args[i + 1]
        del args[i : i + 2]
    if len(args) != 2:
        raise SystemExit(__doc__)
    main(args[0], args[1], replays)
