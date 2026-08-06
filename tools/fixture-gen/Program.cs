using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

// pins — keep in sync with the spec; bumping either requires regenerating all fixtures
const string osuPin = "83b8a64bec19e1463353645c2d6d10c75e275b43";
const string frameworkPin = "2026.731.0";

string outDir = "fixtures";
for (int i = 0; i < args.Length - 1; i++)
{
    if (args[i] == "--out")
        outDir = args[i + 1];
}

Directory.CreateDirectory(outDir);
Directory.CreateDirectory(Path.Combine(outDir, "path"));

// path/approximator_circular_arc.json's arc-huge-radius-zero-acos case depends
// on the pre-.NET-9 x86/x64 unchecked `(int)someDouble` cast, which truncates a
// non-finite double to int.MinValue rather than saturating (see
// engine::math::dotnet_double_to_i32_unchecked's doc comment and
// fixtures/README.md for the full mechanism and the .NET 9 breaking-change
// reference). on a saturating runtime (.NET 9+, or Arm64 even before that),
// PathApproximator.CircularArcToPiecewiseLinear computes an amountPoints of
// int.MaxValue for that case and tries to allocate a ~2-billion-element
// List<Vector2>, which fails with a baffling OutOfMemoryException instead of a
// clean fixture diff. probe for this up front with an actual runtime division
// (not a literal, so it cannot be constant-folded away) and fail fast with a
// clear diagnosis instead.
{
    double zero = 0.0;
    double runtimeInfinity = 1.0 / zero;
    int probeResult = (int)runtimeInfinity;
    if (probeResult != int.MinValue)
    {
        Console.Error.WriteLine(
            $"fixture-gen requires a pre-.NET-9 x86/x64 runtime: (int)(1.0/0.0) is {probeResult} here, " +
            "not int.MinValue. the circular-arc fixture's arc-huge-radius-zero-acos case depends on the " +
            "pre-.NET-9 non-saturating float-to-int conversion on x86/x64 (see fixtures/README.md); " +
            "regenerate on x86/x64 with the pinned SDK instead of this runtime/architecture.");
        Environment.Exit(1);
    }
}

// strict by default: a non-finite number anywhere in a fixture throws instead of
// serialising, which is the tripwire that catches an accidental NaN/Infinity
var jsonOptions = new JsonSerializerOptions
{
    WriteIndented = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
};

// scoped to path/slider_path.json alone. SliderPath.GetSegmentEnds divides each
// segment-end distance by Distance with no zero guard (SliderPath.cs:267), so any
// case whose expected distance collapses the path to zero length -- expected-zero
// (Distance becomes 0 via the pathEndIndex <= 0 branch) and
// zero-length-all-identical (0/0) -- yields Infinity/NaN. those are real,
// load-bearing lazer outputs the port must reproduce, so that one file emits them
// as JSON's named floating point literals ("Infinity", "NaN"). every other fixture
// keeps the strict options above, so an accidental non-finite value there still
// fails loudly at generation time
var namedFloatLiteralJsonOptions = new JsonSerializerOptions
{
    WriteIndented = true,
    PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
    NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
};

void Dump(string relativePath, object payload) =>
    File.WriteAllText(Path.Combine(outDir, relativePath), JsonSerializer.Serialize(payload, jsonOptions));

void DumpAllowingNamedFloatLiterals(string relativePath, object payload) =>
    File.WriteAllText(
        Path.Combine(outDir, relativePath),
        JsonSerializer.Serialize(payload, namedFloatLiteralJsonOptions));

