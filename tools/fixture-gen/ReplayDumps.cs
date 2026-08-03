using System.Text.Json;
using osu.Framework.Input.StateChanges;
using osu.Game.Beatmaps;
using osu.Game.Input.Handlers;
using osu.Game.Replays;
using osu.Game.Rulesets;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Replays;
using osu.Game.Scoring.Legacy;
using osuTK;
using SharpCompress.Compressors.LZMA;

namespace FixtureGen;

public static class ReplayDumps
{
    public static void Run(string outDir, JsonSerializerOptions jsonOptions)
    {
        Directory.CreateDirectory(Path.Combine(outDir, "replays"));
        DumpCursorInterpolation(outDir, jsonOptions);
        DumpFrameConversion(outDir, jsonOptions, "synthetic_v14", "frame_conversion_v14", "stacking-v14", 20151228);
        DumpFrameConversion(outDir, jsonOptions, "synthetic_v4", "frame_conversion_v4", "old-format-v4", 20151228);
    }

    private static void DumpCursorInterpolation(string outDir, JsonSerializerOptions jsonOptions)
    {
        var cases = new (string name, OsuReplayFrame[] frames)[]
        {
            ("steady-16ms", Enumerable.Range(0, 21).Select(i =>
                new OsuReplayFrame(
                    i * 16,
                    new Vector2(50 + i * 10, 100 + i * 5),
                    i >= 6 && i <= 12 ? new[] { OsuAction.LeftButton } : Array.Empty<OsuAction>()))
                .ToArray()),
            ("irregular-deltas", new[]
            {
                new OsuReplayFrame(0, new Vector2(0, 0)),
                new OsuReplayFrame(1, new Vector2(3, 7), OsuAction.RightButton),
                new OsuReplayFrame(501, new Vector2(400, 300), OsuAction.RightButton),
                new OsuReplayFrame(502, new Vector2(410, 310)),
                new OsuReplayFrame(1300, new Vector2(20, 20)),
            }),
            ("duplicate-times", new[]
            {
                new OsuReplayFrame(0, new Vector2(0, 0)),
                new OsuReplayFrame(100, new Vector2(10, 10), OsuAction.LeftButton),
                new OsuReplayFrame(100, new Vector2(90, 90), OsuAction.RightButton),
                new OsuReplayFrame(200, new Vector2(100, 100)),
            }),
            ("unsorted-input", new[]
            {
                new OsuReplayFrame(200, new Vector2(30, 30)),
                new OsuReplayFrame(0, new Vector2(10, 10), OsuAction.LeftButton),
                new OsuReplayFrame(100, new Vector2(20, 20)),
            }),
        };

        var dumped = cases.Select(c =>
        {
            var replay = new Replay { HasReceivedAllFrames = true };
            replay.Frames.AddRange(c.frames);
            var handler = new OsuFramedReplayInputHandler(replay)
            {
                GamefieldToScreenSpace = pos => pos,
            };

            double firstTime = c.frames.Min(f => f.Time);
            double lastTime = c.frames.Max(f => f.Time);
            // ascending sweep: 7ms grid to land mid-frame, plus every exact
            // frame time, from before the first frame to past the last
            var sampleTimes = new SortedSet<double>();
            for (double t = firstTime - 50; t <= lastTime + 50; t += 7)
                sampleTimes.Add(t);
            foreach (var f in c.frames)
                sampleTimes.Add(f.Time);

            var samples = sampleTimes.Select(t =>
            {
                // setframefromtime (framedreplayinputhandler.cs:127-165) advances
                // currentframeindex by at most one step per call. when several
                // frames share one exact time, a single call at that time only
                // performs one of the several steps needed to walk all the way
                // through the run, leaving the rest "owed". repeating the same
                // query time here settles the handler fully -- landing forward,
                // on the last frame of any equal-time run, matching
                // framedreplayinputhandler.cs:141-146's convergence and pinned by
                // FramedReplayInputHandlerTest.cs's TestMultipleFramesSameTime --
                // before any state is captured, so every recorded sample reflects
                // the fully settled state a direct seek computes, matching the
                // stateless model cursor_state_at implements
                for (int i = 0; i < c.frames.Length; i++)
                    handler.SetFrameFromTime(t);

                var inputs = new List<IInput>();
                handler.CollectPendingInputs(inputs);
                var mouse = inputs.OfType<MousePositionAbsoluteInput>().Single();
                var state = inputs.OfType<ReplayInputHandler.ReplayState<OsuAction>>().Single();
                return new
                {
                    Time = t,
                    Pos = new[] { mouse.Position.X, mouse.Position.Y },
                    Left = state.PressedActions.Contains(OsuAction.LeftButton),
                    Right = state.PressedActions.Contains(OsuAction.RightButton),
                };
            }).ToArray();

            return new
            {
                c.name,
                // the handler constructor sorts replay.Frames in place
                // (framedreplayinputhandler.cs:99), so re-reading it here hands
                // the rust side frames in the same order the handler walked
                Frames = replay.Frames.Cast<OsuReplayFrame>().Select(f => new
                {
                    Time = f.Time,
                    Pos = new[] { f.Position.X, f.Position.Y },
                    Left = f.Actions.Contains(OsuAction.LeftButton),
                    Right = f.Actions.Contains(OsuAction.RightButton),
                }).ToArray(),
                Samples = samples,
            };
        }).ToArray();

        File.WriteAllText(
            Path.Combine(outDir, "replays", "cursor_interpolation.json"),
            JsonSerializer.Serialize(new { Cases = dumped }, jsonOptions));
        Console.WriteLine($"cursor interpolation fixture: {dumped.Length} cases");
    }

