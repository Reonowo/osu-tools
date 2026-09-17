using osu.Framework;
using System.Text.Json;
using osu.Framework.Platform;
using osu.Game.Beatmaps;
using osu.Game.Rulesets;
using osu.Game.Rulesets.Osu;
using osu.Game.Rulesets.Osu.Replays;
using osu.Game.Scoring;
using osu.Game.Scoring.Legacy;

namespace FixtureGen;

// the replay re-run instrument: play a REAL (.osr, .osu) pair through the
// pinned lazer client and dump the judgement timeline it produces.
//
// why this exists. the native corpus compares the engine against the
// score-info block each replay file carries, which is written by whatever
// lazer build the player happened to be running -- so a divergence there has
// two possible causes and the comparison cannot separate them: this engine
// is wrong, or lazer's own gameplay changed between that build and the pin
// this crate ports. introducing a third party settles it. if the pinned
// client agrees with the engine and both differ from the file, the file is
// older behaviour (drift, to be ratified with the cause named); if the
// pinned client agrees with the file and the engine differs, it is an engine
// bug, and lazer's own per-element timeline names the first object it
// happens on.
//
// machinery: this reuses the judgement family's host wholesale
// (JudgementDumpGame), so every determinism arrangement documented there --
// single-thread execution, a ManualClock stepped a fixed 4ms per update,
// FrameStabilityContainer landing one update exactly on every replay frame
// time -- applies unchanged. the only difference is where the frames come
// from: lazer's own LegacyScoreDecoder over the .osr rather than a hand-built
// frame list, which is what makes the play byte-for-byte the one the player
// made, including the legacy frame-time offset an early-version map bakes in
// and the mods the score-info block declares.
//
// this is an INSTRUMENT, not a fixture generator. it writes nowhere near
// fixtures/, takes no part in `--family`, and its dumps are of personal
// replays that never enter the tree. the per-event judgement offsets it
// carries -- which the scenario dumps deliberately omit as render-loop
// artifacts -- are read to locate a diverging object, never to pin a value.
public static partial class JudgementDumps
{
    /// decode one replay against one on-disk .osu through lazer's own legacy
    /// decoder. the beatmap is answered without consulting the hash, and the
    /// hash the file asked for is recorded instead, so a mispaired corpus
    /// entry reads as a line in the dump rather than as a silent re-run of
    /// the wrong map
    private sealed class RerunScoreDecoder : LegacyScoreDecoder
    {
        private readonly WorkingBeatmap beatmap;

        public string RequestedBeatmapHash { get; private set; } = "";

        public RerunScoreDecoder(WorkingBeatmap beatmap)
        {
            this.beatmap = beatmap;
        }

        protected override Ruleset GetRuleset(int rulesetId) =>
            rulesetId == 0
                ? new OsuRuleset()
                : throw new NotSupportedException($"replay re-run is osu!std only; this replay is ruleset {rulesetId}");

        protected override WorkingBeatmap GetBeatmap(string md5Hash)
        {
            RequestedBeatmapHash = md5Hash;
            return beatmap;
        }
    }

