using System.Text.Json;
using System.Text.RegularExpressions;
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
// leave-and-return, note-lock predecessor lifetime), plus the end-state
// values lazer's own score processor derives from that timeline (the
// statistics map, the maximum statistics, max combo, total score, accuracy
// and rank), which the native folds are pinned against.
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
// the end-state values are pure functions of the events, so they inherit
// that determinism; the health curve stays out, since it samples the drain
// at update instants.
//
// each scenario carries its own mod list. the four original scenarios keep
// the Classic mod (default settings), matching what LegacyScoreDecoder
// auto-appends to every stable replay -- the legacy rules path the stable
// profile ports. the native scenarios run with no mods: lazer's own default
// gameplay, which the native profile ports. a scenario dumped both ways
// pins the two profiles apart.
public static partial class JudgementDumps
{
    private const double clock_step_ms = 4;

    private sealed record Scenario(string Name, string BeatmapFile, string Description, Func<List<OsuReplayFrame>> BuildFrames, Func<Mod[]> Mods);

    private static Mod[] Classic() => new Mod[] { new OsuModClassic() };
    private static Mod[] NoMods() => Array.Empty<Mod>();

    private static readonly Scenario[] scenarios =
    {
        new Scenario(
            "baseline",
            "scenario-baseline.osu",
            "fully predictable pass over two circles (great, ok), one skipped circle (miss), and one cleanly tracked slider -- harness regressions show here independent of any engine change",
            BuildBaselineFrames,
            Classic),
        new Scenario(
            "spinner-accumulation",
            "scenario-spinner-od5.osu",
            "spinner 1 spun fast past the bonus threshold (spins, bonus spins, per-tick judgements); spinner 2 spun slowly to a partial grade",
            BuildSpinnerFrames,
            Classic),
        new Scenario(
            "slider-tracking",
            "scenario-slider-tracking.osu",
            "slider 1: follow circle left after tick 1 and re-entered before the tail (tick 2 missed); slider 2: tracked through its tick then abandoned (tail dropped without a combo break)",
            BuildSliderTrackingFrames,
            Classic),
        new Scenario(
            "notelock-stack",
            "scenario-notelock-stack.osu",
            "note-lock predecessor lifetime: an older unjudged stacked circle sits off-cursor while a judged-but-fading 1ms spinner occupies the alive-list slot before the target; lazer allows the target hit",
            BuildNotelockFrames,
            Classic),

        // ------------------------------------------------------------ native
        new Scenario(
            "native-baseline",
            "scenario-native-baseline.osu",
            "NATIVE (no mods). fully predictable: circles hit at +0 (great), +70 (ok), +120 (meh) and one skipped (miss), a slider tracked end to end (great head, three large tick hits, a slider tail hit, the slider's own ignore hit), and a spinner spun fast (great with small and large bonus ticks). pins the native result vocabulary and the score processor's end state: every basic result, the tick and tail kinds, combo through the tail, and the standardised total",
            BuildNativeBaselineFrames,
            NoMods),
        new Scenario(
            "pinned-apart-classic",
            "scenario-baseline.osu",
            "CLASSIC half of the pinned-apart pair: the baseline map with the slider's head pressed 70ms late and tracked through. under classic the head judges as a tick (LargeTickHit, no timing grade) and the tail as the legacy tail judgement; the native half dumps the same frames with no mods, where the head is a timed Ok and the tail a SliderTailHit that increments combo",
            BuildPinnedApartFrames,
            Classic),
        new Scenario(
            "pinned-apart-native",
            "scenario-baseline.osu",
            "NATIVE half of the pinned-apart pair (no mods): the same frames as pinned-apart-classic. the head's grade (Ok, not a tick), the tail's result (SliderTailHit, combo +1) and the combo rule through the tail differ from the classic dump, so the two profiles are pinned apart by one scenario",
            BuildPinnedApartFrames,
            NoMods),
        new Scenario(
            "notelock-stack-native",
            "scenario-notelock-stack.osu",
            "NATIVE (no mods) dump of the notelock-stack scenario: the same frames judged under lazer's default StartTimeOrderedHitPolicy (StartTimeOrderedHitPolicy.cs) rather than classic's LegacyHitPolicy. the shielded press at 2003 on the target: the older unjudged stacked circle (start 2000) blocks hits before ITS start time only, and 2003 is past it, so the hit lands and the older circle is force-missed by HandleHit -- the ratified stable divergence reads visibly different from this",
            BuildNotelockFrames,
            NoMods),
        new Scenario(
            "native-ordered-lock",
            "scenario-native-ordered-lock.osu",
            "NATIVE (no mods). StartTimeOrderedHitPolicy.CheckHittable: a press on B1 at 950 while A1 (start 1000) is unjudged is refused (time < the blocking object's start time -- 50ms clear of that boundary), then A1 and B1 are hit on time. HandleHit: a press on B2 at 3080, 80ms past A2's start (3000) with A2 unjudged, is allowed and force-misses A2; B2 lands 20ms early (30ms clear of the great window's edge)",
            BuildOrderedLockFrames,
            NoMods),
        new Scenario(
            "native-simultaneous",
            "scenario-native-simultaneous.osu",
            "NATIVE (no mods). two circles at one start time (2000): neither blocks the other (StartTimeOrderedHitPolicy.enumerateHitObjectsUpTo takes only objects starting strictly before the target), so the later-listed one pressed first at 2000 and the earlier-listed one pressed at 2030 (20ms clear of the great window's edge) both judge great, in press order rather than map order",
            BuildSimultaneousFrames,
            NoMods),
        new Scenario(
            "native-duplicate-frames",
            "scenario-native-simultaneous.osu",
            "NATIVE (no mods). two replay frames at one timestamp (2000) over the simultaneous map, with different positions and actions: the first over circle A with left, the second over circle B with right, then B's frame held to 2040. lazer's replay input handler (FramedReplayInputHandler.SetFrameFromTime stepping one frame per call) applies every frame at a duplicated time in order, so both presses land and both circles judge great, exactly on time -- the cadence the native walk must reproduce",
            BuildDuplicateFramesFrames,
            NoMods),
        new Scenario(
            "native-sparse-frames",
            "scenario-native-sparse.osu",
            "NATIVE (no mods). a 1500ms linear slider tracked with frames 750ms apart (longer than any hit window): lazer interpolates the cursor linearly between the bounding frames (OsuFramedReplayInputHandler.Position, Interpolation.ValueAt), which follows the constant-velocity ball exactly, so every tick and the tail track. then a circle pressed 80ms late on a frame of its own (ok, 20ms clear of both window edges)",
            BuildSparseFramesFrames,
            NoMods),
        new Scenario(
            "native-incomplete",
            "scenario-native-incomplete.osu",
            "NATIVE (no mods). four circles, the first three hit on time; the frames end at 3500, before the last. a replay can fail only once its frames are exhausted (ReplayPlayer.CheckModsAllowFailure) and one miss from a full bar cannot, so the last circle misses by timeout after the frames end and the play completes with every object judged: the basic results still sum to the maximum statistics' count, and the rank carries the miss",
            BuildIncompleteFrames,
            NoMods),
        new Scenario(
            "native-graded-heads",
            "scenario-native-graded-heads.osu",
            "NATIVE (no mods). three identical 1000ms sliders with three ticks each, heads pressed at +0, +70 and +120 (great, ok, meh -- each 20-30ms clear of its window's edges) and every element tracked: a 100 or 50 on a slider head with nothing dropped (DrawableSliderHead judges with the circle's own windows), ticks large tick hits, tails slider tail hits, combo running through all fifteen elements",
            BuildGradedHeadsFrames,
            NoMods),
        new Scenario(
            "native-late-head-recovery",
            "scenario-native-late-head.osu",
            "NATIVE (no mods). a 1500ms slider ticking every 125ms whose head is pressed at +130 (meh, 20ms clear of the miss edge), after the first tick's time (+125) has passed: a nested element is never judged before the head is (SliderInputManager.TryJudgeNestedObject), so that tick judges at the press with the cursor inside the follow area and the key down -- a hit -- and tracking from the press carries every later element. the ball is 26px past the head at the press, inside the expanded follow area",
            BuildLateHeadFrames,
            NoMods),
        new Scenario(
            "slider-tracking-native",
            "scenario-slider-tracking.osu",
            "NATIVE (no mods) dump of the slider-tracking scenario: tracking loss and recovery mid-body (tick 2 dropped, the tail recovered) on slider 1, and an abandoned body (the tail dropped) on slider 2, under lazer's own rules -- the tail is a SliderTailHit or an ignore miss, never a tick",
            BuildSliderTrackingFrames,
            NoMods),
        new Scenario(
            "native-tail-ordering",
            "scenario-native-tail-ordering.osu",
            "NATIVE (no mods). two 1000ms sliders ticking every ~244ms so the last tick (~+976) sits inside the tail's 36ms leniency (the tail may judge from +964). SliderInputManager.TryJudgeNestedObject: the tail waits for the last tick to judge, then hits at once if tracking and otherwise only misses at the end time. slider 1 releases at +970, between the leniency point and the last tick: the tick misses and so does the tail (a tail hit at its leniency point would be wrong). slider 2 releases at +990, after the last tick: the tick hits and the tail hits at the tick's judgement, before the release (a tail judged at the end time would be wrong)",
            BuildTailOrderingFrames,
            NoMods),
        new Scenario(
            "native-overlapping-sliders",
            "scenario-native-overlapping.osu",
            "NATIVE (no mods). two parallel sliders 40px apart overlapping by 500ms, their balls vertically aligned throughout the overlap: the first's head pressed with left and held, the second's head pressed with right while left is still down, the cursor then kept between the two balls inside both follow areas. SliderInputManager's accepted-key rule: the first slider accepts any key (no other key was down at its head), the second accepts only right until left is released. right is released at +220 into the second slider with left still held: the first keeps tracking through its tail, the second loses its tick and tail to the key it was hit with",
            BuildOverlappingFrames,
            NoMods),
        new Scenario(
            "native-spinner-thresholds",
            "scenario-native-spinners.osu",
            "NATIVE (no mods). four 2000ms spinners at OD5 (Spinner.SpinsRequired = 5) spun to 1.05, 0.95, 0.8 and 0.5 of the requirement (5.25, 4.75, 4.0 and 2.5 revolutions at 30 degrees per 16ms frame, then parked): great (Progress >= 1), ok (> 0.9), meh (> 0.75) and a miss at the end time (DrawableSpinner.CheckForResult), each 0.25 revolutions clear of its threshold. the move to the park point is interpolated while the last spin frame's button still holds, so the tracker sweeps up to another half turn on the way (a quarter turn on spinners 3 and 4) -- inside every margin, and part of what the walk must reproduce. the spin and bonus tick counts follow lazer's own nesting: one tick per completed revolution, small bonus for the first SpinsRequiredForBonus and large bonus beyond",
            BuildSpinnerThresholdFrames,
            NoMods),
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
        var mods = scenario.Mods();

        using var host = new HeadlessGameHost($"fixture-gen-judgement-{scenario.Name}", new HostOptions(), realtime: false);
        var game = new JudgementDumpGame(Path.Combine(outDir, "judgement", "maps", scenario.BeatmapFile), frames, mods);
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
            Mods = mods.Select(m => m.Acronym).ToArray(),
            ClockStepMs = clock_step_ms,
            Frames = frames.Select(f => new
            {
                Time = f.Time,
                Pos = new[] { f.Position.X, f.Position.Y },
                Left = f.Actions.Contains(OsuAction.LeftButton),
                Right = f.Actions.Contains(OsuAction.RightButton),
            }).ToArray(),
            Events = game.Events,
            EndState = game.EndState,
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

    /// what lazer's score processor derived from the timeline once the play
    /// completed. the maps are keyed by HitResult's snake-case names -- the
    /// same spelling a score-info block uses -- and ordered by lazer's own
    /// display order (HitResultExtensions.GetIndexForOrderedDisplay) so the
    /// dump is a function of the counts alone
    public sealed class DumpEndState
    {
        public Dictionary<string, int> Statistics { get; init; } = new Dictionary<string, int>();
        public Dictionary<string, int> MaximumStatistics { get; init; } = new Dictionary<string, int>();
        public int MaxCombo { get; init; }
        public long TotalScore { get; init; }
        public double Accuracy { get; init; }
        public string Rank { get; init; } = "";
    }

    /// "LargeTickHit" -> "large_tick_hit", the spelling lazer's ToSnakeCase
    /// produces for a dictionary key and each HitResult's EnumMember value
    private static string SnakeCase(HitResult result) =>
        Regex.Replace(result.ToString(), "(?<!^)([A-Z])", "_$1").ToLowerInvariant();

    private static Dictionary<string, int> OrderedCounts(IReadOnlyDictionary<HitResult, int> counts)
    {
        var ordered = new Dictionary<string, int>();
        foreach (var (result, count) in counts.OrderBy(kvp => kvp.Key.GetIndexForOrderedDisplay()))
        {
            if (count != 0)
                ordered[SnakeCase(result)] = count;
        }
        return ordered;
    }

    private partial class JudgementDumpGame : OsuGameBase
    {
        private readonly string beatmapPath;
        private readonly List<OsuReplayFrame> frames;
        private readonly Mod[] mods;

        public readonly List<DumpEvent> Events = new List<DumpEvent>();
        public DumpEndState? EndState;
        public string? Failure;

        private ManualClock manualClock = null!;
        private FramedClock referenceClock = null!;
        private ReplayPlayer player = null!;
        private Dictionary<object, (int objectIndex, int? nestedIndex)> objectLocations = null!;
        private ScoreProcessor scoreProcessor = null!;
        private bool exiting;
        private long updateCount;

        public JudgementDumpGame(string beatmapPath, List<OsuReplayFrame> frames, Mod[] mods)
        {
            this.beatmapPath = beatmapPath;
            this.frames = frames;
            this.mods = mods;
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
            // the scenario's own mod list: Classic (default settings) for the
            // legacy rules path the stable profile ports, nothing at all for
            // lazer's own default gameplay the native profile ports
            scoreInfo.Mods = mods;
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
                // read once the play is complete: every judgement has been
                // applied, so these are the same numbers lazer's results
                // screen would show
                EndState = new DumpEndState
                {
                    Statistics = OrderedCounts(scoreProcessor.Statistics),
                    MaximumStatistics = OrderedCounts(scoreProcessor.MaximumStatistics),
                    MaxCombo = scoreProcessor.HighestCombo.Value,
                    TotalScore = scoreProcessor.TotalScore.Value,
                    Accuracy = scoreProcessor.Accuracy.Value,
                    Rank = scoreProcessor.Rank.Value.ToString(),
                };
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

    /// frames following a linear slider's ball from `startX` to `endX` at
    /// `y` between `start` and `end`, `step` apart, with the given key held
    private static void Track(List<OsuReplayFrame> frames, double start, double end, float startX, float endX, float y, double step, bool left = true, bool right = false)
    {
        for (double t = start; t <= end; t += step)
        {
            float x = (float)(startX + (endX - startX) * (t - start) / (end - start));
            frames.Add(Frame(t, x, y, left, right));
        }
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

    // ---------------------------------------------------------------- native

    // circles (100,100) 1000 +0 great, (200,100) 2000 +70 ok, (300,100) 3000
    // +120 meh (od5 windows 50/100/150: 20-30ms clear of every edge), (400,100)
    // 4000 skipped; slider (100,200)->(300,200) 5000..6000 (sm1, beat 500:
    // 200px = 1000ms), tick rate 2 -> ticks at 5250/5500/5750, tracked end to
    // end; spinner [7000,9000] spun at 30 degrees per 16ms frame
    private static List<OsuReplayFrame> BuildNativeBaselineFrames()
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
            Frame(2500, 300, 100),
            Frame(3104, 300, 100),
            Frame(3120, 300, 100, left: true),
            Frame(3140, 300, 100),
            Frame(3500, 250, 150),
            Frame(4500, 100, 200),
            Frame(4984, 100, 200),
        };
        Track(frames, 5000, 6000, 100, 300, 200, 20);
        frames.Add(Frame(6020, 300, 200));
        frames.Add(Frame(6500, 256, 92));
        frames.Add(Frame(6984, 256, 92));
        int i = 0;
        for (double t = 7000; t <= 9016; t += 16, i++)
        {
            double theta = (i * 30) * Math.PI / 180;
            frames.Add(Frame(t, (float)(256 + 100 * Math.Cos(theta)), (float)(192 + 100 * Math.Sin(theta)), left: true));
        }
        frames.Add(Frame(9048, 256, 92));
        frames.Add(Frame(9500, 256, 92));
        return frames;
    }

    // the baseline map (circles great, ok, miss) with the slider's head
    // pressed at 4070 (+70: an ok head under native, a large tick under
    // classic; 20ms clear of the great edge and 30ms clear of the meh edge)
    // and the ball tracked from the press to the end. the cursor waits on the
    // head until the press, 14px behind the ball by then -- inside the radius
    private static List<OsuReplayFrame> BuildPinnedApartFrames()
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
            Frame(4054, 100, 200),
        };
        for (double t = 4070; t <= 5000; t += 20)
        {
            float x = (float)(100 + 200 * (t - 4000) / 1000);
            frames.Add(Frame(t, x, 200, left: true));
        }
        frames.Add(Frame(5020, 300, 200));
        frames.Add(Frame(5500, 300, 200));
        return frames;
    }

