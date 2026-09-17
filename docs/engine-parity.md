# Engine parity: the bounded pass of 2026-09-05

The parity pass is complete as a bounded investigation, not as a claim of
100% reproduction. Remaining parity work does not gate mod simulation or
other features. Keep measuring raw header agreement, and keep accepted
regression-test exceptions separate from that measurement.

This replaces the local engine-parity-pass plan's open-ended requirement
to reach 100%. The user accepted the bounded-pass recommendation on
2026-09-05: investigate the remaining promising cases, retain evidenced
fixes, document unresolved cases, then move feature work forward.

## Measurement

Release sweep, 3,773 complete NoMod stable-written plays from the same
personal library, with exact beatmap hash matches. This measures entire
plays matching aggregate fields, not individual-object judgement accuracy.
The personal corpus and sweep data are gitignored.

| Metric                     |      Before this pass | After spinner-grade fix |
| -------------------------- | --------------------: | ----------------------: |
| Counts and max combo exact | 3,626 / 3,773 (96.1%) |   3,640 / 3,773 (96.5%) |
| All eight fields exact     | 3,167 / 3,773 (83.9%) |   3,181 / 3,773 (84.3%) |
| Plays with any mismatch    |                   606 |                     592 |

Fourteen previously failing plays became exact; no previously exact play
became failing. The all-eight fields are 300/100/50/miss counts, max combo,
geki, katu (`count_katsu` in code), and total score. The sweep excludes
incomplete, modded, unmatchable and unprocessable inputs; in particular,
three simulation errors are reported separately by its admission filters.
These rates do not describe all replay formats or all players' libraries.

The behavioral comparison uses danser-go at
`8331b0ffb841cc9e0f5e6b756bcf2bba2a9465c0`. Its earlier control check matched
2,927 of 2,933 engine-exact plays (99.80%). Agreement with this reference
is useful evidence, not proof of recoverability or impossibility: the
engine shares some of its implementation lineage.

## What the 28 remaining reference-exact candidates actually contained

The earlier estimate of about 25 promising cases excluded three Aenbharr
plays as spinner cadence noise. Event-level comparison overturned that
classification. All 28 candidates received fresh reference judgement dumps
and engine event dumps in this pass.

| Cases | Mechanism                                                                  | Disposition                                        |
| ----: | -------------------------------------------------------------------------- | -------------------------------------------------- |
|    14 | Stable disc scoring paired with lazer's final spinner grade                | Fixed, including all three Aenbharr plays          |
|     4 | A negative 1 ms replay delta carries a keypress; frame conversion drops it | Deferred, recoverable input-handling work          |
|     8 | Replay version 20190410, before stable's May 2019 rule changes             | Deferred, version-aware simulation work            |
|     1 | FREEDOM repeat/tail pacing at a release boundary                           | Existing measured point-pacing divergence retained |
|     1 | Inai Sekai repeat timing from the hybrid tick/ball geometry                | Existing measured tick-walk compromise retained    |

### Spinner final grade

The engine already simulated stable's accelerating spinner disc and used
its scored half-turns for total score. Its final grade still came from
lazer's cursor-rotation completion fractions. That mixed two rulesets.
Stable's post-20190510 thresholds use integer half-turns: great above the
requirement, ok at requirement minus one, meh at integer requirement / 4;
a zero requirement is automatically great. The reference is
`app/rulesets/osu/spinner.go`, `UpdatePostFor` and `getRequirement*`.

`simulation/spinner.rs` now grades from that existing disc tally. The
lazer-derived spin/bonus presentation events stay intact. The changed
grade flows through the existing count, combo, score and section folds.
Tests cover the thresholds, extreme requirement arithmetic, and the
observable difference between fast cursor rotation and disc completion.
The fast-eight-spin test was observed failing under the old final grade.
Existing synthetic scenarios were independently judged through danser
before their stable expectations were changed. L207 (Aenbharr) is the
new real-play regression pin, copied from the original files.

### Backward timestamps: information present but discarded

Elder Dragon Legend object 682, Cross Time objects 214 and 25 (two plays),
and ChaserXX object 323 each have a keypress frame timestamped 1 ms before
the preceding motion frame. `replay::frames::convert_frames` follows
lazer's backward-time-drop rule and discards the press. The next held
frame arrives 18 ms later, changing the circle's grade. Danser consumes
the recorded press and matches the header.

This is not an information-loss floor in the file. A fix needs a defined
boundary between recorded order/timestamps and the monotonic frames used
by simulation, interpolation, frame selection and document editing.
Do not silently sort, clamp or retime these presses just to improve the
sweep; preserve source chronology and export semantics. The four source
plays and exact event times remain in the local final-pass report.