// the checkout MSBuild resolved the ProjectReference against is the one whose
// sources computed every value dumped below, so it is the only answer that can
// honestly describe this run's provenance -- it therefore wins outright rather
// than merely supplying a default. letting OSU_CHECKOUT override it would
// reopen exactly the split this is here to close: `OSU_CHECKOUT=A dotnet run
// -p:OsuCheckout=B` would compile against B and record A's head. OSU_CHECKOUT
// is consulted only when the baked value is missing, i.e. an assembly built
// before this metadata existed; `-p:OsuCheckout=<path>` is the single knob that
// moves both the reference and the recorded head together.
//
// if the sources moved after the build, ReadGitHead simply reports "unknown",
// which is the honest answer -- better than confidently recording the head of
// some other directory that did not produce these fixtures
string checkoutRoot = CompiledOsuCheckout()
                      ?? Environment.GetEnvironmentVariable("OSU_CHECKOUT")
                      ?? @"C:\Users\admin\Desktop\osu_ref\osu!lazer source";
string actualHead = ReadGitHead(checkoutRoot);
string workingTree = ReadWorkingTreeState(checkoutRoot);

if (actualHead != osuPin)
    Console.Error.WriteLine($"warning: checkout head {actualHead} != pinned {osuPin}");

// a matching HEAD is not on its own evidence that the pinned sources are what
// compiled: an edited working tree builds modified code while HEAD still reads
// 83b8a64, and every fixture below would then be attributed to a commit that did
// not produce it. this is a live hazard rather than a theoretical one -- pinning
// down the pre-.NET-9 cast behaviour recorded in the notes involved temporarily
// instrumenting this very checkout -- so the state is recorded next to the head
// and warned about loudly
if (workingTree != "clean")
    Console.Error.WriteLine(
        $"warning: reference checkout working tree is {workingTree}; fixtures generated now are NOT " +
        $"attributable to {actualHead} alone");

Dump("meta.json", new
{
    OsuPin = osuPin,
    FrameworkPin = frameworkPin,
    CheckoutHead = actualHead,
    CheckoutWorkingTree = workingTree,
    Tolerances = new { Position = 1e-4, Distance = 1e-3, Ratio = 1e-6 },
    Notes = new[]
    {
        "path/approximator_circular_arc.json's arc-huge-radius-zero-acos case is reproducible only " +
        "on x86/x64 with a pre-.NET-9 runtime: it depends on an unchecked (int) cast of a non-finite " +
        "double truncating to int.MinValue (pre-.NET-9 x86/x64 behaviour) rather than saturating " +
        "(.NET 9+, and Arm64 even before that). see fixtures/README.md for the full explanation; " +
        "this tool probes for the wrong behaviour at startup and fails fast rather than let a " +
        "regeneration attempt on the wrong runtime silently corrupt this fixture.",

        "path/slider_path.json inherits the same x86/x64 pre-.NET-9 runtime dependency: " +
        "SliderPath.cs:355 duplicates the arc point-count expression to decide whether a " +
        "PerfectCurve segment gets a circular arc or degrades to a B-spline, and the same " +
        "unchecked (int) cast of +Infinity to int.MinValue is what makes the guard fall through " +
        "to the arc branch. its perfect-huge-radius-takes-arc case (circumradius ~4.7e6) records " +
        "the arc branch at 3 vertices; on a saturating runtime that case would record ~129 " +
        "vertices from the B-spline branch instead.",

        "path/slider_path.json contains JSON's named floating point literals: " +
        "segment_ends_progress entries can be the strings \"Infinity\" or \"NaN\", " +
        "because SliderPath.GetSegmentEnds (SliderPath.cs:267) divides each segment-end distance " +
        "by Distance with no zero guard and Distance is genuinely 0 for the expected-zero and " +
        "zero-length-all-identical cases. readers must accept a JSON string in that float " +
        "position and compare non-finite expectations by classification rather than by " +
        "subtraction.",

        "beatmap/*.json also contain JSON's named floating point literals, for the same reason: " +
        "slider-zoo-v14.json's third slider sits under the 8000,NaN inherited timing point, which " +
        "disables tick generation (Slider.cs:169) and makes lazer's TickDistance genuinely " +
        "+Infinity for that slider, so its dump's tick_distance field is the JSON string " +
        "\"Infinity\". readers must accept that and compare it by classification " +
        "(is_infinite), same as segment_ends_progress above. every fixture not named in these " +
        "two notes (approximator_bspline.json, approximator_catmull.json, " +
        "approximator_circular_arc.json, replays/float_format.json) is still written with strict " +
        "number handling, so an accidental non-finite value in one of those would still throw at " +
        "generation time.",
    },
});

