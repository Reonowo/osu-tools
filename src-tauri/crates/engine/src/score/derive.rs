//! the full derived-field set a regenerating export overlays, plus its
//! checked narrowing into the header's on-disk widths

use crate::beatmap::ProcessedBeatmap;
use crate::error::Result;
use crate::score::{
    derive_health, is_perfect, life_bar_graph, peppy_stars, section_tally, total_score, HealthCurve,
    ScoreContext, NOMOD_SCORE_MULTIPLIER,
};
use crate::simulation::JudgementTimeline;

/// every derived value at simulation width, before narrowing. carries the
/// section triple and the whole health curve alongside the header fields so
/// the integrity report's cross-check, the export overlay and a later HUD
/// all come from one derivation
#[derive(Debug, Clone, PartialEq)]
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
    pub sections_without_burst: u32,
    /// the life bar samples and the drain-rate search behind them. the
    /// search runs here rather than only at export because the integrity
    /// report reads this same derivation at load; it is cheap at the 3 to 65
    /// passes real maps need
    pub health: HealthCurve,
}

/// derives everything from one simulation pass. the mod multiplier is
/// pinned to NoMod, matching the simulation gate -- the multiplier table
/// ships with mod simulation itself (TODO.md)
pub fn derive_score(
    processed: &ProcessedBeatmap,
    timeline: &JudgementTimeline,
    ctx: &ScoreContext,
) -> Result<DerivedScore> {
    let health = derive_health(processed, timeline, ctx);
    derive_score_with_health(processed, timeline, ctx, health)
}

/// the same derivation over a health fold the caller already holds.
///
/// the seam exists for the load path, which needs the HP curve for the
/// viewer AND these fields for the integrity report: folding twice would
/// repeat stable's map-load drain-rate search, which is the expensive half
pub fn derive_score_with_health(
    processed: &ProcessedBeatmap,
    timeline: &JudgementTimeline,
    ctx: &ScoreContext,
    health: HealthCurve,
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
        total_score: total_score(timeline, processed, stars, NOMOD_SCORE_MULTIPLIER),
        sections: tally.sections,
        sections_without_burst: tally.sections_without_burst,
        health,
    })
}

/// the derived fields at their `.osr` on-disk widths, ready to overlay onto
/// a header. constructed only through [`DerivedFields::narrow`], so a value
/// that cannot fit its field never silently wraps into a lie
#[derive(Debug, Clone, PartialEq, Eq)]
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
    /// the regenerated life bar graph, already thinned and formatted. the
    /// one field here with no on-disk width to overflow -- it is written as
    /// an osu! string, so narrowing cannot fail on it
    pub life_bar: String,
    /// whether the drain-rate search behind that graph settled. NOT a header
    /// field: it rides here so the export summary can say the life bar was
    /// regenerated without a converged search rather than claiming more than
    /// it knows (`limits::MAX_HEALTH_DRAIN_SEARCH_ITERATIONS`)
    pub life_bar_converged: bool,
}

/// a derived value exceeded its on-disk width; `field` uses the wire
/// spelling the export error surfaces to the frontend
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OverflowField {
    pub field: &'static str,
}

impl DerivedFields {
    /// writes every derived value onto a header in one place, so the
    /// regenerating export cannot half-apply the set. the life bar graph is
    /// part of the set: a frame-dirty export never carries the source's,
    /// which describes frames that no longer exist
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
        header.life_graph = Some(self.life_bar.clone());
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
            life_bar: life_bar_graph(&score.health.samples),
            life_bar_converged: score.health.search.converged,
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
            sections_without_burst: 0,
            health: health_curve(&[(0.0, 1.0), (3000.0, 0.86)]),
        }
    }

    /// a curve carrying only what narrowing reads: the samples and the
    /// search's converged flag. the breakpoint list is nothing narrowing
    /// looks at -- it is the viewer's half of the fold -- so it stays empty
    fn health_curve(samples: &[(f32, f32)]) -> HealthCurve {
        HealthCurve {
            search: crate::score::DrainRateSearch {
                rate: 0.03,
                normal_multiplier: 1.0,
                combo_end_multiplier: 1.0,
                hp_after_perfect_play: vec![200.0],
                max_combo: 111,
                iterations: 7,
                converged: true,
            },
            samples: samples
                .iter()
                .map(|&(time, value)| crate::score::LifeBarSample { time, value })
                .collect(),
            points: Vec::new(),
        }
    }

    #[test]
    fn narrowing_writes_the_thinned_graph_and_carries_the_converged_flag() {
        let fields = DerivedFields::narrow(&wide(100, 1000)).unwrap();
        assert_eq!(fields.life_bar, "0|1,3000|0.86,");
        assert!(fields.life_bar_converged);

        // a search that did not settle still produces a graph; the flag is
        // what tells the summary so
        let mut unsettled = wide(100, 1000);
        unsettled.health.search.converged = false;
        assert!(!DerivedFields::narrow(&unsettled).unwrap().life_bar_converged);

        // and a curve with no samples narrows to the empty string rather
        // than failing -- a string has no on-disk width to overflow
        let mut empty = wide(100, 1000);
        empty.health.samples.clear();
        assert_eq!(DerivedFields::narrow(&empty).unwrap().life_bar, "");
    }

    #[test]
    fn the_overlay_writes_the_regenerated_graph_onto_the_header() {
        let fields = DerivedFields::narrow(&wide(100, 1000)).unwrap();
        let mut header = crate::formats::osr::OsrHeader {
            mode: crate::formats::GameMode::Osu,
            version: 20240101,
            beatmap_md5: None,
            player_name: None,
            replay_md5: None,
            count_300: 0,
            count_100: 0,
            count_50: 0,
            count_geki: 0,
            count_katsu: 0,
            count_miss: 0,
            total_score: 0,
            max_combo: 0,
            perfect: false,
            mods: 0,
            life_graph: Some("the source's own graph".into()),
            timestamp_ticks: 0,
            online_score_id: 0,
        };
        fields.overlay_onto(&mut header);
        assert_eq!(header.life_graph.as_deref(), Some("0|1,3000|0.86,"));
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
