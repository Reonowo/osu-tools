//! lazer's judgement result vocabulary (hitresult.cs) and the per-result
//! classification its score processor reads: which results are hits, which
//! move combo, which count toward accuracy, which are bonus, and the base
//! score each is worth (scoreprocessor.cs:346-380). the native profile
//! judges in this vocabulary and the score-info block records counts by it;
//! the stable profile's four grades are the basic subset

/// hitresult.cs, in the enum's own order -- `is_scorable` reads the order
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum HitResult {
    Miss,
    Meh,
    Ok,
    Good,
    Great,
    Perfect,
    SmallTickMiss,
    SmallTickHit,
    LargeTickMiss,
    LargeTickHit,
    SmallBonus,
    LargeBonus,
    IgnoreMiss,
    IgnoreHit,
    ComboBreak,
    SliderTailHit,
    LegacyComboIncrease,
}

impl HitResult {
    /// every result, in enum order
    pub const ALL: [HitResult; 17] = [
        HitResult::Miss,
        HitResult::Meh,
        HitResult::Ok,
        HitResult::Good,
        HitResult::Great,
        HitResult::Perfect,
        HitResult::SmallTickMiss,
        HitResult::SmallTickHit,
        HitResult::LargeTickMiss,
        HitResult::LargeTickHit,
        HitResult::SmallBonus,
        HitResult::LargeBonus,
        HitResult::IgnoreMiss,
        HitResult::IgnoreHit,
        HitResult::ComboBreak,
        HitResult::SliderTailHit,
        HitResult::LegacyComboIncrease,
    ];

    /// the result's index in [`HitResult::ALL`]
    pub fn ordinal(self) -> usize {
        self as usize
    }

    /// hitresult.cs:305-324
    pub fn is_hit(self) -> bool {
        !matches!(
            self,
            HitResult::Miss
                | HitResult::SmallTickMiss
                | HitResult::LargeTickMiss
                | HitResult::IgnoreMiss
                | HitResult::ComboBreak
        )
    }

    /// hitresult.cs:183-203
    pub fn affects_combo(self) -> bool {
        matches!(
            self,
            HitResult::Miss
                | HitResult::Meh
                | HitResult::Ok
                | HitResult::Good
                | HitResult::Great
                | HitResult::Perfect
                | HitResult::LargeTickHit
                | HitResult::LargeTickMiss
                | HitResult::LegacyComboIncrease
                | HitResult::ComboBreak
                | HitResult::SliderTailHit
        )
    }

    pub fn increases_combo(self) -> bool {
        self.affects_combo() && self.is_hit()
    }

    pub fn breaks_combo(self) -> bool {
        self.affects_combo() && !self.is_hit()
    }

    /// hitresult.cs:267-278
    pub fn is_bonus(self) -> bool {
        matches!(self, HitResult::SmallBonus | HitResult::LargeBonus)
    }

    /// hitresult.cs:248-262
    pub fn is_tick(self) -> bool {
        matches!(
            self,
            HitResult::LargeTickHit
                | HitResult::LargeTickMiss
                | HitResult::SmallTickHit
                | HitResult::SmallTickMiss
                | HitResult::SliderTailHit
        )
    }

    /// hitresult.cs:328-347 -- everything from miss up to the bonuses in
    /// enum order, plus the three results the enum places after the ignores
    pub fn is_scorable(self) -> bool {
        match self {
            HitResult::IgnoreMiss | HitResult::IgnoreHit => false,
            _ => true,
        }
    }

    /// hitresult.cs:208-223
    pub fn affects_accuracy(self) -> bool {
        match self {
            HitResult::LegacyComboIncrease | HitResult::ComboBreak => false,
            _ => self.is_scorable() && !self.is_bonus(),
        }
    }

    /// hitresult.cs:228-243 -- a non-tick, non-bonus scorable result
    pub fn is_basic(self) -> bool {
        match self {
            HitResult::LegacyComboIncrease | HitResult::ComboBreak => false,
            _ => self.is_scorable() && !self.is_tick() && !self.is_bonus(),
        }
    }

    /// scoreprocessor.cs:346-380
    pub fn base_score(self) -> u32 {
        match self {
            HitResult::SmallTickHit => 10,
            HitResult::LargeTickHit => 30,
            HitResult::SliderTailHit => 150,
            HitResult::Meh => 50,
            HitResult::Ok => 100,
            HitResult::Good => 200,
            HitResult::Great | HitResult::Perfect => 300,
            HitResult::SmallBonus => 10,
            HitResult::LargeBonus => 50,
            _ => 0,
        }
    }

    /// judgement.cs:61-85 -- the minimum result a judgement with this
    /// maximum can take
    pub fn default_min_result(max: HitResult) -> HitResult {
        match max {
            HitResult::SmallBonus | HitResult::LargeBonus | HitResult::IgnoreHit => HitResult::IgnoreMiss,
            HitResult::SmallTickHit => HitResult::SmallTickMiss,
            HitResult::LargeTickHit => HitResult::LargeTickMiss,
            HitResult::SliderTailHit => HitResult::IgnoreMiss,
            _ => HitResult::Miss,
        }
    }

