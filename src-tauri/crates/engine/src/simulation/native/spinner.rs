//! the native spinner: lazer's own spin accounting and grading, ported from
//! spinnerrotationtracker.cs (the angle sampled per update, the delta
//! normalised into (-180, 180], added only while tracking and inside the
//! spinnable window), spinnerspinhistory.cs (spin completion by the current
//! spin's maximum absolute rotation, so a reversal never subtracts), and
//! drawablespinner.cs (`CheckForResult` at 247-275: the grade from progress
//! at the end time with the unreached ticks missed first; `Update` at
//! 277-283: tracking while spinnable, unjudged and a gameplay button is
//! down; `updateBonusScore` at 335-365: one tick per completed spin in
//! nested order, small bonus up to the bonus threshold and large beyond).
//!
//! the mouse position the tracker turns into an angle is the one lazer's
//! input stack delivers: `SpinnerRotationTracker.OnMouseMove` fires on a
//! CHANGE of position while the spinner is alive, so the tracker knows no
//! position until the cursor first moves after the spinner appears, and
//! its first delta after that is zero (spinnerrotationtracker.cs:57-78).
//! unlike the slider's input manager it does not ask for high-frequency
//! positions, which is why a spinner parked under a still cursor accrues
//! nothing until the cursor moves

use crate::beatmap::ProcessedSpinner;
use crate::math::Vec2;
use crate::score::HitResult;
use crate::simulation::native::scoring::{spinner_tick_count, spinner_tick_maximum};
use crate::simulation::spinner::angle_at;

#[derive(Debug, Default)]
pub(crate) struct SpinnerRun {
    pub tracking: bool,
    mouse_position: Option<Vec2>,
    last_angle: Option<f32>,
    history: SpinHistory,
    completed_full_spins: u32,
    /// how many nested ticks have a result, hit or missed, in list order
    pub ticks_judged: u32,
    /// the total nested tick count, `spinner.cs:84`
    pub tick_count: u32,
}

/// spinnerspinhistory.cs, the forward branch only -- the walk never rewinds
#[derive(Debug, Default)]
struct SpinHistory {
    completed_spins: u32,
    total_accumulated: f32,
    total_at_last_completion: f32,
    current_spin_max: f32,
}

impl SpinHistory {
    /// spinnerspinhistory.cs:29 -- the scoring value: whole spins plus the
    /// current spin's maximum
    fn total_rotation(&self) -> f32 {
        360.0 * self.completed_spins as f32 + self.current_spin_max
    }

    fn current_spin_rotation(&self) -> f32 {
        self.total_accumulated - self.total_at_last_completion
    }

    /// spinnerspinhistory.cs:64-101
    fn report_delta(&mut self, delta: f32) {
        if delta == 0.0 {
            return;
        }
        self.total_accumulated += delta;
        self.current_spin_max = self.current_spin_max.max(self.current_spin_rotation().abs());
        while self.current_spin_max >= 360.0 {
            let direction = if self.current_spin_rotation() >= 0.0 {
                1.0
            } else {
                -1.0
            };
            self.completed_spins = self.completed_spins.saturating_add(1);
            self.total_at_last_completion += direction * 360.0;
            self.current_spin_max = self.current_spin_rotation().abs();
        }
    }
}

impl SpinnerRun {
    pub fn new(spinner: &ProcessedSpinner) -> SpinnerRun {
        SpinnerRun {
            tick_count: spinner_tick_count(spinner),
            ..SpinnerRun::default()
        }
    }

    /// spinnerrotationtracker.cs:57-61 -- the tracker learns the cursor's
    /// position from a mouse-move event, which fires on a change only
    pub fn on_mouse_move(&mut self, pos: Vec2) {
        self.mouse_position = Some(pos);
    }

    /// drawablespinner.cs:277-283 -- tracking is recomputed every update
    pub fn update_tracking(&mut self, spinnable: bool, judged: bool, any_button: bool) {
        self.tracking = spinnable && !judged && any_button;
    }

    /// spinnerrotationtracker.cs:63-78,89-107 -- one update's rotation
    pub fn update_rotation(&mut self, centre: Vec2, spinnable: bool) {
        let Some(pos) = self.mouse_position else {
            return;
        };
        let this_angle = angle_at(pos, centre);
        let mut delta = match self.last_angle {
            Some(last) => this_angle - last,
            None => 0.0,
        };
        if delta > 180.0 {
            delta -= 360.0;
        }
        if delta < -180.0 {
            delta += 360.0;
        }
        // addrotation: a no-op outside the spinnable window; the rate
        // factor is 1 under NoMod
        if self.tracking && spinnable {
            self.history.report_delta(delta);
        }
        self.last_angle = Some(this_angle);
    }

