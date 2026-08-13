//! stable's per-frame gameplay-button machinery: ports the condition
//! latching of danser-go's `OsuRuleSet.UpdateClickFor` (ruleset.go:371-414)
//! and the click-edge consumption rules its objects apply. danser pin and
//! semantics map: `.scratch/engine-parity-pass/stable-tracking-reference.md`
//! (danser-go @ 8331b0ff is the community-verified stable port; per
//! docs/adr/0001 stable end-values outrank the lazer source here)

use crate::replay::frames::Buttons;

/// the two gameplay actions as a bitmask -- danser's `Buttons` int64
/// (slider.go:11-14): left = 1, right = 2
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct ActionMask {
    pub raw: u8,
}

impl ActionMask {
    pub const NONE: ActionMask = ActionMask { raw: 0 };
    pub const LEFT: ActionMask = ActionMask { raw: 1 };
    pub const RIGHT: ActionMask = ActionMask { raw: 2 };
    pub const BOTH: ActionMask = ActionMask { raw: 3 };

    pub fn intersects(self, other: ActionMask) -> bool {
        self.raw & other.raw != 0
    }
}

/// per-player input state threaded through every stable update. field names
/// follow danser's difficultyPlayer (ruleset.go:60-84) so the port stays
/// line-checkable against the reference
#[derive(Debug, Default)]
pub(crate) struct ButtonMachine {
    /// the latched previous-frame action state (danser `buttons`)
    held_left: bool,
    held_right: bool,
    /// any gameplay button down as of the latest state change
    pub game_down_state: bool,
    /// the action bits as of the latest state change
    pub mouse_down_button: ActionMask,
    /// the previous two mouse_down_button values, oldest last -- the swap
    /// detection in the slider acceptance machine reads both
    pub last_button: ActionMask,
    pub last_button2: ActionMask,
    /// newly down this frame (danser leftCond/rightCond)
    pub left_cond: bool,
    pub right_cond: bool,
    /// the consumable click edges (danser leftCondE/rightCondE); objects
    /// consume them during the click walk
    pub left_cond_e: bool,
    pub right_cond_e: bool,
}

impl ButtonMachine {
    /// ruleset.go:376-399 + 410-413 -- run once per replay frame, before the
    /// click walk. danser latches `buttons` after its object loop, but
    /// nothing in that loop reads the latch, so folding it in here is
    /// observationally identical
    pub fn update(&mut self, buttons: Buttons) {
        let left = buttons.left();
        let right = buttons.right();
        self.left_cond = !self.held_left && left;
        self.right_cond = !self.held_right && right;
        self.left_cond_e = self.left_cond;
        self.right_cond_e = self.right_cond;
        if self.held_left != left || self.held_right != right {
            self.game_down_state = left || right;
            self.last_button2 = self.last_button;
            self.last_button = self.mouse_down_button;
            let mut mask = ActionMask::NONE;
            if left {
                mask.raw |= ActionMask::LEFT.raw;
            }
            if right {
                mask.raw |= ActionMask::RIGHT.raw;
            }
            self.mouse_down_button = mask;
        }
        self.held_left = left;
        self.held_right = right;
    }

    pub fn any_edge(&self) -> bool {
        self.left_cond_e || self.right_cond_e
    }

    /// circle.go:56-61 -- a landed click consumes one edge, left first
    pub fn consume_one_edge(&mut self) {
        if self.left_cond_e {
            self.left_cond_e = false;
        } else if self.right_cond_e {
            self.right_cond_e = false;
        }
    }

    /// circle.go:84-91 / slider.go:174-177 -- a shaken or ignored click
    /// consumes both edges at once
    pub fn consume_both_edges(&mut self) {
        self.left_cond_e = false;
        self.right_cond_e = false;
    }

    /// slider.go:137-143 / 251-259 / 492-498 -- the down-button latch used on
    /// head hit, head miss, and the acceptance machine's re-latch
    pub fn latch_down_button(&self) -> ActionMask {
        if self.left_cond {
            ActionMask::LEFT
        } else if self.right_cond {
            ActionMask::RIGHT
        } else {
            self.mouse_down_button
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::frames::Buttons;

    fn b(raw: u32) -> Buttons {
        Buttons::new(raw)
    }

    #[test]
    fn edges_fire_on_newly_down_only() {
        let mut m = ButtonMachine::default();
        m.update(b(Buttons::LEFT_1));
        assert!(m.left_cond_e && !m.right_cond_e);
        m.update(b(Buttons::LEFT_1)); // held, no new edge
        assert!(!m.left_cond_e);
        m.update(b(Buttons::LEFT_1 | Buttons::RIGHT_1));
        assert!(!m.left_cond_e && m.right_cond_e);
    }

    #[test]
    fn k_bit_joining_a_held_m_bit_is_not_a_new_edge() {
        // left1|left2 is still one gameplay action (legacyreplayframe.cs)
        let mut m = ButtonMachine::default();
        m.update(b(Buttons::LEFT_1));
        m.update(b(Buttons::LEFT_1 | Buttons::LEFT_2));
        assert!(!m.left_cond_e);
    }

    #[test]
    fn state_change_shifts_the_button_history() {
        let mut m = ButtonMachine::default();
        m.update(b(Buttons::LEFT_1));
        assert_eq!(m.mouse_down_button, ActionMask::LEFT);
        assert!(m.game_down_state);
        m.update(b(Buttons::LEFT_1 | Buttons::RIGHT_1));
        assert_eq!(m.mouse_down_button, ActionMask::BOTH);
        assert_eq!(m.last_button, ActionMask::LEFT);
        m.update(b(Buttons::RIGHT_1));
        assert_eq!(m.mouse_down_button, ActionMask::RIGHT);
        assert_eq!(m.last_button, ActionMask::BOTH);
        assert_eq!(m.last_button2, ActionMask::LEFT);
        m.update(b(0));
        assert!(!m.game_down_state);
        assert_eq!(m.mouse_down_button, ActionMask::NONE);
    }

    #[test]
    fn unchanged_state_leaves_the_history_alone() {
        let mut m = ButtonMachine::default();
        m.update(b(Buttons::LEFT_1));
        m.update(b(Buttons::LEFT_1));
        assert_eq!(m.last_button, ActionMask::NONE);
        assert_eq!(m.mouse_down_button, ActionMask::LEFT);
    }

    #[test]
    fn edge_consumption_is_left_first_then_right() {
        let mut m = ButtonMachine::default();
        m.update(b(Buttons::LEFT_1 | Buttons::RIGHT_1));
        assert!(m.any_edge());
        m.consume_one_edge();
        assert!(!m.left_cond_e && m.right_cond_e);
        m.consume_one_edge();
        assert!(!m.any_edge());
    }

    #[test]
    fn latch_prefers_the_fresh_edge_over_the_held_mask() {
        let mut m = ButtonMachine::default();
        m.update(b(Buttons::RIGHT_1));
        m.update(b(Buttons::LEFT_1 | Buttons::RIGHT_1));
        // left newly down this frame wins the latch
        assert_eq!(m.latch_down_button(), ActionMask::LEFT);
        m.update(b(Buttons::LEFT_1 | Buttons::RIGHT_1));
        // no fresh edge: the held mask is the latch
        assert_eq!(m.latch_down_button(), ActionMask::BOTH);
    }
}