    // A1 (100,100) 1000, B1 (300,100) 1100, A2 (100,300) 3000, B2 (300,300)
    // 3100. a press on B1 at 950 (A1 unjudged, 50ms before A1's start) is
    // refused; A1 at 1000 and B1 at 1100 land on time. a press on B2 at 3080
    // (80ms past A2's start, A2 unjudged) is allowed, 20ms early on B2, and
    // force-misses A2
    private static List<OsuReplayFrame> BuildOrderedLockFrames()
    {
        return new List<OsuReplayFrame>
        {
            Frame(0, 300, 100),
            Frame(500, 300, 100),
            Frame(934, 300, 100),
            Frame(950, 300, 100, left: true),
            Frame(966, 300, 100),
            Frame(984, 100, 100),
            Frame(1000, 100, 100, left: true),
            Frame(1020, 100, 100),
            Frame(1084, 300, 100),
            Frame(1100, 300, 100, right: true),
            Frame(1120, 300, 100),
            Frame(2000, 300, 300),
            Frame(3064, 300, 300),
            Frame(3080, 300, 300, left: true),
            Frame(3100, 300, 300),
            Frame(3600, 300, 300),
            Frame(4000, 300, 300),
        };
    }

    // two circles at 2000: (100,100) listed first, (300,100) second. the
    // second is pressed first, exactly on time, the first 30ms late
    private static List<OsuReplayFrame> BuildSimultaneousFrames()
    {
        return new List<OsuReplayFrame>
        {
            Frame(0, 300, 100),
            Frame(1000, 300, 100),
            Frame(1984, 300, 100),
            Frame(2000, 300, 100, left: true),
            Frame(2010, 300, 100),
            Frame(2014, 100, 100),
            Frame(2030, 100, 100, right: true),
            Frame(2050, 100, 100),
            Frame(2600, 100, 100),
            Frame(3000, 100, 100),
        };
    }

