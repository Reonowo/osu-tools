using System.Text.Json;
using osu.Framework;
using osu.Framework.Allocation;
using osu.Framework.Configuration;
using osu.Framework.Graphics;
using osu.Framework.Platform;
using osu.Framework.Timing;
using osu.Game;
using osu.Game.Beatmaps;
using osu.Game.Online.API.Requests.Responses;
using osu.Game.Replays;
using osu.Game.Rulesets.Judgements;
using osu.Game.Rulesets.Mods;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Mods;
using osu.Game.Rulesets.Osu.Replays;
using osu.Game.Rulesets.Scoring;
using osu.Game.Scoring;
using osu.Game.Screens;
using osu.Game.Screens.Play;
using osu.Game.Tests.Visual;
using osuTK;

namespace FixtureGen;

// the judgement-dump scenario family: lazer itself judges hand-built
// synthetic replays over the committed minimal maps in
// fixtures/judgement/maps/, and the per-object judgement timeline it
// produces (result kind per object and nested element, running combo,
// spinner rotation) is dumped as the oracle for mechanisms count-level
// parity cannot see (spinner accumulation, slider tracking through
// leave-and-return, note-lock predecessor lifetime).
//
// machinery: lazer has no pure judge-this-replay api -- judgement happens in
// gameplay -- so each scenario boots a headless game host and plays the
// replay through a real ReplayPlayer, the same machinery lazer's own
// LegacyReplayPlaybackTestScene uses for exactly this concern. determinism
// is arranged rather than hoped for:
//
//  - the beatmap track is a ClockBackedTestWorkingBeatmap virtual track fed
//    by a ManualClock this file steps a fixed 4ms per update frame, so
//    gameplay time is a pure function of the update count, not wall time;
//  - the framework runs in single-thread execution mode, so the audio
//    thread samples that clock at a fixed point in each loop iteration;
//  - FrameStabilityContainer lands one update exactly on every replay frame
//    time, so input-triggered judgements sample at frame times exactly;
//  - every scenario runs twice in fresh hosts and the two serialized dumps
//    must be byte-identical, or generation fails loudly instead of writing
//    a fixture that would churn on the next regeneration.
//
// what the events deliberately do NOT carry: raw judgement times and the
// spinner's accumulated rotation. both are sampled at whatever gameplay
// instant the update loop reached (a timeout miss lands at the first update
// past its window; rotation accumulates to the last sample before end
// time), and the async component-load phase shifts that sampling grid
// between runs -- they are render-loop artifacts, not mechanisms the engine
// ports. the oracle values are the sampling-robust ones: result kind per
// element, hit/miss, application order, running combo, and spin/bonus tick
// counts, with every scenario designed so its outcomes sit far further from
// any boundary than one update step (~17ms of gameplay time) can move them.
//
// the replay carries the Classic mod (default settings), matching what
// LegacyScoreDecoder auto-appends to every stable replay -- the legacy
// rules path is the one the engine ports.
public static partial class JudgementDumps
{
    private const double clock_step_ms = 4;

    private sealed record Scenario(string Name, string BeatmapFile, string Description, Func<List<OsuReplayFrame>> BuildFrames);

    private static readonly Scenario[] scenarios =
    {
        new Scenario(
            "baseline",
            "scenario-baseline.osu",
            "fully predictable pass over two circles (great, ok), one skipped circle (miss), and one cleanly tracked slider -- harness regressions show here independent of any engine change",
            BuildBaselineFrames),
        new Scenario(
            "spinner-accumulation",
            "scenario-spinner-od5.osu",
            "spinner 1 spun fast past the bonus threshold (spins, bonus spins, per-tick judgements); spinner 2 spun slowly to a partial grade",
            BuildSpinnerFrames),
        new Scenario(
            "slider-tracking",
            "scenario-slider-tracking.osu",
            "slider 1: follow circle left after tick 1 and re-entered before the tail (tick 2 missed); slider 2: tracked through its tick then abandoned (tail dropped without a combo break)",
            BuildSliderTrackingFrames),
        new Scenario(
            "notelock-stack",
            "scenario-notelock-stack.osu",
            "note-lock predecessor lifetime: an older unjudged stacked circle sits off-cursor while a judged-but-fading 1ms spinner occupies the alive-list slot before the target; lazer allows the target hit",
            BuildNotelockFrames),
    };