// float formatting fixture: (bits, expected string) pairs probing the
// shortest-round-trip tie-break (round-half-to-even) that rust's own
// away-from-zero tie-break diverges from. this is exactly the formatting
// LegacyScoreEncoder.replayStringContent uses for every replay frame
// coordinate: FormattableString.Invariant($"{legacyFrame.MouseX ?? 0}")
{
    Directory.CreateDirectory(Path.Combine(outDir, "replays"));

    static string FormatFloat(float v) => FormattableString.Invariant($"{v}");

    // finds values where .net's shortest round-trip digits end in an even
    // digit that is *also* a genuine tie candidate: incrementing that last
    // digit by one still round-trips to the identical bit pattern. rust's own
    // away-from-zero rule always picks the larger-magnitude (incremented, odd)
    // side of a real tie, so these are exactly the cases that exercise the
    // divergence between the two languages
    static bool IsGenuineTie(float v)
    {
        string s = FormatFloat(v);
        int eIdx = s.IndexOf('E');
        int lastDigitIdx = (eIdx >= 0 ? eIdx : s.Length) - 1;
        char lastDigit = s[lastDigitIdx];
        if (!char.IsDigit(lastDigit) || (lastDigit - '0') % 2 != 0)
            return false;

        var chars = s.ToCharArray();
        chars[lastDigitIdx] = (char)(lastDigit + 1);
        string candidate = new string(chars);
        return float.TryParse(candidate, NumberStyles.Float, CultureInfo.InvariantCulture, out float parsed)
            && BitConverter.SingleToUInt32Bits(parsed) == BitConverter.SingleToUInt32Bits(v);
    }

    var entries = new List<object>();
    var seenBits = new HashSet<uint>();

    void AddCase(float v)
    {
        uint bits = BitConverter.SingleToUInt32Bits(v);
        if (!seenBits.Add(bits))
            return;
        entries.Add(new { Bits = bits, Expected = FormatFloat(v) });
    }

    // deliberate cases: signs, zero/negative zero, integral values, the
    // notation-switch boundaries (.net's default float format is fixed in
    // roughly [1e-4, 1e9) and scientific outside it), and magnitudes near
    // f32's dynamic range limits
    float[] deliberate =
    {
        0f, -0f, 1f, -1f, 256f, -256f, 0.5f, -0.5f, 3000f, -3000f, 512f, 384f,
        100000f, 1e-4f, 1e-5f, 1e8f, 1e9f, 1e-38f, float.Epsilon,
        float.MaxValue, -float.MaxValue, float.PositiveInfinity, float.NegativeInfinity, float.NaN,
        // the two counterexamples the review flagged: genuine ties where rust's
        // away-from-zero pick and .net's round-to-even pick differ
        -1211.78125f, 2966.03125f,
    };
    foreach (float v in deliberate)
        AddCase(v);

    // playfield-range sample: real replay mouse coordinates live in roughly
    // this range (osu!'s 512x384 field plus cursor overshoot margin)
    var rng = new Random(20260801);
    for (int i = 0; i < 300; i++)
        AddCase((float)(rng.NextDouble() * 6000 - 3000));

    // scan for genuine round-half-to-even ties across the full float magnitude
    // range: rare (well under 1% of random bit patterns) but exactly what
    // distinguishes .net's tie-break from rust's, so the fixture needs a real
    // sample of them rather than relying on the two hand-picked cases alone
    const int tieTarget = 300;
    int tiesFound = 0;
    var bitBuf = new byte[4];
    for (int i = 0; i < 5_000_000 && tiesFound < tieTarget; i++)
    {
        rng.NextBytes(bitBuf);
        uint bits = BitConverter.ToUInt32(bitBuf, 0);
        float v = BitConverter.UInt32BitsToSingle(bits);
        if (!float.IsFinite(v) || v == 0f)
            continue;
        if (IsGenuineTie(v))
        {
            AddCase(v);
            tiesFound++;
        }
    }

    Console.WriteLine($"float_format fixture: {entries.Count} entries ({tiesFound} confirmed round-to-even ties found via random scan)");
    Dump(Path.Combine("replays", "float_format.json"), entries);
}