    // over the simultaneous map (two circles at 2000): two frames at 1984
    // put the cursor at two places with two different actions in one
    // millisecond, a thousand milliseconds before anything can be hit, so
    // whichever the handler applies is a press that lands nothing; then the
    // real test: two frames at 2000, the first over circle A (100,100) with
    // left, the second over circle B (300,100) with right, then B's frame
    // held to 2040. which circle judges, and when, is what the dump pins
    private static List<OsuReplayFrame> BuildDuplicateFramesFrames()
    {
        return new List<OsuReplayFrame>
        {
            Frame(0, 200, 100),
            Frame(1000, 200, 100),
            Frame(1984, 200, 100),
            Frame(2000, 100, 100, left: true),
            Frame(2000, 300, 100, right: true),
            Frame(2020, 300, 100, right: true),
            Frame(2040, 300, 100),
            Frame(2600, 300, 100),
            Frame(3000, 300, 100),
        };
    }

    // slider (100,200)->(400,200) 2000..3500 (300px, sm1, beat 500), tick
    // rate 1 -> ticks at 2500/3000: frames at 2000 (head press), 2750 and
    // 3500 only, the cursor interpolated between them. then circle (250,100)
    // at 5000 pressed at 5080 (+80: ok, 20ms clear of both edges)
    private static List<OsuReplayFrame> BuildSparseFramesFrames()
    {
        return new List<OsuReplayFrame>
        {
            Frame(0, 100, 200),
            Frame(1900, 100, 200),
            Frame(2000, 100, 200, left: true),
            Frame(2750, 250, 200, left: true),
            Frame(3500, 400, 200, left: true),
            Frame(3520, 400, 200),
            Frame(4700, 250, 100),
            Frame(5080, 250, 100, left: true),
            Frame(5100, 250, 100),
            Frame(5600, 250, 100),
            Frame(6000, 250, 100),
        };
    }