    /// orchestrates the family: each scenario runs twice, and each run is a
    /// fresh fixture-gen subprocess (--judgement-scenario), because a game
    /// host booted second-or-later in one process has proven flaky (ruleset
    /// store/realm state bleeding across hosts). one host per process is the
    /// boot path lazer itself takes, and the byte-compare guard needs every
    /// run to be a clean boot
    public static void Run(string outDir, JsonSerializerOptions jsonOptions)
    {
        string dumpDir = Path.Combine(outDir, "judgement");
        Directory.CreateDirectory(dumpDir);

        foreach (var scenario in scenarios)
        {
            string first = RunScenarioInSubprocess(outDir, dumpDir, scenario.Name, 1);
            string second = RunScenarioInSubprocess(outDir, dumpDir, scenario.Name, 2);

            if (first != second)
            {
                string mismatchA = Path.Combine(dumpDir, $".mismatch-{scenario.Name}-run1.json");
                string mismatchB = Path.Combine(dumpDir, $".mismatch-{scenario.Name}-run2.json");
                File.WriteAllText(mismatchA, first);
                File.WriteAllText(mismatchB, second);
                Console.Error.WriteLine(
                    $"judgement dump {scenario.Name}: two runs produced different dumps; the harness is not " +
                    "deterministic on this machine and writing either result would churn the fixture on every " +
                    $"regeneration. refusing to write. both runs kept for diagnosis at {mismatchA} / {mismatchB}");
                Environment.Exit(1);
            }

            File.WriteAllText(Path.Combine(dumpDir, $"{scenario.Name}.json"), first);
            Console.WriteLine($"judgement dump {scenario.Name}: verified deterministic across two runs");
        }
    }

    private static string RunScenarioInSubprocess(string outDir, string dumpDir, string name, int run)
    {
        string resultFile = Path.Combine(dumpDir, $".run-{name}-{run}.json");
        File.Delete(resultFile);

        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = Environment.ProcessPath
                       ?? throw new InvalidOperationException("cannot resolve the running fixture-gen executable"),
            ArgumentList = { "--out", outDir, "--judgement-scenario", name, "--scenario-out", resultFile },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        using var process = System.Diagnostics.Process.Start(startInfo)
                            ?? throw new InvalidOperationException("failed to start the scenario subprocess");
        // drain both pipes concurrently with the wait, or a chatty child
        // fills one and deadlocks (same pattern as Program.cs's git call)
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        process.WaitForExit();
        stdout.GetAwaiter().GetResult();
        string errors = stderr.GetAwaiter().GetResult();

        if (process.ExitCode != 0 || !File.Exists(resultFile))
        {
            Console.Error.WriteLine($"judgement dump {name} (run {run}): scenario subprocess failed (exit {process.ExitCode})");
            Console.Error.WriteLine(errors);
            Environment.Exit(1);
        }

        string json = File.ReadAllText(resultFile);
        File.Delete(resultFile);
        return json;
    }

    /// entry point for the --judgement-scenario subprocess mode: one
    /// scenario, one fresh host, dump written to outFile
    public static void RunSingleScenario(string outDir, string name, string outFile, JsonSerializerOptions jsonOptions)
    {
        var scenario = scenarios.Single(s => s.Name == name);
        File.WriteAllText(outFile, RunScenario(outDir, scenario, jsonOptions));
    }

