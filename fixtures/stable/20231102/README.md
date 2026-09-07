# stable listing fixture — version 20231102

`osu!.db` is a real osu! stable client's beatmap listing (`osu!.db` version
20231102) cut down to its header and ONE beatmap entry by
`tools/slice-osu-db.py`. It holds the **same beatmap** as `../20260711/` —
same md5, same folder, same file name — written before stable changed the
per-mod star-rating pairs from int-double to int-float at version 20250107,
so the two slices differ in exactly the field that change touched. That is
what pins `engine::formats::stable_listing`'s rule that the pair is read off
its own value tag (`0x0d` double, `0x0c` float), never off the version.

What is in it, and what is not:

- the header with the player name blanked and the folder count set to 1
- one entry, chosen as the first standard-mode map the player had never
  played (grades unplayed, no last-played time), so it carries beatmap
  metadata only: `73dc65db8bf113b5bf21d7ace5ef131b`, folder `Carnival`,
  file `- Carnival (Pawnables) [Merry Go 'Round].osu`, 9 **double**-tagged
  star-rating pairs (`0x0d`) and 89 timing points
- a zero user-permissions int — see the caveat

## Caveat: the source was truncated

The source is not a live listing but one of the ticks-named backups stable
leaves beside it (`osu!.db.638348768968328278`, 14,462,976 bytes), and stable
cut it at an exact 4096-byte boundary: the slicer's walk runs clean through
**6,321 of the 17,373 declared entries** and then reaches end-of-file three
bytes into entry 6,321. So this slice was cut with the slicer's
`--truncated-source` flag, and two things follow.

- The field layout is confirmed over those 6,321 entries, not over the whole
  file: the slicer's usual end-of-file check — walk must consume the source
  exactly — **could not run**. Only entries the walk finished were candidates,
  so the chosen entry is still stable's own complete bytes for that entry.
- The source's own trailing user-permissions int is past the cut, so the
  slice carries a zero there rather than a byte the walk never saw.

Recapture:

```bash
python tools/slice-osu-db.py "E:\osu!\osu!.db.638348768968328278" \
  fixtures/stable/20231102/osu!.db --truncated-source
```

Rerunning against the same source is byte-identical. Without the flag the
slicer refuses this source, which is the intended behaviour for anything that
is not a known-truncated backup. Then update the expected values in the
engine's `stable_listing` tests from what the slicer prints.