    // the raw frame payload text every synthetic .osr carries. hand-authored
    // to cover: stable's two intro frames, an early negative delta (first-
    // frame fixups), fractional deltas (parsed int-first, then float+round),
    // a mid-stream backwards frame (dropped), a short segment (skipped), the
    // seed pseudo-frame, and a trailing empty segment
    private const string frame_payload_text =
        "0|256|-500|0," +
        "-500|256|-500|0," +
        "1000|100.5|100.25|0," +
        "16|110|105|1," +
        "16.5|120|110|5," +
        "15|130|115|7," +
        "-20|125|112|4," +
        "16|140|120|4," +
        "x|y," +
        "300|200|200|2," +
        "-12345|0|0|12345678,";

    private static void DumpFrameConversion(
        string outDir, JsonSerializerOptions jsonOptions, string osrName, string jsonName, string beatmapName, int version)
    {
        byte[] osrBytes = BuildOsr(version, frame_payload_text);
        File.WriteAllBytes(Path.Combine(outDir, "replays", $"{osrName}.osr"), osrBytes);

        var decoder = new FixtureScoreDecoder(Path.Combine(outDir, "beatmaps", $"{beatmapName}.osu"));
        using var stream = new MemoryStream(osrBytes);
        var score = decoder.Parse(stream);

        var frames = score.Replay.Frames.Cast<OsuReplayFrame>().Select(f => new
        {
            Time = f.Time,
            Pos = new[] { f.Position.X, f.Position.Y },
            Left = f.Actions.Contains(OsuAction.LeftButton),
            Right = f.Actions.Contains(OsuAction.RightButton),
            Smoke = f.Actions.Contains(OsuAction.Smoke),
        }).ToArray();

        File.WriteAllText(
            Path.Combine(outDir, "replays", $"{jsonName}.json"),
            JsonSerializer.Serialize(new { Frames = frames }, jsonOptions));
        Console.WriteLine($"frame conversion fixture {osrName}: {frames.Length} frames");
    }

    // minimal stable-era header around the payload; framing identical to the
    // hand-written builders in the rust decoder's own tests
    private static byte[] BuildOsr(int version, string payloadText)
    {
        using var ms = new MemoryStream();
        using var w = new BinaryWriter(ms);
        w.Write((byte)0); // osu! standard
        w.Write(version);
        WriteOsuString(w, "aabbccddeeff00112233445566778899");
        WriteOsuString(w, "fixture player");
        WriteOsuString(w, "99887766554433221100ffeeddccbbaa");
        foreach (ushort count in new ushort[] { 10, 2, 1, 0, 0, 1 })
            w.Write(count);
        w.Write(123456); // total score
        w.Write((ushort)42); // max combo
        w.Write((byte)0); // perfect
        w.Write(0); // nomod
        w.Write((byte)0); // life graph: absent
        w.Write(638712000000000000L); // timestamp ticks
        byte[] compressed = Compress(payloadText);
        w.Write(compressed.Length);
        w.Write(compressed);
        w.Write(0L); // online score id (version >= 20140721)
        w.Flush();
        return ms.ToArray();
    }

    private static void WriteOsuString(BinaryWriter w, string value)
    {
        w.Write((byte)0x0b);
        w.Write(value); // binarywriter.write(string) is 7-bit-length-prefixed utf-8, i.e. uleb128
    }

    // port of legacyscoreencoder.cs:134-152 -- lzma-alone: 5 props bytes,
    // 8-byte little-endian uncompressed size, then the raw stream
    private static byte[] Compress(string data)
    {
        byte[] content = System.Text.Encoding.ASCII.GetBytes(data);
        using var outStream = new MemoryStream();
        using (var lzma = LzmaStream.Create(new LzmaEncoderProperties(false, 1 << 21, 255), false, outStream))
        {
            outStream.Write(lzma.Properties);
            long fileSize = content.Length;
            for (int i = 0; i < 8; i++)
                outStream.WriteByte((byte)(fileSize >> (8 * i)));
            lzma.Write(content);
        }
        return outStream.ToArray();
    }

    private class FixtureScoreDecoder : LegacyScoreDecoder
    {
        private readonly string beatmapPath;

        public FixtureScoreDecoder(string beatmapPath)
        {
            this.beatmapPath = beatmapPath;
        }

        protected override Ruleset GetRuleset(int rulesetId) => new OsuRuleset();

        protected override WorkingBeatmap GetBeatmap(string md5Hash) => new FlatWorkingBeatmap(beatmapPath);
    }
}