    private static string RunScenario(string outDir, Scenario scenario, JsonSerializerOptions jsonOptions)
    {
        var frames = scenario.BuildFrames();

        using var host = new HeadlessGameHost($"fixture-gen-judgement-{scenario.Name}", new HostOptions(), realtime: false);
        var game = new JudgementDumpGame(Path.Combine(outDir, "judgement", "maps", scenario.BeatmapFile), frames);
        host.Run(game);

        if (game.Failure != null)
        {
            Console.Error.WriteLine($"judgement dump {scenario.Name}: {game.Failure}");
            Environment.Exit(1);
        }

        var payload = new
        {
            Scenario = scenario.Name,
            Description = scenario.Description,
            BeatmapFile = scenario.BeatmapFile,
            Mods = new[] { "CL" },
            ClockStepMs = clock_step_ms,
            Frames = frames.Select(f => new
            {
                Time = f.Time,
                Pos = new[] { f.Position.X, f.Position.Y },
                Left = f.Actions.Contains(OsuAction.LeftButton),
                Right = f.Actions.Contains(OsuAction.RightButton),
            }).ToArray(),
            Events = game.Events,
        };
        return JsonSerializer.Serialize(payload, jsonOptions);
    }

    public sealed class DumpEvent
    {
        public int ObjectIndex { get; init; }
        public int? NestedIndex { get; init; }
        public string Kind { get; init; } = "";
        public double StartTime { get; init; }
        public string Result { get; init; } = "";
        public bool IsHit { get; init; }
        public int ComboAfter { get; init; }
    }

    private partial class JudgementDumpGame : OsuGameBase
    {
        private readonly string beatmapPath;
        private readonly List<OsuReplayFrame> frames;

        public readonly List<DumpEvent> Events = new List<DumpEvent>();
        public string? Failure;

        private ManualClock manualClock = null!;
        private FramedClock referenceClock = null!;
        private ReplayPlayer player = null!;
        private Dictionary<object, (int objectIndex, int? nestedIndex)> objectLocations = null!;
        private ScoreProcessor scoreProcessor = null!;
        private bool exiting;
        private long updateCount;

        public JudgementDumpGame(string beatmapPath, List<OsuReplayFrame> frames)
        {
            this.beatmapPath = beatmapPath;
            this.frames = frames;
        }

        [BackgroundDependencyLoader]
        private void load(FrameworkConfigManager frameworkConfig)
        {
            // single-thread execution: the virtual track samples the
            // reference clock from the audio component pass, and with all
            // threads sequenced on one thread that sample lands at a fixed
            // point in every loop iteration -- the dump becomes a pure
            // function of the update count
            frameworkConfig.SetValue(FrameworkSetting.ExecutionMode, ExecutionMode.SingleThread);
        }

        protected override void LoadComplete()
        {
            base.LoadComplete();

            var flat = new FlatWorkingBeatmap(beatmapPath);
            manualClock = new ManualClock { IsRunning = true, Rate = 1 };
            referenceClock = new FramedClock(manualClock);

            var working = new OsuTestScene.ClockBackedTestWorkingBeatmap(flat.Beatmap, null, referenceClock, Audio);
            Beatmap.Value = working;

            var ruleset = new OsuRuleset();
            Ruleset.Value = ruleset.RulesetInfo;

            var replay = new Replay { HasReceivedAllFrames = true };
            replay.Frames.AddRange(frames);

            var scoreInfo = new ScoreInfo
            {
                Ruleset = ruleset.RulesetInfo,
                User = new APIUser { Id = 1, Username = "fixture" },
                BeatmapInfo = working.BeatmapInfo,
            };
            // the classic mod (default settings) is what LegacyScoreDecoder
            // auto-appends to a stable replay; the legacy rules path is the
            // one the engine ports
            scoreInfo.Mods = new Mod[] { new OsuModClassic() };
            SelectedMods.Value = scoreInfo.Mods;

            var score = new Score { Replay = replay, ScoreInfo = scoreInfo };

            OsuScreenStack screenStack;
            Add(screenStack = new OsuScreenStack { RelativeSizeAxes = Axes.Both });

            player = new ReplayPlayer(score, new PlayerConfiguration
            {
                AllowPause = false,
                ShowResults = false,
            });
            player.OnLoadComplete += _ =>
            {
                // the mapping must come from the player's own playable
                // beatmap -- GetPlayableBeatmap converts fresh instances, so
                // any other conversion would fail reference lookups
                objectLocations = new Dictionary<object, (int, int?)>();
                var playable = player.GameplayState.Beatmap;
                for (int i = 0; i < playable.HitObjects.Count; i++)
                {
                    objectLocations[playable.HitObjects[i]] = (i, null);
                    for (int j = 0; j < playable.HitObjects[i].NestedHitObjects.Count; j++)
                        objectLocations[playable.HitObjects[i].NestedHitObjects[j]] = (i, j);
                }

                scoreProcessor = player.GameplayState.ScoreProcessor;
                scoreProcessor.NewJudgement += onNewJudgement;
                scoreProcessor.JudgementReverted += _ =>
                    Failure ??= "a judgement was reverted mid-dump; forward-only playback should never rewind";
            };
            screenStack.Push(player);
        }

