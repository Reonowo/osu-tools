using System.Text.Json;
using osu.Framework.Extensions;
using osu.Game.Beatmaps;
using osu.Game.Rulesets.Objects.Legacy;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Difficulty.Utils;

namespace FixtureGen;

public static class ScoreDumps
{
    private static readonly string[] maps =
    {
        "stacking-v14",
        "old-format-v4",
        "slider-zoo-v14",
        "v7-tick-multiplier",
        "spinners-combos-od10",
        // od0 makes the simulator's hardcoded minimum_rotations_per_second
        // (the od-0 floor) exact rather than a worst-case bound, so an
        // overspun clear of this map achieves the dumped maximum exactly --
        // the committed oracle for the stable spinner tick model
        "spinner-od0",
    };

    // adversarial difficulty triples for the peppy-stars port: floats whose
    // doubles carry precision garbage (5.3f, 0.1f, ...) exercise .net's
    // double->decimal 15-significant-digit rounding; the exactly-representable
    // sets are constructed so (hp + od + cs + ratio) / 38 * 5 lands exactly on
    // a .5 tie, pinning the final banker's rounding in both directions; the
    // object/drain pairs cover the ratio clamp at both ends, the drain==0
    // sentinel, and stable's negative-drain corner (breaks longer than the
    // object span)
    private static readonly (float hp, float od, float cs, int objectCount, int drainLength)[] triples =
    {
        (5.3f, 4.2f, 6.6f, 1000, 60),
        (0.1f, 9.9f, 3.7f, 727, 99),
        (7.77777f, 1.23456f, 8.1f, 2500, 180),
        (9.999999f, 0.000001f, 5f, 300, 30),
        (0f, 0f, 0f, 1, 1),
        (10f, 10f, 10f, 100000, 1),
        (5f, 5f, 5f, 1, 100000),
        (6f, 7f, 8f, 1, 0),
        (4f, 4f, 4f, 100, -15),
        (2f, 3f, 4f, 1, 3),
        (1.5f, 1.5f, 0.75f, 1, 160),
        (5.5f, 5.25f, 0.25f, 1, 20),
        (9.5f, 9.25f, 0.25f, 0, 1),
        (10f, 10f, 6.5f, 1, 80),
    };

    // replay-hash cases: the username and header-tick pairs the engine's
    // pinned encoder port hashes. usernames cover empty, spaces, unicode
    // (multi-byte utf-8), and bracket/dash punctuation; tick values cover a
    // stable-era timestamp, sub-second remainders (the default DateTimeOffset
    // format truncates them), midnight and 23:59:59 wall times, the year-0001
    // epoch, and DateTime.MaxValue
    private static readonly (string username, long ticks)[] hashCases =
    {
        ("Cookiezi", 634062871680000000),
        ("peppy", 638500000001234567),
        ("", 638500000000000000),
        ("white space", 637134336000000000),
        ("ünïcøde", 637134336000000000),
        ("emoji 🐱", 638000000000000000),
        ("[Moonlit]", 638819999990000000),
        ("dash-name", 1),
        ("Max", 3155378975999999999),
        ("midnight", 638712864000000000),
    };

    public static void Run(string outDir, JsonSerializerOptions jsonOptions)
    {
        Directory.CreateDirectory(Path.Combine(outDir, "score"));

        DumpPeppyStars(outDir, jsonOptions);
        DumpLegacyScoreAttributes(outDir, jsonOptions);
        DumpReplayHashes(outDir, jsonOptions);
    }