### Pre-May-2019 replay rules

All eight score-only reference-exact candidates have version **20190410**.
Earlier local notes claiming every admitted replay used the new handling
were wrong. Danser selects its between-frame post-update path below
20190506 and old spinner scoring below 20190510. The engine's simulation
entry point receives frames and a beatmap, without the replay version.

Cycle Hit (-27,300), Pandemonium (-576), and PUMP (-928) differ through a
head-miss reset occurring later than in the reference, losing one combo
unit over the subsequent run. The other five (Sound Chimera, Houkago
Stride, Aventurero, MONSTER, this storyends) have identical non-spinner
score contributions and differ by one 1,100-point spinner bonus. Treat
these as version-profile work, not proven irreducible cadence noise.

### The two slider cases

FREEDOM object 767 has ten spans in 220 ms. At 141654 the engine scores the
last repeat and tail together; danser processes only one point, then
drops the remaining tail on the release at 141655. Reverting to one point
per update was already measured and rejected across the library.

Inai Sekai object 657 is a six-span, 20 px linear slider. The engine's
third/fifth repeats become due later than danser's 158709/158769 points;
the last repeat and tail reach the released frame at 158782 instead of
the held duplicate-time frames at 158769. This is the known split between
the lazer-length tick walk and stable cut-line ball/end walk. Coupling all
ticks to the cut-line walk previously introduced 34 regressions. Neither
case justifies a map-specific fix or undoing that population measurement.

## Accepted exceptions and the stopping rule

**L203:** accept exactly katu -1 (simulated 15, header 16), with all other
seven fields exact. The earlier per-object investigation exhausted its
tested grade-placement explanations; danser agrees with the engine on
all eight fields. The precise original judgement remains unresolved.
This accepts an observed, tightly bounded reconstruction discrepancy;
it does not establish that every shared mismatch is irreducible.

`tests/replay_corpus.rs` pins that exact delta beside L033's existing
score-only -19,580 exception. A changed delta, an additional changed
field, or an unexpectedly exact result fails the test and requires review.
Neither exception alters simulation, export values, the integrity report,
or the sweep's raw agreement rate. There is no general spinner tolerance
or blanket exception for the reference's shared-mismatch bucket.

Reopen remaining work when there is a specific rule/profile change or
new evidence to test. Retain representative regressions and require a
whole-library before/after comparison for any change to shared timing or
geometry. Missing live update history remains a credible source of
spinner-score and placement residuals, but reference agreement alone is
not enough to classify an individual case as impossible.

Validation: `cargo test --workspace --quiet` passed 763 tests, including
the debug engine and app crate; `cargo test -p engine --release --quiet`
passed 417 tests. The final release sweep reproduced the measured fix
exactly and refreshed `fixtures/replays/local/sweep_manifest.json` and
`sweep_passing.json` (3,181 exact candidates).

Local reproduction records: `.scratch/engine-parity-pass/finalpass_triage.json`,
`finalpass-engine/`, `danser-oracle/finalpass-dumps/`,
`sweep_finalpass_baseline.json`, `sweep_finalpass_spinner_grade.json`, and
`spinner-synthetic/` (reference inputs and results, not golden fixtures).

## Native parity: the re-run pass of 2026-09-17

Everything above concerns the **stable** profile, whose oracle is stable's
own `.osr` header. This section concerns the **native** profile, whose oracle
is the score-info block a lazer-written `.osr` carries. It is a separate
measurement with a separate corpus and a failure mode the stable side does
not have: the block is written by whatever lazer build the player ran, so a
divergence has two possible causes -- this engine, or lazer's own gameplay
having changed since that build -- and comparing the two alone cannot say
which.

The pass opened with 65 native pairs, 36 exact and 29 diverging in three
named classes, and no way to attribute any of them. It closes with the
divergences attributed, one port defect found and fixed, and the corpus
green.

### The third party

`tools/fixture-gen` gained a replay re-run mode (`ReplayRerun.cs`;
`--rerun-map`, `--rerun-replay`, `--rerun-out`, `--rerun-clock-step`). It
decodes a real `(.osr, .osu)` pair through lazer's own `LegacyScoreDecoder`
and plays it through a real `ReplayPlayer` on the pinned checkout, dumping
lazer's per-element judgement timeline -- result, hit offset and application
time per object -- beside the file's own block. The engine's side of that
comparison is `cargo run -p engine --release --example dump_native_timeline`,
the native counterpart `diagnose_replay` lacks (that instrument's views --
the section tally, peppy stars, the eight stable comparisons -- are stable's
own and describe nothing on a lazer-written play). Both are instruments,
never fixture generators: they write nowhere near `fixtures/` and take no
part in `--family`.