    /// drawablespinner.cs:236-245 -- clamped completion, 1 for a spinner too
    /// short to require a whole spin
    pub fn progress(&self, spinner: &ProcessedSpinner) -> f32 {
        if spinner.spins_required == 0 {
            return 1.0;
        }
        (self.history.total_rotation() / 360.0 / spinner.spins_required as f32).clamp(0.0, 1.0)
    }

    /// drawablespinner.cs:340-365 -- the ticks newly earned by this update's
    /// rotation, in nested order, each with its result. a spin past the last
    /// tick earns nothing (lazer plays a sound and moves on)
    pub fn award_spins(&mut self, spinner: &ProcessedSpinner) -> Vec<(u32, HitResult)> {
        let mut awarded = Vec::new();
        // c#'s (int) truncates toward zero; the rotation is never negative
        let spins = (self.history.total_rotation() / 360.0) as u32;
        while self.completed_full_spins < spins {
            if self.ticks_judged < self.tick_count {
                let index = self.ticks_judged;
                awarded.push((index, spinner_tick_maximum(spinner, index)));
                self.ticks_judged += 1;
            }
            self.completed_full_spins += 1;
        }
        awarded
    }

    /// drawablespinner.cs:256-258 -- the ticks never reached, each at its
    /// minimum result (ignore miss), judged at the end before the grade:
    /// the small-bonus ones and the large-bonus ones as two counted groups,
    /// since they differ in nothing but their maximum and their number is
    /// bounded by nothing but the spinner's duration
    pub fn miss_remaining_ticks(&mut self, spinner: &ProcessedSpinner) -> [(HitResult, u32); 2] {
        let small_total = u32::try_from(spinner.spins_required_for_bonus())
            .unwrap_or(0)
            .min(self.tick_count);
        let small = small_total.saturating_sub(self.ticks_judged);
        let large = self.tick_count.saturating_sub(self.ticks_judged.max(small_total));
        self.ticks_judged = self.tick_count;
        [(HitResult::SmallBonus, small), (HitResult::LargeBonus, large)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_reversal_never_subtracts_and_the_carry_over_survives_a_completion() {
        let mut history = SpinHistory::default();
        history.report_delta(90.0);
        history.report_delta(-90.0);
        assert_eq!(history.total_rotation(), 90.0, "spinning back keeps the maximum reached");
        history.report_delta(300.0);
        assert_eq!(history.completed_spins, 0);
        history.report_delta(100.0);
        assert_eq!(history.completed_spins, 1, "the current spin passed 360");
        assert_eq!(history.total_rotation(), 400.0, "the remainder past the completion carries over");
    }

    #[test]
    fn the_unreached_ticks_split_by_their_maximum_around_the_bonus_threshold() {
        let spinner = ProcessedSpinner {
            duration: 1000.0,
            spins_required: 4,
            max_bonus_spins: 3,
            stable_half_spins_required: 0,
            total_half_spins_possible: 0,
        };
        let mut run = SpinnerRun::new(&spinner);
        assert_eq!(run.tick_count, 9, "four required plus two small bonus, then three large");
        run.ticks_judged = 2;
        assert_eq!(
            run.miss_remaining_ticks(&spinner),
            [(HitResult::SmallBonus, 4), (HitResult::LargeBonus, 3)]
        );
        assert_eq!(run.ticks_judged, 9);
        assert_eq!(run.miss_remaining_ticks(&spinner), [(HitResult::SmallBonus, 0), (HitResult::LargeBonus, 0)]);
    }

    #[test]
    fn the_first_delta_after_the_cursor_is_known_is_zero() {
        let centre = Vec2::new(256.0, 192.0);
        let mut run = SpinnerRun::default();
        run.tracking = true;
        run.update_rotation(centre, true);
        assert_eq!(run.history.total_rotation(), 0.0, "no position yet, nothing accrues");
        run.on_mouse_move(Vec2::new(356.0, 192.0));
        run.update_rotation(centre, true);
        assert_eq!(run.history.total_rotation(), 0.0, "the first sample only seeds the angle");
        run.on_mouse_move(Vec2::new(256.0, 292.0));
        run.update_rotation(centre, true);
        assert!((run.history.total_rotation() - 90.0).abs() < 1e-3, "a quarter turn from the seed");
    }
}