    /// hitresult.cs `[Order(n)]` -- the order results are displayed and,
    /// through `GetIndexForOrderedDisplay`, the order a score's statistics
    /// dictionary is written in
    pub fn display_order(self) -> u8 {
        match self {
            HitResult::Perfect => 0,
            HitResult::Great => 1,
            HitResult::Good => 2,
            HitResult::Ok => 3,
            HitResult::Meh => 4,
            HitResult::Miss => 5,
            HitResult::LargeTickHit => 6,
            HitResult::SmallTickHit => 7,
            HitResult::SliderTailHit => 8,
            HitResult::LargeBonus => 9,
            HitResult::SmallBonus => 10,
            HitResult::LargeTickMiss => 11,
            HitResult::SmallTickMiss => 12,
            HitResult::IgnoreHit => 13,
            HitResult::IgnoreMiss => 14,
            HitResult::ComboBreak => 16,
            HitResult::LegacyComboIncrease => 99,
        }
    }

    /// the snake-case spelling a score-info block keys its statistics by
    /// (`stringextensions.cs` `ToSnakeCase` over the enum name)
    pub fn snake_name(self) -> &'static str {
        match self {
            HitResult::Miss => "miss",
            HitResult::Meh => "meh",
            HitResult::Ok => "ok",
            HitResult::Good => "good",
            HitResult::Great => "great",
            HitResult::Perfect => "perfect",
            HitResult::SmallTickMiss => "small_tick_miss",
            HitResult::SmallTickHit => "small_tick_hit",
            HitResult::LargeTickMiss => "large_tick_miss",
            HitResult::LargeTickHit => "large_tick_hit",
            HitResult::SmallBonus => "small_bonus",
            HitResult::LargeBonus => "large_bonus",
            HitResult::IgnoreMiss => "ignore_miss",
            HitResult::IgnoreHit => "ignore_hit",
            HitResult::ComboBreak => "combo_break",
            HitResult::SliderTailHit => "slider_tail_hit",
            HitResult::LegacyComboIncrease => "legacy_combo_increase",
        }
    }

    pub fn from_snake_name(name: &str) -> Option<HitResult> {
        HitResult::ALL.iter().copied().find(|r| r.snake_name() == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ordinal_indexes_the_table() {
        for (i, result) in HitResult::ALL.iter().enumerate() {
            assert_eq!(result.ordinal(), i);
            assert_eq!(HitResult::from_snake_name(result.snake_name()), Some(*result));
        }
        assert_eq!(HitResult::from_snake_name("gr8"), None);
    }

    #[test]
    fn classification_follows_the_lazer_table() {
        assert!(HitResult::SliderTailHit.increases_combo());
        assert!(!HitResult::IgnoreMiss.breaks_combo());
        assert!(HitResult::LargeTickMiss.breaks_combo());
        assert!(!HitResult::SmallTickHit.affects_combo());
        assert!(HitResult::SmallBonus.is_scorable() && !HitResult::SmallBonus.affects_accuracy());
        assert!(!HitResult::IgnoreHit.is_scorable());
        assert!(HitResult::SliderTailHit.affects_accuracy() && HitResult::SliderTailHit.is_tick());
        assert!(HitResult::Great.is_basic() && !HitResult::LargeTickHit.is_basic());
        assert_eq!(HitResult::default_min_result(HitResult::SliderTailHit), HitResult::IgnoreMiss);
        assert_eq!(HitResult::default_min_result(HitResult::LargeTickHit), HitResult::LargeTickMiss);
        assert_eq!(HitResult::default_min_result(HitResult::Great), HitResult::Miss);
    }

    #[test]
    fn the_display_order_matches_a_real_statistics_block() {
        // the order lazer wrote fixtures/judgement/native-baseline.json's
        // statistics in
        let mut written = vec![
            HitResult::IgnoreMiss,
            HitResult::SmallBonus,
            HitResult::Great,
            HitResult::LargeTickHit,
            HitResult::Miss,
            HitResult::SliderTailHit,
            HitResult::Ok,
            HitResult::LargeBonus,
            HitResult::Meh,
            HitResult::IgnoreHit,
        ];
        written.sort_by_key(|r| r.display_order());
        assert_eq!(
            written,
            vec![
                HitResult::Great,
                HitResult::Ok,
                HitResult::Meh,
                HitResult::Miss,
                HitResult::LargeTickHit,
                HitResult::SliderTailHit,
                HitResult::LargeBonus,
                HitResult::SmallBonus,
                HitResult::IgnoreHit,
                HitResult::IgnoreMiss,
            ]
        );
    }
}
