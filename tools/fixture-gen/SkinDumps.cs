using System.Text.Json;
using osu.Framework.IO.Stores;
using osu.Game.Rulesets.Osu.Skinning;
using osu.Game.Skinning;
using osuTK.Graphics;

namespace FixtureGen;

/// <summary>
/// `skin.ini` decoding, read off lazer's own <see cref="LegacySkinDecoder"/> by
/// way of a real <see cref="LegacySkin"/> -- so the *skin*'s behaviour is what
/// is pinned, not just the decoder's. the two differ in one load-bearing place
/// and that place is why this goes through the skin: an ABSENT `skin.ini` gets
/// LATEST_VERSION with IsLatestVersion set (Skin.cs:108-113), while a PRESENT
/// one with no `Version` key gets the decoder's template default of 1.0
/// (LegacySkinDecoder.cs:66-72). a dump of the decoder alone could not tell
/// those apart, and the version field forks real drawing behaviour.
///
/// each scenario is a directory under `skin/inputs/`, holding at most a
/// `skin.ini`. inputs are hand-built to isolate one mechanic each and are never
/// a copy of anyone's actual skin -- that would be both a licence problem and a
/// non-reproducible input.
///
/// the dump records the decoded configuration AND what `GetConfig` answers for
/// every key this project honours, with `null` meaning "the skin did not say".
/// the consumer-side defaults (`?? "default"`, `?? -2f`, `?? true`) live at
/// their own call sites in lazer and are cited there in the port, not here:
/// this dump's job is to pin what the skin declared, not what a drawable does
/// when it declared nothing.
/// </summary>
public static class SkinDumps
{
    public static void Run(string outDir, JsonSerializerOptions jsonOptions)
    {
        string inputsDir = Path.Combine(outDir, "skin", "inputs");
        if (!Directory.Exists(inputsDir))
            throw new DirectoryNotFoundException($"skin scenario inputs missing: {inputsDir}");

        // ordinal sort so the run order is machine-order rather than
        // culture-order, which keeps the console log stable across machines
        var scenarios = Directory.GetDirectories(inputsDir)
                                 .Select(Path.GetFileName)
                                 .Where(name => name != null)
                                 .Select(name => name!)
                                 .OrderBy(name => name, StringComparer.Ordinal)
                                 .ToArray();

        foreach (string scenario in scenarios)
        {
            object payload = Dump(Path.Combine(inputsDir, scenario));

            File.WriteAllText(
                Path.Combine(outDir, "skin", $"{scenario}.json"),
                JsonSerializer.Serialize(payload, jsonOptions));
            Console.WriteLine($"skin dump {scenario}");
        }
    }

    private static object Dump(string scenarioDir)
    {
        // a plain directory-backed byte store standing in for realm user
        // storage: Skin's `resources` argument is nullable precisely so a skin
        // can be constructed without a game host (Skin.cs:80-92), and the
        // fallback store is the documented way to feed it files
        using var store = new DirectoryResourceStore(scenarioDir);
        using var skin = new ScenarioSkin(
            new SkinInfo { Name = Path.GetFileName(scenarioDir) },
            store);

        var config = skin.Configuration;