        private void onNewJudgement(JudgementResult result)
        {
            if (!objectLocations.TryGetValue(result.HitObject, out var location))
            {
                Failure ??= $"judgement for a hit object outside the playable beatmap: {result.HitObject.GetType().Name}";
                return;
            }

            Events.Add(new DumpEvent
            {
                ObjectIndex = location.objectIndex,
                NestedIndex = location.nestedIndex,
                Kind = result.HitObject.GetType().Name,
                StartTime = result.HitObject.StartTime,
                Result = result.Type.ToString(),
                IsHit = result.IsHit,
                ComboAfter = scoreProcessor.Combo.Value,
            });
        }

        protected override void Update()
        {
            base.Update();

            manualClock.CurrentTime += clock_step_ms;
            referenceClock.ProcessFrame();
            updateCount++;

            if (exiting)
                return;

            if (updateCount > 1_000_000)
            {
                Failure ??= "gameplay did not complete within 1,000,000 update frames";
                exiting = true;
                Host.Exit();
                return;
            }

            if (player?.GameplayState?.HasCompleted == true)
            {
                exiting = true;
                Host.Exit();
            }
        }
    }

    private static OsuReplayFrame Frame(double time, float x, float y, bool left = false, bool right = false)
    {
        var actions = new List<OsuAction>();
        if (left)
            actions.Add(OsuAction.LeftButton);
        if (right)
            actions.Add(OsuAction.RightButton);
        return new OsuReplayFrame(time, new Vector2(x, y), actions.ToArray());
    }

    // circles at (100,100) t=1000 (hit exact -> great), (200,100) t=2000
    // (hit +70ms -> ok at od5), (300,100) t=3000 (skipped -> miss); slider
    // (100,200)->(300,200) t=4000..5000, tick at 4500, tracked end to end
    private static List<OsuReplayFrame> BuildBaselineFrames()
    {
        var frames = new List<OsuReplayFrame>
        {
            Frame(0, 100, 100),
            Frame(500, 100, 100),
            Frame(984, 100, 100),
            Frame(1000, 100, 100, left: true),
            Frame(1020, 100, 100),
            Frame(1500, 200, 100),
            Frame(2054, 200, 100),
            Frame(2070, 200, 100, right: true),
            Frame(2090, 200, 100),
            Frame(2500, 250, 150),
            Frame(3500, 100, 200),
            Frame(3984, 100, 200),
        };
        // press on the head, then track the ball (linear 200px over 1000ms)
        for (double t = 4000; t <= 5000; t += 20)
        {
            float x = (float)(100 + 200 * (t - 4000) / 1000);
            frames.Add(Frame(t, x, 200, left: true));
        }
        frames.Add(Frame(5020, 300, 200));
        frames.Add(Frame(5500, 300, 200));
        return frames;
    }