DumpBsplineFixtures();

void DumpBsplineFixtures()
{
    var cases = FixtureGen.PathCases.Bsplines.Select(c =>
    {
        var points = c.Points.Select(p => new osuTK.Vector2(p.X, p.Y)).ToArray();
        var vertices = c.Degree is int degree
            ? osu.Framework.Utils.PathApproximator.BSplineToPiecewiseLinear(points, degree)
            : osu.Framework.Utils.PathApproximator.BezierToPiecewiseLinear(points);
        return new
        {
            c.Name,
            ControlPoints = c.Points.Select(p => new[] { p.X, p.Y }).ToArray(),
            c.Degree,
            Vertices = vertices.Select(v => new[] { v.X, v.Y }).ToArray(),
        };
    }).ToArray();
    Dump(Path.Combine("path", "approximator_bspline.json"), new { Cases = cases });
}

DumpCatmullFixtures();

void DumpCatmullFixtures()
{
    object Entry(FixtureGen.ApproximatorCase c, Func<osuTK.Vector2[], List<osuTK.Vector2>> f)
    {
        var points = c.Points.Select(p => new osuTK.Vector2(p.X, p.Y)).ToArray();
        return new
        {
            c.Name,
            ControlPoints = c.Points.Select(p => new[] { p.X, p.Y }).ToArray(),
            Vertices = f(points).Select(v => new[] { v.X, v.Y }).ToArray(),
        };
    }

    Dump(Path.Combine("path", "approximator_catmull.json"), new
    {
        Catmull = FixtureGen.PathCases.Catmulls
            .Select(c => Entry(c, p => osu.Framework.Utils.PathApproximator.CatmullToPiecewiseLinear(p)))
            .ToArray(),
        Linear = FixtureGen.PathCases.Linears
            .Select(c => Entry(c, p => osu.Framework.Utils.PathApproximator.LinearToPiecewiseLinear(p)))
            .ToArray(),
    });
}

DumpArcFixtures();

void DumpArcFixtures()
{
    var cases = FixtureGen.PathCases.Arcs.Select(c =>
    {
        var points = c.Points.Select(p => new osuTK.Vector2(p.X, p.Y)).ToArray();
        var pr = new osu.Framework.Utils.CircularArcProperties(points);
        var vertices = osu.Framework.Utils.PathApproximator.CircularArcToPiecewiseLinear(points);
        return new
        {
            c.Name,
            ControlPoints = c.Points.Select(p => new[] { p.X, p.Y }).ToArray(),
            Properties = new
            {
                pr.IsValid,
                pr.ThetaStart,
                pr.ThetaRange,
                pr.Direction,
                pr.Radius,
                Centre = new[] { pr.Centre.X, pr.Centre.Y },
            },
            Vertices = vertices.Select(v => new[] { v.X, v.Y }).ToArray(),
        };
    }).ToArray();
    Dump(Path.Combine("path", "approximator_circular_arc.json"), new { Cases = cases });
}

DumpSliderPathFixtures();