**Its `File` side is not wholly the file's.** `LegacyScoreDecoder.Parse` ends
by calling `StandardisedScoreMigrationTools.UpdateToLatestScoring`
(`legacyscoredecoder.cs:155`), which recomputes accuracy with the _pinned_
build's score processor and re-multiplies the total (and, for a stable score,
converts accuracy, rank and both totals). So `TotalScore` and `Accuracy` are a
third reading rather than the file's record, and the dump names them apart
under `FileAfterDecoderMigration` beside the resulting `TotalScoreVersion`.
That version cannot say whether the multiplier step ran: it is gated on the
version being behind `30000017`, but `UpdateToLatestScoring` then stamps
`LATEST_VERSION` over the field unconditionally
(`standardisedscoremigrationtools.cs:47`), so what the dump carries is the
outcome and not a record of the decision. **Rank is the exception and has to be
stated rather than assumed**: the decoder restores the trailer's own rank
_after_ the migration ran (`legacyscoredecoder.cs:157-158`), so it is the
file's whenever the file recorded one. The counts and the max combo are read
straight through; the maximum map is the file's unless the file carried none,
in which case `PopulateMaximumStatistics` derives it from the beatmap; and
`TotalScoreWithoutMods` is the file's only when the block carried it. The
original _native_ header total is not recovered in this dump at all — the
decoder overwrites it in place and preserves a pre-migration total only for a
stable score — which costs nothing, because the engine side of the diff reads
the header and the block through this crate's own codec, which migrates
nothing.

**Know its limit before you use it.** The re-run reproduces grading exactly
and repeatably: two invocations agree on every grade and every hit offset,
bit for bit. It does _not_ reproduce slider tracking stably -- two identical
invocations of one play differed in 8 slider tails and in nothing else, and
sweeping the display rate from 1ms to 20ms moved the count again. So its
per-element **times and offsets** are evidence and its **tail counts are
not**. Reading the counts as an oracle during this pass produced a confident
and wrong conclusion, which the fix below then falsified.

### Grade divergences are lazer's, and dated

Lazer PR #33882, "Apply flooring and half-millisecond-adjustments to hit
windows" (`0f078ee550`, authored 2025-04-18, **merged 2025-07-02**), changed
`OsuHitWindows.SetDifficulty` from `DifficultyRange(od, ...)` to
`Math.Floor(DifficultyRange(od, ...)) - 0.5`. Every window narrows, which is
why the engine reads one grade harsher than older files and never more
lenient. The engine already ports the pinned rule
(`beatmap/difficulty.rs:85-87`).

The change lands on a floor boundary, so with integer replay frame times the
only hit errors it can move are those at exactly `|offset| == floor(window)`.
Re-running two affected plays and counting that band reproduced their grade
deltas exactly -- 1 object for a delta of 1, 3 objects for a delta of 3 --
and in both the pinned client's grades equalled the engine's on every object.
Across the corpus, all 21 plays with a grade divergence come from clients
predating the merge and none of the 34 from clients after it does.

### The slider-tail class was a port defect: a gate lazer never opens

`FramedReplayInputHandler` refuses every update time strictly inside the 20ms
before a successor frame while a button is held -- its _important section_
(`framedreplayinputhandler.cs:105-160`). The native walk modelled that rule.
It should not have: the gate reads `FrameAccuratePlayback`, a public field
the game assigns **nowhere**. The only assignment in the entire checkout is
in `FramedReplayInputHandlerTest`, and there has been no other since the
field was introduced in 2017. In a real client `inImportantSection` is always
false and `SetFrameFromTime` never returns null for that reason.

Honouring a gate lazer leaves shut cost slider tails specifically, because a
tail's leniency point (`end - 36`, `SliderEventGenerator.TAIL_LENIENCY`)
falls inside a frame span far more often than on a frame, and a held button
during a slider is the normal case. Deferring that instant to the next frame
samples tracking up to a frame late, by which time the follow circle has
moved on; the tail then waits, and lands as an `IgnoreMiss` at the first
instant past the slider's end.

The instrument found it by time, not by count. On one diverging slider the
pinned client judged the tail 1.2ms after the leniency point opened, while
the engine judged it 17ms past the slider's end -- so the engine had not
visited the window at all.

Removing the gate (`simulation::native`, and with it `IMPORTANT_TIME_SPAN`)
recovered the class whole:

| Measure (65 native pairs)             | Before | After |
| ------------------------------------- | -----: | ----: |
| Exact against the full block          |     36 |    40 |
| Slider tails missing corpus-wide      |     92 |    −2 |
| Plays with a cadence-field divergence |     22 |     8 |
| Stable-profile corpus regressions     |      — |     0 |
| Judgement fixtures needing a re-pin   |      — |     0 |