        return new
        {
            IniPresent = File.Exists(Path.Combine(scenarioDir, "skin.ini")),
            // SkinInfo.Name/Creator start as the empty string rather than null,
            // so an absent [General] Name is "" here -- which is exactly the
            // case the picker's folder-name fallback exists for
            Name = config.SkinInfo.Name,
            Author = config.SkinInfo.Creator,
            LegacyVersion = config.LegacyVersion,
            // what LegacySetting.Version actually answers: the declared version
            // or LATEST_VERSION (LegacySkin.cs:334-335). this is the value every
            // version fork in the drawing code compares against
            EffectiveVersion = Lookup<decimal>(skin, SkinConfiguration.LegacySetting.Version),
            // the raw declared list, before the default-palette fallback
            CustomComboColours = config.CustomComboColours.Select(DumpColour).ToArray(),
            // and after it: SkinConfiguration.ComboColours, which substitutes the
            // classic four when the skin declared none and the fallback is
            // allowed (SkinConfiguration.cs:57-66)
            ComboColours = config.ComboColours?.Select(DumpColour).ToArray(),
            CustomColours = config.CustomColours
                                  .OrderBy(entry => entry.Key, StringComparer.Ordinal)
                                  .ToDictionary(entry => entry.Key, entry => DumpColour(entry.Value)),
            ConfigDictionary = config.ConfigDictionary
                                     .OrderBy(entry => entry.Key, StringComparer.Ordinal)
                                     .ToDictionary(entry => entry.Key, entry => entry.Value),
            Settings = new
            {
                AnimationFramerate = Lookup<int>(skin, SkinConfiguration.LegacySetting.AnimationFramerate),
                LayeredHitSounds = Lookup<bool>(skin, SkinConfiguration.LegacySetting.LayeredHitSounds),
                AllowSliderBallTint = Lookup<bool>(skin, SkinConfiguration.LegacySetting.AllowSliderBallTint),
                ComboPrefix = Lookup<string>(skin, SkinConfiguration.LegacySetting.ComboPrefix),
                ComboOverlap = Lookup<float>(skin, SkinConfiguration.LegacySetting.ComboOverlap),
                HitCirclePrefix = Lookup<string>(skin, SkinConfiguration.LegacySetting.HitCirclePrefix),
                HitCircleOverlap = Lookup<float>(skin, SkinConfiguration.LegacySetting.HitCircleOverlap),
                CursorCentre = Lookup<bool>(skin, OsuSkinConfiguration.CursorCentre),
                CursorExpand = Lookup<bool>(skin, OsuSkinConfiguration.CursorExpand),
                CursorRotate = Lookup<bool>(skin, OsuSkinConfiguration.CursorRotate),
                CursorTrailRotate = Lookup<bool>(skin, OsuSkinConfiguration.CursorTrailRotate),
                // both spellings, because lazer honours the typo'd one as a
                // fallback (OsuLegacySkinTransformer.cs:308-312) and the port
                // has to reproduce that fallback rather than the typo itself
                HitCircleOverlayAboveNumber = Lookup<bool>(skin, OsuSkinConfiguration.HitCircleOverlayAboveNumber),
                HitCircleOverlayAboveNumer = Lookup<bool>(skin, OsuSkinConfiguration.HitCircleOverlayAboveNumer),
                SpinnerFrequencyModulate = Lookup<bool>(skin, OsuSkinConfiguration.SpinnerFrequencyModulate),
                SpinnerNoBlink = Lookup<bool>(skin, OsuSkinConfiguration.SpinnerNoBlink),
            },
        };
    }

    /// <summary>
    /// null when the skin did not answer -- the distinction the whole dump turns
    /// on, since a consumer default only applies to a null. boxed rather than
    /// returned as `T?` so that a declared `false` and an absent key stay
    /// distinguishable for value types too, which is the case that matters:
    /// `LayeredHitSounds: 0` is a decision and an absent one is not.
    /// </summary>
    private static object? Lookup<T>(LegacySkin skin, object key)
        where T : notnull
    {
        var bindable = key switch
        {
            SkinConfiguration.LegacySetting legacy => skin.GetConfig<SkinConfiguration.LegacySetting, T>(legacy),
            OsuSkinConfiguration osu => skin.GetConfig<OsuSkinConfiguration, T>(osu),
            _ => throw new ArgumentException($"unhandled lookup key type: {key.GetType()}", nameof(key)),
        };

        return bindable == null ? null : bindable.Value;
    }

    private static object DumpColour(Color4 colour) => new
    {
        R = ToByte(colour.R),
        G = ToByte(colour.G),
        B = ToByte(colour.B),
        A = ToByte(colour.A),
    };

    // Color4 stores normalised floats; the ini declared bytes. round-trip
    // through the same /255 the framework's byte constructor used so the dump
    // records what was written rather than a float artefact of it
    private static int ToByte(float component) => (int)Math.Round(component * 255f);

    /// <summary>
    /// a <see cref="LegacySkin"/> over one scenario directory. subclassed only
    /// to reach the protected constructor that takes a fallback store -- no
    /// behaviour is overridden, so every value dumped is lazer's own.
    /// </summary>
    private sealed class ScenarioSkin : LegacySkin
    {
        public ScenarioSkin(SkinInfo skin, IResourceStore<byte[]> fallbackStore)
            : base(skin, null, fallbackStore)
        {
        }
    }

    /// <summary>
    /// the scenario directory as an <see cref="IResourceStore{T}"/>. deliberately
    /// tiny and deliberately NOT recursive: a scenario is one `skin.ini` and the
    /// dump must not start depending on stray files beside it.
    /// </summary>
    private sealed class DirectoryResourceStore : IResourceStore<byte[]>
    {
        private readonly string directory;

        public DirectoryResourceStore(string directory) => this.directory = directory;

        public byte[]? Get(string name)
        {
            string path = Path.Combine(directory, name);
            return File.Exists(path) ? File.ReadAllBytes(path) : null;
        }

        public Task<byte[]?> GetAsync(string name, CancellationToken cancellationToken = default) =>
            Task.FromResult(Get(name));

        public Stream? GetStream(string name)
        {
            string path = Path.Combine(directory, name);
            return File.Exists(path) ? File.OpenRead(path) : null;
        }

        public IEnumerable<string> GetAvailableResources() =>
            Directory.EnumerateFiles(directory)
                     .Select(Path.GetFileName)
                     .Where(name => name != null)
                     .Select(name => name!);

        public void Dispose()
        {
        }
    }
}
