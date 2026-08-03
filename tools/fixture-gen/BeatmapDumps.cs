using System.Text.Json;
using osu.Game.Beatmaps;
using osu.Game.Rulesets.Objects;
using osu.Game.Rulesets.Objects.Types;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Objects;
using osu.Game.Rulesets.Osu.Scoring;
using osu.Game.Rulesets.Scoring;

namespace FixtureGen;

public static class BeatmapDumps
{
    private static readonly string[] maps =
    {
        "stacking-v14",
        "old-format-v4",
        "slider-zoo-v14",
        "v7-tick-multiplier",
        "spinners-combos-od10",
    };

    // slider-zoo-v14's 8000,NaN inherited point disables tick generation
    // (Slider.cs:169), which serialises TickDistance as +Infinity for that
    // slider's dump -- the caller must pass jsonOptions with
    // JsonNumberHandling.AllowNamedFloatingPointLiterals (see Program.cs's
    // namedFloatLiteralJsonOptions) or serialisation throws
    public static void Run(string outDir, JsonSerializerOptions jsonOptions)
    {
        Directory.CreateDirectory(Path.Combine(outDir, "beatmap"));
        var ruleset = new OsuRuleset();

        foreach (string name in maps)
        {
            var working = new FlatWorkingBeatmap(Path.Combine(outDir, "beatmaps", $"{name}.osu"));
            // no mods: classic behaviours only change judgement semantics,
            // which live rust-side; geometry/timing dumps are mod-free
            var playable = working.GetPlayableBeatmap(ruleset.RulesetInfo);

            var windows = new OsuHitWindows();
            windows.SetDifficulty(playable.Difficulty.OverallDifficulty);

            var payload = new
            {
                FormatVersion = playable.BeatmapVersion,
                StackLeniency = playable.StackLeniency,
                Windows = new
                {
                    Great = windows.WindowFor(HitResult.Great),
                    Ok = windows.WindowFor(HitResult.Ok),
                    Meh = windows.WindowFor(HitResult.Meh),
                },
                Objects = playable.HitObjects.Cast<OsuHitObject>().Select(DumpObject).ToArray(),
            };

            File.WriteAllText(
                Path.Combine(outDir, "beatmap", $"{name}.json"),
                JsonSerializer.Serialize(payload, jsonOptions));
            Console.WriteLine($"beatmap dump {name}: {payload.Objects.Length} objects");
        }
    }

    private static object DumpObject(OsuHitObject obj) => new
    {
        Kind = obj switch
        {
            Slider => "slider",
            Spinner => "spinner",
            _ => "circle",
        },
        StartTime = obj.StartTime,
        EndTime = obj.GetEndTime(),
        Position = new[] { obj.Position.X, obj.Position.Y },
        StackedPosition = new[] { obj.StackedPosition.X, obj.StackedPosition.Y },
        StackHeight = obj.StackHeight,
        Scale = obj.Scale,
        Preempt = obj.TimePreempt,
        FadeIn = obj.TimeFadeIn,
        ComboIndex = obj.ComboIndex,
        ComboIndexWithOffsets = obj.ComboIndexWithOffsets,
        IndexInCurrentCombo = obj.IndexInCurrentCombo,
        LastInCombo = obj.LastInCombo,
        Slider = obj is Slider slider ? DumpSlider(slider) : null,
        Spinner = obj is Spinner spinner
            ? new
            {
                Duration = spinner.Duration,
                SpinsRequired = spinner.SpinsRequired,
                MaximumBonusSpins = spinner.MaximumBonusSpins,
            }
            : null,
    };

    private static object DumpSlider(Slider slider) => new
    {
        Velocity = slider.Velocity,
        TickDistance = slider.TickDistance,
        SpanDuration = slider.SpanDuration,
        Duration = slider.Duration,
        EndPosition = new[] { slider.EndPosition.X, slider.EndPosition.Y },
        Nested = slider.NestedHitObjects.Cast<OsuHitObject>().Select(nested => new
        {
            Kind = nested switch
            {
                SliderHeadCircle => "head",
                SliderTick => "tick",
                SliderRepeat => "repeat",
                SliderTailCircle => "tail",
                _ => throw new InvalidOperationException($"unexpected nested {nested.GetType()}"),
            },
            SpanIndex = nested switch
            {
                SliderTick tick => tick.SpanIndex,
                SliderRepeat repeat => repeat.RepeatIndex,
                SliderTailCircle tail => tail.RepeatIndex,
                _ => 0,
            },
            Time = nested.StartTime,
            Position = new[] { nested.Position.X, nested.Position.Y },
            StackedPosition = new[] { nested.StackedPosition.X, nested.StackedPosition.Y },
            PathProgress = nested switch
            {
                SliderTick tick => (double?)tick.PathProgress,
                SliderRepeat repeat => repeat.PathProgress,
                _ => null,
            },
            Preempt = nested.TimePreempt,
            FadeIn = nested.TimeFadeIn,
        }).ToArray(),
        BallSamples = Enumerable.Range(0, 21).Select(i =>
        {
            double progress = i / 20.0;
            var pos = slider.CurvePositionAt(progress);
            return new { Progress = progress, Pos = new[] { pos.X, pos.Y } };
        }).ToArray(),
    };
}