`N043`, the largest single divergence in the corpus at 14 tails and the one
pair whose client was contemporary with the pin, is now exact. No judgement
fixture moved, because none of the nineteen scenarios places an element
inside a held-button frame span -- which is precisely why the family never
caught this.

### What genuinely is not determined by a `.osr`

What remains is small and falls both ways. `ReplayRecorder.RecordFrameRate =
60` throttles positional replay frames to 60 Hz however fast the client is
running, while tracking and spinner rotation are sampled once per **display**
frame. The display cadence is therefore absent from the file, this walk takes
the limit of an arbitrarily fast display, and the two land on opposite sides
of an element occasionally.

Measured over the corpus after the fix: eight plays, every one of them a
single element pair, largest magnitude **2**, and in both directions (the
engine is one over on `N012` and one under on `N056`). That is a noise floor,
not a bias, and it is the irreducible part.

### Measurement

| Client era                          | Pairs | Exact, full block | Exact, determined fields |
| ----------------------------------- | ----: | ----------------: | -----------------------: |
| Predates the 2025-07-02 merge       |    31 |           8 (26%) |        n/a (grade drift) |
| At or after it -- the pin's own era |    34 |          32 (94%) |       **34 / 34 (100%)** |
| Whole corpus                        |    65 |          40 (62%) |       **65 / 65 (100%)** |

`verify_native_pair` now splits the block into the half a `.osr` determines
and the two halves it does not, and the corpus test passes. Nothing is
hidden: each excused play prints its exact delta and the cause
(`cargo test -p engine --release --test replay_corpus -- --nocapture`), and
each class is bounded so a regression still fails --

- **grade fields** are excused only for a play whose ledger `client_date`
  predates `HIT_WINDOW_MERGE`, and only in the shape that change can make.
  Narrowing a window moves objects DOWN the `great -> ok -> meh -> miss`
  ladder and never up, so walking that ladder best-first the running balance
  must never go positive and must close at zero. That admits an `ok`-to-`meh`
  move, whose `great` never budges, and rejects a shape like
  `{great: -1, ok: 3, meh: -2}`, which needs two objects to have got _better_.
  Any other shape, or any shape at all on a later client, fails.
- **cadence fields** (`slider_tail_hit`, `ignore_miss`, `large_tick_*`,
  `*_bonus`) are excused only if they net to zero **within their own
  conservation group**, and only up to `CADENCE_NOISE_FLOOR`, set to the
  largest divergence the corpus has ever shown rather than to a round number
  with room in it. The pre-fix `N043` would have failed this at 14. There are
  two groups, because an element trades only within the set its own kind can
  produce: a slider tick or repeat is a `LargeTickHit` or a `LargeTickMiss`,
  while a slider tail and a spinner's bonus tick both fall back to
  `IgnoreMiss`, which is what joins them into one group with
  `SliderTailHit` and the two bonuses. Summing the groups together would
  admit a `large_tick_hit: -1` cancelling a `slider_tail_hit: +1` -- a
  misclassification wearing the noise floor's clothes, since no display rate
  turns a tick into a tail.
- `max_combo`, `total_score` and the rank are folded FROM the statistics, so
  an excused difference in the counts excuses them too -- but only as far as
  the differing result class can reach, never as one blanket. `SmallBonus`,
  `LargeBonus` and the `IgnoreMiss` they trade against are worth points and
  nothing else, so a play excused only those is still held to its combo and
  its rank exactly; an era downgrade moves accuracy and the total but can
  never move combo, so such a play is still held to its combo. Whatever a
  difference cannot reach stays pinned.

The claim this supports: **against clients contemporary with the pin, the
engine reproduces every field of the score-info block that a `.osr`
determines, on 34 of 34 plays**; the eight excused cadence rows corpus-wide
are single elements, and the 21 excused grade rows are lazer's own change.
This is not comparable to the stable side's 96.5%: that corpus has no
client-era axis, and stable's header records fields its own engine
determines.

### Stopping rule

The one defect this pass found is fixed. What is left is the
sub-display-frame residual, which no implementation reading a `.osr` can
remove, and lazer's own historical hit windows, which the engine must not
reproduce. A native divergence found in future goes through the re-run
instrument before anything is changed -- reading its per-element times, not
its tail counts -- and a divergence that trips either bound above comes back
for review rather than widening it.

Local reproduction records: `.scratch/native-corpus/rerun-findings.md` and
the dumps in `.scratch/native-corpus/rerun/` (gitignored with the corpus).
