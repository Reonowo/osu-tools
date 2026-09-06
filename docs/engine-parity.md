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