    // four circles (100,100) 1000, (200,100) 2000, (300,100) 3000, (400,100)
    // 4000: the first three hit on time, then the frames end at 3500 with the
    // last circle unreached
    private static List<OsuReplayFrame> BuildIncompleteFrames()
    {
        return new List<OsuReplayFrame>
        {
            Frame(0, 100, 100),
            Frame(500, 100, 100),
            Frame(984, 100, 100),
            Frame(1000, 100, 100, left: true),
            Frame(1020, 100, 100),
            Frame(1984, 200, 100),
            Frame(2000, 200, 100, right: true),
            Frame(2020, 200, 100),
            Frame(2984, 300, 100),
            Frame(3000, 300, 100, left: true),
            Frame(3020, 300, 100),
            Frame(3500, 300, 100),
        };
    }

    // three sliders (100,y)->(300,y) at y=100/200/300, 1000ms each starting
    // at 1000/3000/5000, tick rate 2 -> ticks at +250/+500/+750. heads at
    // +0, +70, +120; the ball tracked from the press to the end
    private static List<OsuReplayFrame> BuildGradedHeadsFrames()
    {
        var frames = new List<OsuReplayFrame> { Frame(0, 100, 100), Frame(500, 100, 100) };
        void slider(double start, float y, double offset)
        {
            frames.Add(Frame(start - 16, 100, y));
            for (double t = start + offset; t <= start + 1000; t += 20)
            {
                float x = (float)(100 + 200 * (t - start) / 1000);
                frames.Add(Frame(t, x, y, left: true));
            }
            frames.Add(Frame(start + 1020, 300, y));
        }
        slider(1000, 100, 0);
        frames.Add(Frame(2500, 100, 200));
        slider(3000, 200, 70);
        frames.Add(Frame(4500, 100, 300));
        slider(5000, 300, 120);
        frames.Add(Frame(6500, 300, 300));
        frames.Add(Frame(7000, 300, 300));
        return frames;
    }

