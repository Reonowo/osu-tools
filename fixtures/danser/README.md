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
