//! the full derived-field set a regenerating export overlays, plus its
//! checked narrowing into the header's on-disk widths

use crate::beatmap::ProcessedBeatmap;
use crate::error::Result;
use crate::score::{is_perfect, peppy_stars, section_tally, total_score, ScoreContext, NOMOD_SCORE_MULTIPLIER};
use crate::simulation::JudgementTimeline;

/// every derived value at simulation width, before narrowing. carries the
/// section triple alongside the header fields so the integrity report's
/// cross-check and the export overlay come from one derivation
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DerivedScore {
    pub count_300: u32,
    pub count_100: u32,
    pub count_50: u32,
    pub count_geki: u32,
    pub count_katsu: u32,
    pub count_miss: u32,
    pub max_combo: u32,
    pub perfect: bool,
    pub total_score: u64,
    pub sections: u32,
    pub sections_with_miss: u32,
}

/// derives everything from one simulation pass. the mod multiplier is
/// pinned to NoMod, matching the simulation gate -- the multiplier table
/// ships with mod simulation itself (TODO.md)
pub fn derive_score(
    processed: &ProcessedBeatmap,
    timeline: &JudgementTimeline,
    ctx: &ScoreContext,
) -> Result<DerivedScore> {
    let tally = section_tally(processed, timeline);
    let stars = peppy_stars(ctx)?;
    Ok(DerivedScore {
        count_300: timeline.totals.count_300,
        count_100: timeline.totals.count_100,
        count_50: timeline.totals.count_50,
        count_geki: tally.count_geki,
        count_katsu: tally.count_katsu,
        count_miss: timeline.totals.count_miss,
        max_combo: timeline.totals.max_combo,
        perfect: is_perfect(processed, &timeline.totals),
        total_score: total_score(timeline, stars, NOMOD_SCORE_MULTIPLIER),
        sections: tally.sections,
        sections_with_miss: tally.sections_with_miss,
    })
}

/// the derived fields at their `.osr` on-disk widths, ready to overlay onto
/// a header. constructed only through [`DerivedFields::narrow`], so a value
/// that cannot fit its field never silently wraps into a lie
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DerivedFields {
    pub count_300: u16,
    pub count_100: u16,
    pub count_50: u16,
    pub count_geki: u16,
    pub count_katsu: u16,
    pub count_miss: u16,
    pub max_combo: u16,
    pub perfect: bool,
    pub total_score: u32,
}

/// a derived value exceeded its on-disk width; `field` uses the wire
/// spelling the export error surfaces to the frontend
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverflowField {
    pub field: &'static str,
}

impl DerivedFields {
    /// writes every derived value onto a header in one place, so the
    /// regenerating export cannot half-apply the set
    pub fn overlay_onto(&self, header: &mut crate::formats::osr::OsrHeader) {
        header.count_300 = self.count_300;
        header.count_100 = self.count_100;
        header.count_50 = self.count_50;
        header.count_geki = self.count_geki;
        header.count_katsu = self.count_katsu;
        header.count_miss = self.count_miss;
        header.max_combo = self.max_combo;
        header.perfect = self.perfect;
        header.total_score = self.total_score;
    }

    pub fn narrow(score: &DerivedScore) -> core::result::Result<Self, OverflowField> {
        fn u16_field(value: u32, field: &'static str) -> core::result::Result<u16, OverflowField> {
            u16::try_from(value).map_err(|_| OverflowField { field })
        }
        Ok(Self {
            count_300: u16_field(score.count_300, "count300")?,
            count_100: u16_field(score.count_100, "count100")?,
            count_50: u16_field(score.count_50, "count50")?,
            count_geki: u16_field(score.count_geki, "countGeki")?,
            count_katsu: u16_field(score.count_katsu, "countKatsu")?,
            count_miss: u16_field(score.count_miss, "countMiss")?,
            max_combo: u16_field(score.max_combo, "maxCombo")?,
            perfect: score.perfect,
            total_score: u32::try_from(score.total_score).map_err(|_| OverflowField { field: "totalScore" })?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wide(max_combo: u32, total_score: u64) -> DerivedScore {
        DerivedScore {
            count_300: 100,
            count_100: 10,
            count_50: 1,
            count_geki: 20,
            count_katsu: 5,
            count_miss: 0,
            max_combo,
            perfect: true,
            total_score,
            sections: 25,
            sections_with_miss: 0,
        }
    }

    #[test]
    fn narrowing_admits_the_exact_on_disk_maxima() {
        let fields = DerivedFields::narrow(&wide(65_535, u64::from(u32::MAX))).unwrap();
        assert_eq!(fields.max_combo, 65_535);
        assert_eq!(fields.total_score, u32::MAX);
    }

    #[test]
    fn narrowing_fails_one_past_each_width_naming_the_field() {
        assert_eq!(
            DerivedFields::narrow(&wide(65_536, 0)).unwrap_err().field,
            "maxCombo"
        );
        assert_eq!(
            DerivedFields::narrow(&wide(1, u64::from(u32::MAX) + 1)).unwrap_err().field,
            "totalScore"
        );

        let mut counts = wide(1, 0);
        counts.count_300 = 65_536;
        assert_eq!(DerivedFields::narrow(&counts).unwrap_err().field, "count300");
        let mut geki = wide(1, 0);
        geki.count_geki = 65_536;
        assert_eq!(DerivedFields::narrow(&geki).unwrap_err().field, "countGeki");
    }
}