    // slider (100,100)->(400,100) 2000..3500 (300px), tick rate 4 -> ticks
    // every 125ms from 2125. the cursor waits on the head and presses at 2130
    // (+130: meh, 20ms clear of the miss edge), after the first tick's time;
    // then tracks the ball (26px ahead at the press, inside the follow area)
    private static List<OsuReplayFrame> BuildLateHeadFrames()
    {
        var frames = new List<OsuReplayFrame>
        {
            Frame(0, 100, 100),
            Frame(1900, 100, 100),
            Frame(2114, 100, 100),
            Frame(2130, 100, 100, left: true),
        };
        for (double t = 2150; t <= 3500; t += 20)
        {
            float x = (float)(100 + 300 * (t - 2000) / 1500);
            frames.Add(Frame(t, x, 100, left: true));
        }
        frames.Add(Frame(3520, 400, 100));
        frames.Add(Frame(4000, 400, 100));
        return frames;
    }

    // slider 1 (100,100)->(300,100) 2000..3000 and slider 2 (100,200)->
    // (300,200) 5000..6000, tick rate 2.05 -> ticks every ~243.9ms, the last
    // at ~+976, past the tail's leniency point at +964. slider 1: tracked to
    // +960, released at +970 (before the last tick: tick and tail both miss).
    // slider 2: tracked to +980, released at +990 (after the last tick: tick
    // hit, and the tail hit at the tick's judgement, before the release)
    private static List<OsuReplayFrame> BuildTailOrderingFrames()
    {
        var frames = new List<OsuReplayFrame> { Frame(0, 100, 100), Frame(1900, 100, 100) };
        Track(frames, 2000, 2960, 100, 292, 100, 20);
        frames.Add(Frame(2970, 294, 100));
        frames.Add(Frame(3100, 300, 100));
        frames.Add(Frame(4900, 100, 200));
        Track(frames, 5000, 5980, 100, 296, 200, 20);
        frames.Add(Frame(5990, 298, 200));
        frames.Add(Frame(6100, 300, 200));
        frames.Add(Frame(6500, 300, 200));
        return frames;
    }