    private static void DumpPeppyStars(string outDir, JsonSerializerOptions jsonOptions)
    {
        var payload = new
        {
            Triples = triples.Select(t =>
            {
                var difficulty = new BeatmapDifficulty
                {
                    DrainRate = t.hp,
                    OverallDifficulty = t.od,
                    CircleSize = t.cs,
                };
                return new
                {
                    Hp = t.hp,
                    Od = t.od,
                    Cs = t.cs,
                    ObjectCount = t.objectCount,
                    DrainLength = t.drainLength,
                    PeppyStars = LegacyRulesetExtensions.CalculateDifficultyPeppyStars(
                        difficulty, t.objectCount, t.drainLength),
                };
            }).ToArray(),
            Maps = maps.Select(name =>
            {
                var working = new FlatWorkingBeatmap(Path.Combine(outDir, "beatmaps", $"{name}.osu"));
                // the legacy computation reads the base (unconverted) beatmap,
                // matching OsuLegacyScoreSimulator.Simulate's own use of
                // workingBeatmap.Beatmap for difficulty, drain, and count
                IBeatmap baseBeatmap = working.Beatmap;

                // drain expression from LegacyScoreUtils.CalculateDifficultyPeppyStars
                // (osu.Game.Rulesets.Osu/Difficulty/Utils/LegacyScoreUtils.cs:95-99),
                // dumped separately so a rust drain mismatch localises apart
                // from the decimal arithmetic
                int objectCount = baseBeatmap.HitObjects.Count;
                int drainLength = 0;
                if (objectCount > 0)
                {
                    int breakLength = baseBeatmap.Breaks
                        .Select(b => (int)Math.Round(b.EndTime) - (int)Math.Round(b.StartTime)).Sum();
                    drainLength = ((int)Math.Round(baseBeatmap.HitObjects[^1].StartTime)
                        - (int)Math.Round(baseBeatmap.HitObjects[0].StartTime) - breakLength) / 1000;
                }

                return new
                {
                    Name = name,
                    Hp = baseBeatmap.Difficulty.DrainRate,
                    Od = baseBeatmap.Difficulty.OverallDifficulty,
                    Cs = baseBeatmap.Difficulty.CircleSize,
                    ObjectCount = objectCount,
                    DrainLength = drainLength,
                    PeppyStars = LegacyScoreUtils.CalculateDifficultyPeppyStars(baseBeatmap),
                };
            }).ToArray(),
        };

        File.WriteAllText(
            Path.Combine(outDir, "score", "peppy_stars.json"),
            JsonSerializer.Serialize(payload, jsonOptions));
        Console.WriteLine(
            $"score dump peppy_stars: {payload.Triples.Length} triples, {payload.Maps.Length} maps");
    }

    private static void DumpLegacyScoreAttributes(string outDir, JsonSerializerOptions jsonOptions)
    {
        var ruleset = new OsuRuleset();

        var payload = new
        {
            Maps = maps.Select(name =>
            {
                var working = new FlatWorkingBeatmap(Path.Combine(outDir, "beatmaps", $"{name}.osu"));
                var playable = working.GetPlayableBeatmap(ruleset.RulesetInfo);
                // OsuLegacyScoreSimulator is internal; the ruleset factory is
                // the public surface (OsuRuleset.cs:282)
                var attributes = ruleset.CreateLegacyScoreSimulator().Simulate(working, playable);

                return new
                {
                    Name = name,
                    AccuracyScore = attributes.AccuracyScore,
                    ComboScore = attributes.ComboScore,
                    BonusScore = attributes.BonusScore,
                    BonusScoreRatio = attributes.BonusScoreRatio,
                    MaxCombo = attributes.MaxCombo,
                };
            }).ToArray(),
        };

        File.WriteAllText(
            Path.Combine(outDir, "score", "legacy_score_attributes.json"),
            JsonSerializer.Serialize(payload, jsonOptions));
        Console.WriteLine($"score dump legacy_score_attributes: {payload.Maps.Length} maps");
    }

    private static void DumpReplayHashes(string outDir, JsonSerializerOptions jsonOptions)
    {
        var payload = new
        {
            Cases = hashCases.Select(c =>
            {
                // mirror LegacyScoreDecoder.cs:103 + SerializationReader.cs:62
                // exactly: the header ticks become a utc DateTime, implicitly
                // converted to the DateTimeOffset ScoreInfo.Date holds
                DateTimeOffset date = new DateTime(c.ticks, DateTimeKind.Utc);

                return new
                {
                    Username = c.username,
                    Ticks = c.ticks,
                    // the date leg of LegacyScoreEncoder.cs:105's interpolation,
                    // dumped separately so a formatting mismatch localises
                    // apart from the md5
                    DateString = FormattableString.Invariant($"{date}"),
                    Hash = FormattableString.Invariant($"lazer-{c.username}-{date}").ComputeMD5Hash(),
                };
            }).ToArray(),
        };

        File.WriteAllText(
            Path.Combine(outDir, "score", "replay_hash.json"),
            JsonSerializer.Serialize(payload, jsonOptions));
        Console.WriteLine($"score dump replay_hash: {payload.Cases.Length} cases");
    }
}
