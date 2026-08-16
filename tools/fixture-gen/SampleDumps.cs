using System.Text.Json;
using osu.Game.Audio;
using osu.Game.Beatmaps;
using osu.Game.Rulesets.Objects;
using osu.Game.Rulesets.Objects.Legacy;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Objects;

namespace FixtureGen;

/// <summary>
/// hit sample resolution, read off lazer's own decoded beatmap AFTER
/// LegacyBeatmapDecoder.applySamples has applied the sample control points and
/// Slider.UpdateNestedSamples has distributed the nodes.
///
/// this is the resolution half of hitsounding: which sound each object and each
/// nested object asks for, as a skin-independent (bank, name, suffix, volume,
/// isLayered) lookup. it deliberately does NOT cover scheduling -- which sample
/// fires off which judgement and when is the viewer's own composition, with no
/// lazer analogue to dump, and is covered by frontend tests instead.
/// </summary>
public static class SampleDumps
{
    private static readonly string[] maps =
    {
        "samples-banks-v14",
        "samples-nodes-v14",
        "samples-sampleset-none-v14",
    };

    public static void Run(string outDir, JsonSerializerOptions jsonOptions)
    {
        Directory.CreateDirectory(Path.Combine(outDir, "samples"));
        var ruleset = new OsuRuleset();

        foreach (string name in maps)
        {
            var working = new FlatWorkingBeatmap(Path.Combine(outDir, "beatmaps", $"{name}.osu"));
            var playable = working.GetPlayableBeatmap(ruleset.RulesetInfo);

            var payload = new
            {
                Objects = playable.HitObjects.Cast<OsuHitObject>().Select(DumpObject).ToArray(),
            };

            File.WriteAllText(
                Path.Combine(outDir, "samples", $"{name}.json"),
                JsonSerializer.Serialize(payload, jsonOptions));
            Console.WriteLine($"sample dump {name}: {payload.Objects.Length} objects");
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
        // the object's own samples: what a circle or spinner sounds. a slider's
        // are never played as a unit -- they exist to derive the tick sample
        Samples = obj.Samples.Select(DumpSample).ToArray(),
        // one entry per node, in lazer's indexing: 0 is the head, n is repeat
        // n - 1, and the last is the tail (IHasRepeats.cs:21-28)
        NodeSamples = obj is Slider slider
            ? slider.NodeSamples.Select(node => node.Select(DumpSample).ToArray()).ToArray()
            : null,
        // the post-UpdateNestedSamples distribution, which is the mapping the
        // engine's render plan has to reproduce: head from node 0, repeat n
        // from node n + 1, tail from node repeatCount + 1, tick from the
        // slider's own hitnormal renamed to slidertick
        Nested = obj is Slider s ? DumpNested(s) : null,
    };

    private static object[] DumpNested(Slider slider)
    {
        var rows = new List<object>();

        foreach (var nested in slider.NestedHitObjects.Cast<OsuHitObject>())
        {
            rows.Add(new
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
                Samples = nested.Samples.Select(DumpSample).ToArray(),
            });
        }

        // the tail circle carries no samples of its own: lazer plays the tail
        // node from the slider itself, at the correct end time, because a
        // SliderTailCircle sits earlier than the real end (Slider.cs:285-289).
        // recorded separately so the engine's `tail` nested entry -- which DOES
        // carry them -- has something to compare against
        rows.Add(new
        {
            Kind = "tailSamples",
            SpanIndex = slider.RepeatCount,
            Time = slider.GetEndTime(),
            Samples = slider.TailSamples.Select(DumpSample).ToArray(),
        });

        return rows.ToArray();
    }

    private static object DumpSample(HitSampleInfo sample) => new
    {
        Bank = sample.Bank,
        Name = sample.Name,
        Suffix = sample.Suffix,
        Volume = sample.Volume,
        IsLayered = sample is ConvertHitObjectParser.LegacyHitSampleInfo legacy && legacy.IsLayered,
        Filename = sample is ConvertHitObjectParser.FileHitSampleInfo file ? file.Filename : null,
        // the ordered names a skin is asked for, highest preference first --
        // the one thing about a lookup that a source actually consumes
        LookupNames = sample.LookupNames.ToArray(),
    };
}