    // slider 1 (100,100)->(300,100) 2000..3000 and slider 2 (200,140)->
    // (400,140) 2500..3500, one tick each at +500; during the overlap both
    // balls share an x and sit 40px apart. left pressed on slider 1's head
    // and held throughout; right pressed on slider 2's head at 2500 (40px
    // from slider 1's ball, inside its expanded follow area) and released at
    // 2720; the cursor rides 20px from each ball (y=120) until slider 1 ends,
    // then slider 2's ball alone
    private static List<OsuReplayFrame> BuildOverlappingFrames()
    {
        var frames = new List<OsuReplayFrame> { Frame(0, 100, 100), Frame(1900, 100, 100) };
        float ballX(double t) => (float)(100 + 200 * (t - 2000) / 1000);
        for (double t = 2000; t < 2500; t += 20)
            frames.Add(Frame(t, ballX(t), 100, left: true));
        frames.Add(Frame(2500, 200, 140, left: true, right: true));
        for (double t = 2520; t <= 2700; t += 20)
            frames.Add(Frame(t, ballX(t), 120, left: true, right: true));
        for (double t = 2720; t <= 3000; t += 20)
            frames.Add(Frame(t, ballX(t), 120, left: true));
        for (double t = 3020; t <= 3500; t += 20)
            frames.Add(Frame(t, ballX(t), 140, left: true));
        frames.Add(Frame(3520, 400, 140));
        frames.Add(Frame(4000, 400, 140));
        return frames;
    }