void DumpSliderPathFixtures()
{
    double[] progressSamples = Enumerable.Range(0, 21).Select(i => i / 20.0)
        .Concat(new[] { -0.5, 1.5 }).ToArray();
    (double, double)[] ranges = { (0, 1), (0.25, 0.75), (0.3, 0.3), (0.9, 1.0) };

    var cases = FixtureGen.PathCases.SliderPaths.Select(c =>
    {
        var controlPoints = c.Points.Select(p => new osu.Game.Rulesets.Objects.PathControlPoint(
            new osuTK.Vector2(p.X, p.Y), ParsePathType(p))).ToArray();
        var slider = new osu.Game.Rulesets.Objects.SliderPath(controlPoints, c.ExpectedDistance)
        {
            OptimiseCatmull = c.OptimiseCatmull,
        };

        var pathToProgress = ranges.Select(r =>
        {
            var buffer = new List<osuTK.Vector2>();
            slider.GetPathToProgress(buffer, r.Item1, r.Item2);
            return new
            {
                P0 = r.Item1,
                P1 = r.Item2,
                Vertices = buffer.Select(v => new[] { v.X, v.Y }).ToArray(),
            };
        }).ToArray();

        return new
        {
            c.Name,
            ControlPoints = c.Points.Select(p => new
            {
                Pos = new[] { p.X, p.Y },
                p.Type,
                p.Degree,
            }).ToArray(),
            c.ExpectedDistance,
            c.OptimiseCatmull,
            Vertices = slider.CalculatedPath.Select(v => new[] { v.X, v.Y }).ToArray(),
            Distance = slider.Distance,
            CalculatedDistance = slider.CalculatedDistance,
            SegmentEndsProgress = slider.GetSegmentEnds().ToArray(),
            PositionAt = progressSamples.Select(p =>
            {
                var pos = slider.PositionAt(p);
                return new { Progress = p, Pos = new[] { pos.X, pos.Y } };
            }).ToArray(),
            PathToProgress = pathToProgress,
        };
    }).ToArray();

    foreach (var c in cases)
        Console.WriteLine($"slider_path {c.Name}: {c.Vertices.Length} vertices, {c.SegmentEndsProgress.Length} segment ends, distance {c.Distance}, calculated {c.CalculatedDistance}");

    DumpAllowingNamedFloatLiterals(Path.Combine("path", "slider_path.json"), new { Cases = cases });
}

// slider-zoo-v14's 8000,NaN inherited timing point disables tick generation
// for the slider active at that time (Slider.cs:169), which makes lazer
// compute that slider's TickDistance as +Infinity -- the strict jsonOptions
// above would throw serialising it. this is the same shape of problem
// path/slider_path.json's segment_ends_progress already has, so it gets the
// same fix: the named-float-literal options, and readers accept a JSON
// string in that field's position (see slider_path_fixtures.rs's
// deserialize_lenient_f64_list for the established rust-side convention)
DumpBeatmapFixtures();

void DumpBeatmapFixtures() => FixtureGen.BeatmapDumps.Run(outDir, namedFloatLiteralJsonOptions);

FixtureGen.ReplayDumps.Run(outDir, jsonOptions);

DumpEasingFixtures();

void DumpEasingFixtures()
{
    // 33 samples at i/32: hits both endpoints and the exact 0.5 branch
    // boundary every InOut easing switches on
    double[] samples = Enumerable.Range(0, 33).Select(i => i / 32.0).ToArray();

    var cases = Enum.GetValues<osu.Framework.Graphics.Easing>()
        .Select(easing => new
        {
            Name = easing.ToString(),
            Values = samples
                .Select(t => new osu.Framework.Graphics.Transforms.DefaultEasingFunction(easing).ApplyEasing(t))
                .ToArray(),
        })
        .ToArray();

    Dump("easing.json", new { Samples = samples, Cases = cases });
}

