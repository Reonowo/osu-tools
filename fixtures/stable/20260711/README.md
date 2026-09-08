# stable database fixtures — version 20260711

## `osu!.db`

A real osu! stable client's beatmap listing (`osu!.db` version
20260711, captured 2026-09-07) cut down to its header and ONE beatmap entry by
`tools/slice-osu-db.py`. It is stable's own bytes, not a re-serialisation:
the slicer walks every field of every entry in the source file and refuses to
write unless that walk consumes the file exactly, so the cut is verified
against the whole 22 MB listing rather than assumed from a spec.

What is in it, and what is not:

- the header with the player name blanked and the folder count set to 1
- one entry, chosen as the first standard-mode map the player had never
  played (grades unplayed, no last-played time), so it carries beatmap
  metadata only: `73dc65db8bf113b5bf21d7ace5ef131b`, folder `Carnival`,
  file `- Carnival (Pawnables) [Merry Go 'Round].osu`, 36 **float**-tagged
  star-rating pairs (`0x0c`) and 3 timing points
- the source's own trailing user-permissions int

This is the post-20250107 half of the tag pair: the same beatmap at
version 20231102, with double-tagged ratings, sits in `../20231102/`. The two
are what pin `engine::formats::stable_listing`'s rule that a star-rating pair
is read off its own value tag rather than off the listing version — the one
change stable has already made once. `src-tauri/src/stable.rs` additionally
reads this slice through the production `ListingCache` and `find_beatmap_by_md5`
to the re-hash, so the app's own lookup is exercised on a real client's bytes.

Recapture on the next listing format change:

```bash
python tools/slice-osu-db.py "E:\osu!\osu!.db" fixtures/stable/20260711/osu!.db
```

Rerunning against the same source is byte-identical. Then update the expected
values in the engine's `stable_listing` tests and in `stable.rs` from what the
slicer prints; the pair count belongs in the osu-db cross-check, which is the
only test that still looks at the ratings the reader discards.


## `scores.db`

A real osu! stable client's local leaderboards (`scores.db` version 20260711,
captured 2026-09-07) cut down to its header and ONE local play by
`tools/slice-scores-db.py`, the sibling of the listing slicer beside it and
the same posture: the slicer walks every field of every row in the source and
refuses to write unless that walk consumes the file exactly, so the cut is
verified against the whole 194 KB database rather than assumed from a spec.

What is in it, and what is not:

- one beatmap group, keyed by the source's own hash bytes
- one score in it, chosen as the first standard-mode NoMod row in file order
  whose `Data/r` replay file existed at capture: beatmap
  `5afc67b1fbc077f262797719c3ca8423`, replay hash
  `218bf1b8050b63ea470d4e62555ec715`, row framing version 20190410,
  76/26/7/13/5/14, 50,240 points, 30 max combo, .NET ticks
  636895947445841476 (2019-03-31)
- the row's bytes verbatim EXCEPT the player name, which is blanked to the
  empty string — the account that played is not what this fixture is for, and
  the listing slicer beside it blanks the header's name for the same reason
- **no replay file.** the row names `Data/r/5afc67b1fbc077f262797719c3ca8423-
  131984715445841476.osr` under the epoch rule, and that file is not
  committed; the app-crate tests build their own fake installs instead

It pairs with the listing slice above by VERSION, not by beatmap: the
Carnival map the listing carries has no local scores row, so nothing here
titles anything. `engine::formats::local_scores` decodes it field-exact and
cross-checks it against the `osu-db` crate's independent reader; the app's own
browser tests pair a title with a play through an oracle-written fake install.

Recapture on the next `scores.db` format change:

```bash
python tools/slice-scores-db.py "E:\osu!\scores.db" fixtures/stable/20260711/scores.db --replays "E:\osu!\Data\r"
```

Rerunning against the same source is byte-identical. Then update the expected
values in the engine's `local_scores` tests from what the slicer prints.