    // four spinners [1000,3000] [5000,7000] [9000,11000] [13000,15000] at
    // od5: five spins required over 2000ms. spun at 30 degrees per 16ms
    // frame for exactly 63, 57, 48 and 30 frames -> 5.25, 4.75, 4.0 and 2.5
    // revolutions (1.05, 0.95, 0.8 and 0.5 of the requirement), then parked
    private static List<OsuReplayFrame> BuildSpinnerThresholdFrames()
    {
        var frames = new List<OsuReplayFrame> { Frame(0, 256, 92), Frame(900, 256, 92) };
        void spin(double start, int steps)
        {
            for (int i = 0; i <= steps; i++)
            {
                double t = start + i * 16;
                double theta = (i * 30) * Math.PI / 180;
                frames.Add(Frame(t, (float)(256 + 100 * Math.Cos(theta)), (float)(192 + 100 * Math.Sin(theta)), left: true));
            }
            frames.Add(Frame(start + steps * 16 + 32, 256, 92));
        }
        spin(1000, 63);
        frames.Add(Frame(4900, 256, 92));
        spin(5000, 57);
        frames.Add(Frame(8900, 256, 92));
        spin(9000, 48);
        frames.Add(Frame(12900, 256, 92));
        spin(13000, 30);
        frames.Add(Frame(15500, 256, 92));
        frames.Add(Frame(16000, 256, 92));
        return frames;
    }
}