static osu.Game.Rulesets.Objects.Types.PathType? ParsePathType(FixtureGen.Cp p) => p.Type switch
{
    null => null,
    "Bezier" => osu.Game.Rulesets.Objects.Types.PathType.BEZIER,
    "Linear" => osu.Game.Rulesets.Objects.Types.PathType.LINEAR,
    "Catmull" => osu.Game.Rulesets.Objects.Types.PathType.CATMULL,
    "PerfectCurve" => osu.Game.Rulesets.Objects.Types.PathType.PERFECT_CURVE,
    "BSpline" => osu.Game.Rulesets.Objects.Types.PathType.BSpline(p.Degree!.Value),
    _ => throw new InvalidOperationException($"unknown path type {p.Type}"),
};

Console.WriteLine($"fixtures written to {Path.GetFullPath(outDir)}");

// the OsuCheckout MSBuild property, baked in by fixture-gen.csproj at build
// time. null when the attribute is absent or empty, so the caller can fall
// through to its last-resort default
static string? CompiledOsuCheckout()
{
    string? value = System.Reflection.Assembly.GetExecutingAssembly()
        .GetCustomAttributes(typeof(System.Reflection.AssemblyMetadataAttribute), false)
        .Cast<System.Reflection.AssemblyMetadataAttribute>()
        .FirstOrDefault(attribute => attribute.Key == "OsuCheckout")
        ?.Value;

    return string.IsNullOrWhiteSpace(value) ? null : value;
}

// "clean", "dirty", or "unknown". tracked modifications, staged changes and
// untracked-but-not-ignored files all count as dirty -- a stray instrumented .cs
// file compiles into osu.Game just as surely as an edit to a tracked one. this
// shells out to git rather than reading .git directly (as ReadGitHead does)
// because there is no cheap file-level way to answer it; if git is unavailable,
// fails, or hangs, the answer is "unknown", reported honestly rather than
// assumed clean.
//
// known gap: git-ignored files are NOT reported, and the SDK's default
// **/*.cs compile glob will happily build one. the pinned checkout ignores two
// such names outright (.gitignore:193-194, orleans.codegen.cs and
// Resource.designer.cs), so an untracked file at one of those exact paths would
// compile while this still reads "clean". `--ignored` is not the answer: every
// ordinary build fills bin/ and obj/, so it would report "dirty" essentially
// always and train the reader to ignore the warning. instrumenting the
// reference sources means editing tracked files, which is caught
static string ReadWorkingTreeState(string repoRoot)
{
    const int timeoutMilliseconds = 30_000;

    try
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = "git",
            ArgumentList = { "--git-dir", Path.Combine(repoRoot, ".git"), "--work-tree", repoRoot, "status", "--porcelain", "--untracked-files=normal" },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        });

        if (process is null)
            return "unknown";

        // both pipes must be drained concurrently with the wait. reading stdout
        // to completion first would deadlock the moment git writes more to
        // stderr than the pipe buffer holds (a few KiB of "warning: could not
        // open directory" is plenty): git blocks writing stderr, so it never
        // exits, so stdout never reaches EOF, so the read never returns
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();

        if (!process.WaitForExit(timeoutMilliseconds))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // already gone, or not ours to kill -- "unknown" either way
            }

            return "unknown";
        }

        // the bool overload returning true does not guarantee the async readers
        // have flushed; the parameterless call after it does
        process.WaitForExit();
        string output = stdout.GetAwaiter().GetResult();
        stderr.GetAwaiter().GetResult();

        if (process.ExitCode != 0)
            return "unknown";

        return string.IsNullOrWhiteSpace(output) ? "clean" : "dirty";
    }
    catch
    {
        return "unknown";
    }
}

static string ReadGitHead(string repoRoot)
{
    try
    {
        string head = File.ReadAllText(Path.Combine(repoRoot, ".git", "HEAD")).Trim();
        if (!head.StartsWith("ref: "))
            return head;

        string refPath = Path.Combine(repoRoot, ".git", head[5..].Replace('/', Path.DirectorySeparatorChar));
        return File.Exists(refPath) ? File.ReadAllText(refPath).Trim() : "unknown";
    }
    catch
    {
        return "unknown";
    }
}
