# danser fixtures

`render-transcript-0.11.0.txt` is the complete stdout+stderr of one real
`danser-cli.exe -record` run of the pinned danser 0.11.0 Windows release
(captured 2026-08-25, NoMod replay, minimal settings profile, `-sPatch`
resolution/encoder/OutputDir overrides, `-preciseprogress`). It is this
repo's own captured text — no danser or lazer content — and it is the golden
input for the stdout progress-parser tests in
`src-tauri/src/video/danser/stdout.rs`.

The grammar the parser relies on, all present in this capture:

- log lines carry a `YYYY/MM/DD HH:MM:SS ` prefix; ffmpeg's own output is
  interleaved unprefixed
- `Starting encoding!` arms the percent parser (nothing before it is a
  render progress line)
- `Progress: N%, Speed: X.XXx, ETA: Ns` feeds progress
- `Finished!` / `Video is available at: <path>` is success (an earlier
  `Finished! Stopping video pipe...` line is not the terminal marker)
- `panic: <detail>` is failure (see the capped-run captures in the stdout
  tests for `panic:` and `Beatmap not found, closing...`, both also observed
  against the real binary)

Recapture only on a danser pin bump: install the pinned release, stage any
NoMod corpus replay whose beatmap resolves from a private Songs dir, run
`danser-cli.exe -replay <osr> -record -out <name> -settings <profile>
-sPatch <json> -noupdatecheck -quickstart -preciseprogress` and save the
combined output verbatim.

## Lazer replays through the pinned renderer (spike, 2026-09-16)

`lazer-transcript-0.11.0-block.txt` and `lazer-transcript-0.11.0-stripped.txt`
are the complete stdout+stderr of two `danser-cli.exe -record` runs of the
same pinned 0.11.0 release over one lazer-written replay (header version
30000016, NoMod, rank F, client 2026.401.0-lazer) and its beatmap, staged the
way the app stages (`danser-songs/<md5-8>/`), with the app's own profile and
`-sPatch` shape. The first run is the file as lazer wrote it, score-info block
present; the second is the same file with the block replaced by the framed
empty array a regenerating export used to write. The player name is redacted
to `<player>`; nothing else is edited. What the two runs establish, as the
renderer's own limits and separate from what the engine supports:

- **it accepts the file**, both ways: `Replay loaded!`, a full render,
  `Finished!` and `Video is available at:` on both, exit 0, in about five
  seconds at 720p for a 29 s play. No new stdout grammar: the existing parser
  concludes both transcripts.
- **it does not read the block.** The two transcripts differ only in timing
  and progress lines and in the first run's one-time import of the newly
  staged set. Its mod line reads the header: `Mods: LZ` -- danser's own
  pseudo-mod for a lazer-written replay, set off the header VERSION, since the
  legacy bitfield is zero -- and `Calculating step SR for mods: NM`.
- **it plays the replay under its lazer ("LZ") path**, not Classic: the
  `Expected score: 147051` it prints is the header's standardised total, the
  same number the block carries as `total_score_without_mods`. Whether its
  judgement agrees with lazer's frame for frame is not something these
  transcripts measure; the video exists, the numbers it draws are its own.
- **stdout on failure** was not exercised, since neither run failed; the
  known failure lines (`panic:`, `Beatmap not found, closing...`) remain the
  capped-run captures in the stdout tests. One new line of chatter is
  present in both runs and harmless: `Error connecting to osu!api: oauth2:
  "invalid_request" ...` (the install's `credentials.json` carries no keys).

So a regenerating native export -- the encoder's latest version, a fresh
block -- renders exactly as its source did as far as danser is concerned: the
version selects its LZ path, the bitfield stays zero, and the block is
carried past. Recapture on a danser pin bump beside the stable transcript.