    // spinner 1 [1000,4000]: 30 degrees per 16ms frame (~5.2 rev/s) held
    // left -- far past required + bonus threshold. spinner 2 [6000,8000]:
    // 11.25 degrees per 16ms (~1.95 rev/s), ~3.9 revolutions -- a partial
    // grade. cursor circles (256,192) at radius 100
    private static List<OsuReplayFrame> BuildSpinnerFrames()
    {
        var frames = new List<OsuReplayFrame>
        {
            Frame(0, 256, 92),
            Frame(900, 256, 92),
        };

        void spin(double start, double end, double degreesPerFrame)
        {
            int i = 0;
            for (double t = start; t <= end; t += 16, i++)
            {
                double theta = (i * degreesPerFrame) * Math.PI / 180;
                frames.Add(Frame(t, (float)(256 + 100 * Math.Cos(theta)), (float)(192 + 100 * Math.Sin(theta)), left: true));
            }
        }

        spin(1000, 4016, 30);
        frames.Add(Frame(4048, 256, 92));
        frames.Add(Frame(5900, 256, 92));
        spin(6000, 8016, 11.25);
        frames.Add(Frame(8048, 256, 92));
        frames.Add(Frame(9000, 256, 92));
        return frames;
    }

    // slider 1 (50,50)->(350,50), t=2000..3500, ticks at 2500/3000: tracked
    // to 2600, cursor parked 200px ahead of the path until 3040 (tick 2
    // missed), re-entered at 3050 and tracked through the tail. slider 2
    // (50,250)->(250,250), t=5000..6000, tick at 5500: tracked through the
    // tick, abandoned at 5620 with the key still held -- the tail drops on
    // position alone, without a combo break
    private static List<OsuReplayFrame> BuildSliderTrackingFrames()
    {
        var frames = new List<OsuReplayFrame>
        {
            Frame(0, 50, 50),
            Frame(1900, 50, 50),
        };

        float ball1(double t) => (float)(50 + 300 * (t - 2000) / 1500);
        for (double t = 2000; t <= 2600; t += 20)
            frames.Add(Frame(t, ball1(t), 50, left: true));
        frames.Add(Frame(2610, 370, 50, left: true));
        frames.Add(Frame(3040, 370, 50, left: true));
        for (double t = 3050; t <= 3500; t += 20)
            frames.Add(Frame(t, ball1(t), 50, left: true));
        frames.Add(Frame(3520, ball1(3500), 50, left: true));
        frames.Add(Frame(3550, ball1(3500), 50));

        frames.Add(Frame(4900, 50, 250));
        float ball2(double t) => (float)(50 + 200 * (t - 5000) / 1000);
        for (double t = 5000; t <= 5600; t += 20)
            frames.Add(Frame(t, ball2(t), 250, right: true));
        frames.Add(Frame(5620, 450, 250, right: true));
        frames.Add(Frame(5900, 450, 250));
        frames.Add(Frame(6500, 450, 250));
        return frames;
    }

    // the T5 shielding case. objects: circle X (100,100) t=2000 skipped and
    // stacked with W (100,100) t=2200 (so X carries StackHeight > 0), a 1ms
    // spinner [2001,2002] that auto-completes great and keeps fading, and
    // target circle C (300,200) t=2003 pressed exactly on time. in lazer's
    // alive list the judged-but-fading spinner is C's immediate predecessor,
    // so the StackHeight gate never consults X and the 3ms walk leniency
    // (X.end + 3 < C.start is false) lets the hit through; an alive model
    // that equates alive with unjudged finds X as the predecessor instead
    // and swallows the press.
    //
    // the frame at exactly 2002 is load-bearing: frame stability forces an
    // update on it, so the spinner's completion is processed there --
    // strictly before the 2003 press -- instead of racing the press inside
    // whichever update first crosses 2002
    private static List<OsuReplayFrame> BuildNotelockFrames()
    {
        return new List<OsuReplayFrame>
        {
            Frame(0, 300, 200),
            Frame(1000, 300, 200),
            Frame(2002, 300, 200),
            Frame(2003, 300, 200, left: true),
            Frame(2023, 300, 200),
            Frame(2600, 300, 200),
            Frame(3000, 300, 200),
        };
    }
}