    /// <param name="clockStep">
    /// gameplay milliseconds per update frame -- lazer's display rate. the
    /// judgement scenarios are pinned at the family's own constant; this
    /// path takes it as an argument because a slider's accepted-key unlock
    /// costs three PASSES, so the gameplay time that gap spans is a function
    /// of the display rate, and sweeping it is what tells a display-rate
    /// artifact apart from a rules difference.
    ///
    /// keep this at or below 20ms. past that, FrameStabilityContainer clamps
    /// the jump to one 60hz frame and enters its catch-up loop, which is
    /// bounded by ten REAL cpu milliseconds
    /// (FrameStabilityContainer.max_catchup_milliseconds) -- the one place in
    /// this harness where wall time reaches gameplay, and the determinism the
    /// rest of it arranges stops holding.
    /// </param>
    public static void RunReplayRerun(string mapPath, string replayPath, string outFile, double clockStep, JsonSerializerOptions jsonOptions)
    {
        var flat = new FlatWorkingBeatmap(mapPath);
        var decoder = new RerunScoreDecoder(flat);

        Score score;
        using (var stream = File.OpenRead(replayPath))
            score = decoder.Parse(stream);

        var scoreInfo = score.ScoreInfo;
        var mods = scoreInfo.Mods.ToArray();
        var frames = score.Replay.Frames.Cast<OsuReplayFrame>().ToList();

        if (frames.Count == 0)
        {
            Console.Error.WriteLine($"replay re-run: {Path.GetFileName(replayPath)} decoded to zero frames");
            Environment.Exit(1);
        }

        // the map is handed to the host by path, so it decodes its own copy
        // the same way every judgement scenario does
        using var host = new HeadlessGameHost("fixture-gen-rerun", new HostOptions(), realtime: false);
        var game = new JudgementDumpGame(mapPath, frames, mods, clockStep);
        host.Run(game);

        if (game.Failure != null)
        {
            Console.Error.WriteLine($"replay re-run: {game.Failure}");
            Environment.Exit(1);
        }

        if (game.EndState == null)
        {
            Console.Error.WriteLine("replay re-run: gameplay never reported completion, so there is no end state to dump");
            Environment.Exit(1);
        }

        var events = game.Events.Select((e, i) => new
        {
            e.ObjectIndex,
            e.NestedIndex,
            e.Kind,
            e.StartTime,
            e.Result,
            e.IsHit,
            e.ComboAfter,
            TimeOffset = game.EventDetails[i].timeOffset,
            Time = game.EventDetails[i].time,
        }).ToArray();

        var payload = new
        {
            Map = Path.GetFileName(mapPath),
            Replay = Path.GetFileName(replayPath),
            ClockStepMs = clockStep,
            FrameCount = frames.Count,
            // what the FILE claims -- with the decoder's own arithmetic named
            // apart from it, because this instrument is worth nothing unless
            // the file and the pinned client are INDEPENDENT parties.
            //
            // LegacyScoreDecoder.Parse does not hand back everything it read.
            // it ends by calling StandardisedScoreMigrationTools
            // .UpdateToLatestScoring (legacyscoredecoder.cs:155), which for a
            // lazer score recomputes Accuracy and Rank with the PINNED
            // build's score processor and re-multiplies TotalScore off
            // TotalScoreWithoutMods, and then only while the score's
            // TotalScoreVersion is behind 30000017
            // (standardisedscoremigrationtools.cs:477-490) -- a condition the
            // dump cannot report, because :47 stamps LATEST_VERSION over that
            // field unconditionally afterwards, so the version below is the
            // RESULT of the migration and never a record of what it did --
            // and which for a
            // LEGACY score converts accuracy, rank and BOTH totals
            // (:58-67). reading those back as "what the file recorded" would
            // collapse two of the three parties into one, and hide exactly
            // the historical scoring difference this instrument exists to
            // expose.
            //
            // rank is the exception that has to be stated, not assumed: the
            // decoder restores the trailer's own rank AFTER the migration ran
            // (legacyscoredecoder.cs:157-158), so Rank IS the file's whenever
            // the file recorded one, and is the recomputed value only for a
            // file that recorded none.
            //
            // the ORIGINAL native header total is not recovered here -- the
            // decoder overwrites it in place and preserves the pre-migration
            // total under LegacyTotalScore for a stable score alone. it is
            // not worth a second .osr reader in an instrument, because the
            // engine side of this diff reads the header and the block through
            // this crate's own codec, which migrates nothing: the unmigrated
            // originals live there.
            File = new
            {
                RequestedBeatmapHash = decoder.RequestedBeatmapHash,
                ClientVersion = scoreInfo.ClientVersion,
                IsLegacyScore = scoreInfo.IsLegacyScore,
                Mods = mods.Select(m => m.Acronym).ToArray(),
                // read straight through, always the file's own
                Statistics = OrderedCounts(scoreInfo.Statistics),
                MaxCombo = scoreInfo.MaxCombo,
                // the file's own whenever it carried one:
                // PopulateMaximumStatistics returns early unless the map is
                // empty (legacyscoredecoder.cs:154), so only a file WITHOUT a
                // maximum map -- a stable replay -- gets one derived from the
                // beatmap instead
                MaximumStatistics = OrderedCounts(scoreInfo.MaximumStatistics),
                // the file's own whenever the trailer recorded a rank; see
                // the note above
                Rank = scoreInfo.Rank.ToString(),
                // the file's own only when the block carried it: otherwise
                // synthesised (legacyscoredecoder.cs:139-142), and for a
                // legacy score rewritten together with the total
                TotalScoreWithoutMods = scoreInfo.TotalScoreWithoutMods,
                // the file's own total, which the decoder preserves under this
                // name for a legacy score and leaves null for every other
                LegacyTotalScore = scoreInfo.LegacyTotalScore,
            },
            // the decoder's own arithmetic over the file's counts, which is a
            // third reading and not the file's -- see the note above
            FileAfterDecoderMigration = new
            {
                TotalScore = scoreInfo.TotalScore,
                TotalScoreVersion = scoreInfo.TotalScoreVersion,
                Accuracy = scoreInfo.Accuracy,
            },
            // what the PINNED client just did with the same frames
            Rerun = new
            {
                EndState = game.EndState,
                Events = events,
            },
        };

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outFile))!);
        File.WriteAllText(outFile, JsonSerializer.Serialize(payload, jsonOptions));
        Console.WriteLine(
            $"replay re-run: {Path.GetFileName(replayPath)} at {clockStep}ms/frame -> {outFile} " +
            $"({events.Length} judgements, max combo {game.EndState.MaxCombo}, total {game.EndState.TotalScore})");
    }
}
