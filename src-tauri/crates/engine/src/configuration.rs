//! the play configuration: what one loaded replay IS, resolved once per
//! load and handed to every simulation, derivation, history step and export
//! route. which rules profile the play was scored under, which mods with
//! which settings, where that knowledge came from, the playback rate, and
//! what the app can therefore do with the play -- simulate it, edit its
//! frames, regenerate its export -- each allowed or refused with a reason
//! authored here and nowhere else, so the two gates (the command layer's
//! and the frontend's) are one decision read twice.
//!
//! # resolution
//!
//! the profile is selected by the header version and never by the mods: a
//! version below [`FIRST_LAZER_VERSION`] was scored by stable and simulates
//! under the stable profile, one at or above it was scored by lazer under
//! lazer's own rules. lazer itself appends Classic to a pre-lazer file and
//! simulates it under its own machinery (legacyscoredecoder.cs:91-92), but
//! this crate's stable profile is a port of stable, so a stable-written
//! play stays there.
//!
//! the mods come from the score-info block when the file carries a readable
//! one; from the legacy bitfield when the block is absent or empty, which is
//! exactly what lazer's own reader does (legacyscoredecoder.cs:88 reads the
//! bitfield first and :134 overwrites it only when a block deserialises),
//! recorded as inferred; and are unresolvable when the block is framed but
//! unreadable. a pre-lazer file's mods are the bitfield's, there being
//! nowhere else for them to live.
//!
//! the supported matrix has one row: no mods. an effective mod list that is
//! empty is supported; anything else is refused naming every acronym in it,
//! an unknown acronym included -- a mod this crate has never heard of is
//! never silently NoMod. settings do not enter the matrix until a mod with
//! settings does.
//!
//! # capabilities
//!
//! simulation is authoritative when the play's own profile is implemented
//! for its configuration, approximate when a timeline can be computed under
//! another implemented profile (every surface that displays a timeline may
//! read it; nothing that must be exact may), and refused otherwise. frame
//! editing and regenerating export are allowed exactly when simulation is
//! authoritative. a lazer-native NoMod play resolves to authoritative under
//! the native profile now that its walk has landed ([`IMPLEMENTED_PROFILES`]
//! flipped with it); the approximate branch stays a durable state of the
//! resolver for a future play the app can only simulate under a
//! neighbouring profile, pinned by resolving with the walk unimplemented

use serde::Serialize;

use crate::formats::osr::{OsrFile, ScoreInfoBlock, FIRST_LAZER_VERSION};
use crate::formats::score_info::ScoreInfoMod;
use crate::mods::LegacyMods;

/// the rule set a play was scored under and is simulated under
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RulesProfile {
    /// osu!(stable)'s own rules, ported from danser's stable path: the
    /// legacy hit policy, the aggregate slider judgement, scorev1
    Stable,
    /// lazer's rules: the start-time-ordered hit policy, graded slider
    /// heads, the slider tail as its own result, standardised scoring
    Native,
}

/// where the effective mods came from
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ModProvenance {
    /// a pre-lazer file: the legacy bitfield is the only record
    Bitfield,
    /// a lazer file with a readable score-info block
    Block,
    /// a lazer file whose block is absent or empty: the bitfield, as
    /// lazer's own reader falls back to it
    InferredFromBitfield,
    /// a lazer file whose block is framed but unreadable: nothing can say
    /// what the play was configured with
    Unresolvable,
}

/// why a play is not simulated at all
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RefusalReason {
    /// every effective acronym outside the supported matrix, in the order
    /// the file named them
    UnsupportedMods { acronyms: Vec<String> },
    /// the loaded beatmap is not the one the replay was played on, so any
    /// timeline would be fiction
    BeatmapMismatch,
    /// the score-info block could not be read, with the reader's reason
    UnreadableScoreInfo { reason: String },
}

/// whether and how the play can be simulated
#[derive(Debug, Clone, PartialEq)]
pub enum SimulationSupport {
    /// under the play's own profile, with a supported configuration
    Authoritative { profile: RulesProfile },
    /// under another profile than the play's: every surface that displays
    /// a timeline may read it, nothing that must be exact may
    Approximate { profile: RulesProfile },
    Refused { reason: RefusalReason },
}

/// one thing the app may or may not do with the play
#[derive(Debug, Clone, PartialEq)]
pub enum Capability {
    Allowed,
    Refused { reason: String },
}

impl Capability {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Capability::Allowed)
    }

    /// the stated reason, or none when allowed
    pub fn refusal(&self) -> Option<&str> {
        match self {
            Capability::Allowed => None,
            Capability::Refused { reason } => Some(reason),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Capabilities {
    pub simulate: SimulationSupport,
    pub edit_frames: Capability,
    pub regenerate_export: Capability,
}

/// the engine-owned value the whole load pipeline carries; see the module doc
#[derive(Debug, Clone, PartialEq)]
pub struct PlayConfiguration {
    pub profile: RulesProfile,
    /// the effective mods with their settings, in the order the file named
    /// them: the block's own entries, or the bitfield's acronyms in the
    /// order lazer's converter yields them
    pub mods: Vec<ScoreInfoMod>,
    pub provenance: ModProvenance,
    /// the playback rate the frames and objects share. a rate-changing mod
    /// is outside the supported matrix, so this is 1 for every simulated
    /// play; it is carried so the seam a rate mod plugs into already exists
    pub rate: f64,
    pub capabilities: Capabilities,
}

/// which profiles the simulator implements. the stable profile always is;
/// the native one flipped here, and nowhere else, when its walk landed
/// (`simulation::native`)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImplementedProfiles {
    pub native: bool,
}

/// the profiles this build simulates
pub const IMPLEMENTED_PROFILES: ImplementedProfiles = ImplementedProfiles { native: true };

/// resolves the configuration for a decoded file, with `beatmap_mismatch`
/// saying whether the loaded beatmap is a consented substitute for the one
/// the replay names (which refuses simulation outright: the geometry may be
/// wrong, so even a NoMod timeline would be fiction)
pub fn resolve_play_configuration(file: &OsrFile, beatmap_mismatch: bool) -> PlayConfiguration {
    resolve_with(file, beatmap_mismatch, IMPLEMENTED_PROFILES)
}

/// the resolver with the implemented set injected, so the approximate
/// branch stays reachable in a test after the native walk has landed
pub fn resolve_with(file: &OsrFile, beatmap_mismatch: bool, implemented: ImplementedProfiles) -> PlayConfiguration {
    let profile = if file.header.version >= FIRST_LAZER_VERSION {
        RulesProfile::Native
    } else {
        RulesProfile::Stable
    };
    let bitfield_mods = || {
        legacy_mod_acronyms(file.header.mods)
            .into_iter()
            .map(|acronym| ScoreInfoMod {
                acronym,
                settings: Vec::new(),
            })
            .collect::<Vec<_>>()
    };
    let (mods, provenance, unreadable) = match (profile, &file.trailer.block) {
        (RulesProfile::Stable, _) => (bitfield_mods(), ModProvenance::Bitfield, None),
        (RulesProfile::Native, ScoreInfoBlock::Present { value, .. }) => {
            (value.mods.clone(), ModProvenance::Block, None)
        }
        (RulesProfile::Native, ScoreInfoBlock::Malformed { reason, .. }) => {
            (Vec::new(), ModProvenance::Unresolvable, Some(reason.clone()))
        }
        (RulesProfile::Native, _) => (bitfield_mods(), ModProvenance::InferredFromBitfield, None),
    };

    let simulate = if beatmap_mismatch {
        SimulationSupport::Refused {
            reason: RefusalReason::BeatmapMismatch,
        }
    } else if let Some(reason) = unreadable {
        SimulationSupport::Refused {
            reason: RefusalReason::UnreadableScoreInfo { reason },
        }
    } else if !mods.is_empty() {
        SimulationSupport::Refused {
            reason: RefusalReason::UnsupportedMods {
                acronyms: mods.iter().map(|m| m.acronym.clone()).collect(),
            },
        }
    } else {
        match profile {
            RulesProfile::Stable => SimulationSupport::Authoritative {
                profile: RulesProfile::Stable,
            },
            RulesProfile::Native if implemented.native => SimulationSupport::Authoritative {
                profile: RulesProfile::Native,
            },
            RulesProfile::Native => SimulationSupport::Approximate {
                profile: RulesProfile::Stable,
            },
        }
    };

    let exact = match &simulate {
        SimulationSupport::Authoritative { .. } => Capability::Allowed,
        SimulationSupport::Approximate { profile: ran_under } => Capability::Refused {
            reason: format!(
                "this lazer-native play is simulated under the {} profile as an approximation, so frame edits \
                 and a regenerating export would re-derive it under the wrong rules; metadata editing stays \
                 available",
                profile_name(*ran_under)
            ),
        },
        SimulationSupport::Refused { reason } => Capability::Refused {
            reason: match reason {
                RefusalReason::UnsupportedMods { acronyms } => format!(
                    "mods not simulated ({}), so frame edits cannot re-derive the results; metadata editing \
                     stays available",
                    acronyms.join(" ")
                ),
                RefusalReason::BeatmapMismatch => "the loaded beatmap does not match the replay, so frame \
                                                   edits cannot re-derive the results; metadata editing stays \
                                                   available"
                    .into(),
                RefusalReason::UnreadableScoreInfo { reason } => format!(
                    "the replay's score-info block could not be read ({reason}), so its mods cannot be \
                     resolved and frame edits cannot re-derive the results; metadata editing stays available"
                ),
            },
        },
    };

    PlayConfiguration {
        profile,
        mods,
        provenance,
        rate: 1.0,
        capabilities: Capabilities {
            simulate,
            edit_frames: exact.clone(),
            regenerate_export: exact,
        },
    }
}

fn profile_name(profile: RulesProfile) -> &'static str {
    match profile {
        RulesProfile::Stable => "stable",
        RulesProfile::Native => "native",
    }
}

/// the acronyms the osu! ruleset's converter yields for a legacy bitfield,
/// in its order (osuruleset.cs:77-129), followed by every set bit it
/// ignores spelled as a hex flag -- the key mods, fade-in, random and
/// mirror are other rulesets' and lazer drops them for osu!, but this
/// crate's matrix is strict about any set bit, so none goes unnamed
pub fn legacy_mod_acronyms(bits: u32) -> Vec<String> {
    let mods = LegacyMods { raw: bits };
    // (flag, acronym, the flag it subsumes): nightcore implies doubletime,
    // perfect implies sudden death, cinema implies autoplay, and the
    // converter yields only the stronger of each pair
    const TABLE: [(u32, &str, u32); 16] = [
        (LegacyMods::NIGHTCORE, "NC", LegacyMods::DOUBLE_TIME),
        (LegacyMods::DOUBLE_TIME, "DT", 0),
        (LegacyMods::PERFECT, "PF", LegacyMods::SUDDEN_DEATH),
        (LegacyMods::SUDDEN_DEATH, "SD", 0),
        (LegacyMods::AUTOPILOT, "AP", 0),
        (LegacyMods::CINEMA, "CN", LegacyMods::AUTOPLAY),
        (LegacyMods::AUTOPLAY, "AT", 0),
        (LegacyMods::EASY, "EZ", 0),
        (LegacyMods::FLASHLIGHT, "FL", 0),
        (LegacyMods::HALF_TIME, "HT", 0),
        (LegacyMods::HARD_ROCK, "HR", 0),
        (LegacyMods::HIDDEN, "HD", 0),
        (LegacyMods::NO_FAIL, "NF", 0),
        (LegacyMods::RELAX, "RX", 0),
        (LegacyMods::SPUN_OUT, "SO", 0),
        (LegacyMods::TARGET, "TP", 0),
    ];
    let mut out: Vec<String> = Vec::new();
    let mut named = 0u32;
    for (flag, acronym, subsumes) in TABLE {
        // a subsumed flag is spoken for by its stronger partner
        if named & flag != 0 {
            continue;
        }
        if mods.contains(flag) {
            out.push(acronym.to_string());
            named |= flag | subsumes;
        }
    }
    for (flag, acronym) in [(LegacyMods::TOUCH_DEVICE, "TD"), (LegacyMods::SCORE_V2, "SV2")] {
        if mods.contains(flag) {
            out.push(acronym.to_string());
            named |= flag;
        }
    }
    let unnamed = bits & !named;
    for bit in 0..32 {
        let flag = 1u32 << bit;
        if unnamed & flag != 0 {
            out.push(format!("0x{flag:x}"));
        }
    }
    out
}

impl PlayConfiguration {
    /// a NoMod play under `profile`, authoritative by fiat: the
    /// configuration a scenario replay that never had a header runs under,
    /// and what a test drives a specific walk with
    pub fn nomod(profile: RulesProfile) -> PlayConfiguration {
        PlayConfiguration {
            profile,
            mods: Vec::new(),
            provenance: ModProvenance::Bitfield,
            rate: 1.0,
            capabilities: Capabilities {
                simulate: SimulationSupport::Authoritative { profile },
                edit_frames: Capability::Allowed,
                regenerate_export: Capability::Allowed,
            },
        }
    }

    /// the profile a timeline is computed under, when one is
    pub fn simulated_profile(&self) -> Option<RulesProfile> {
        match &self.capabilities.simulate {
            SimulationSupport::Authoritative { profile } | SimulationSupport::Approximate { profile } => {
                Some(*profile)
            }
            SimulationSupport::Refused { .. } => None,
        }
    }

    /// whether a timeline exists to display, authoritative or approximate
    pub fn has_timeline(&self) -> bool {
        self.simulated_profile().is_some()
    }

    pub fn is_authoritative(&self) -> bool {
        matches!(self.capabilities.simulate, SimulationSupport::Authoritative { .. })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::formats::osr::{OsrHeader, OsrTrailer};
    use crate::formats::score_info::{encode_score_info, ScoreInfo, StatisticEntry};
    use crate::formats::GameMode;

    fn file(version: u32, mods: u32, trailer: OsrTrailer) -> OsrFile {
        OsrFile {
            header: OsrHeader {
                mode: GameMode::Osu,
                version,
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
                mods,
                life_graph: None,
                timestamp_ticks: 0,
                online_score_id: 0,
            },
            actions: Vec::new(),
            compressed_payload: Vec::new(),
            decompressed_payload: Vec::new(),
            trailer,
        }
    }

    fn block(mods: &[(&str, Vec<(&str, i64)>)]) -> OsrTrailer {
        let info = ScoreInfo {
            online_id: -1,
            mods: mods
                .iter()
                .map(|(acronym, settings)| ScoreInfoMod {
                    acronym: acronym.to_string(),
                    settings: settings
                        .iter()
                        .map(|(k, v)| (k.to_string(), serde_json::from_str(&v.to_string()).unwrap()))
                        .collect(),
                })
                .collect(),
            statistics: vec![StatisticEntry {
                result: "great".into(),
                count: 1,
            }],
            maximum_statistics: Vec::new(),
            client_version: "test".into(),
            rank: None,
            user_id: -1,
            total_score_without_mods: None,
            pauses: Vec::new(),
            unknown: Vec::new(),
        };
        OsrTrailer::present(encode_score_info(&info).unwrap(), info)
    }

    fn unsupported(config: &PlayConfiguration) -> Vec<String> {
        match &config.capabilities.simulate {
            SimulationSupport::Refused {
                reason: RefusalReason::UnsupportedMods { acronyms },
            } => acronyms.clone(),
            other => panic!("expected an unsupported-mods refusal, got {other:?}"),
        }
    }

    #[test]
    fn a_pre_lazer_nomod_play_is_authoritative_under_stable() {
        let config = resolve_play_configuration(&file(20240101, 0, OsrTrailer::none()), false);
        assert_eq!(config.profile, RulesProfile::Stable);
        assert!(config.mods.is_empty());
        assert_eq!(config.provenance, ModProvenance::Bitfield);
        assert_eq!(config.rate, 1.0);
        assert_eq!(
            config.capabilities.simulate,
            SimulationSupport::Authoritative {
                profile: RulesProfile::Stable
            }
        );
        assert!(config.capabilities.edit_frames.is_allowed());
        assert!(config.capabilities.regenerate_export.is_allowed());
        assert!(config.is_authoritative() && config.has_timeline());
    }

    #[test]
    fn a_pre_lazer_play_with_mod_bits_is_refused_naming_them() {
        let bits = LegacyMods::HIDDEN | LegacyMods::DOUBLE_TIME;
        let config = resolve_play_configuration(&file(20240101, bits, OsrTrailer::none()), false);
        assert_eq!(unsupported(&config), vec!["DT", "HD"]);
        assert_eq!(config.provenance, ModProvenance::Bitfield);
        assert!(!config.has_timeline());
        let reason = config.capabilities.edit_frames.refusal().unwrap();
        assert!(reason.contains("DT HD"), "{reason}");
        assert_eq!(config.capabilities.edit_frames, config.capabilities.regenerate_export);
    }

    #[test]
    fn a_lazer_nomod_play_with_a_block_is_authoritative_under_native() {
        let config = resolve_play_configuration(&file(30000016, 0, block(&[])), false);
        assert_eq!(config.profile, RulesProfile::Native);
        assert_eq!(config.provenance, ModProvenance::Block);
        assert_eq!(
            config.capabilities.simulate,
            SimulationSupport::Authoritative {
                profile: RulesProfile::Native
            }
        );
        assert_eq!(config.simulated_profile(), Some(RulesProfile::Native));
        assert!(config.has_timeline() && config.is_authoritative());
        assert!(config.capabilities.edit_frames.is_allowed());
        assert!(config.capabilities.regenerate_export.is_allowed());
    }

    /// the approximate branch is a durable state of the resolver even
    /// though no shipping configuration reaches it: with the native walk
    /// unimplemented the same play runs under stable as an approximation,
    /// with both gates refused for the profile reason
    #[test]
    fn the_approximate_branch_stays_pinned_with_the_native_walk_unimplemented() {
        let staged = resolve_with(&file(30000016, 0, block(&[])), false, ImplementedProfiles { native: false });
        assert_eq!(
            staged.capabilities.simulate,
            SimulationSupport::Approximate {
                profile: RulesProfile::Stable
            }
        );
        assert_eq!(staged.simulated_profile(), Some(RulesProfile::Stable));
        assert!(staged.has_timeline() && !staged.is_authoritative());
        let reason = staged.capabilities.edit_frames.refusal().unwrap();
        assert!(reason.contains("lazer-native") && reason.contains("stable profile"), "{reason}");
        assert_eq!(staged.capabilities.regenerate_export.refusal(), Some(reason));
        let shipping = resolve_play_configuration(&file(30000016, 0, block(&[])), false);
        assert_eq!(
            (staged.profile, staged.provenance, &staged.mods),
            (shipping.profile, shipping.provenance, &shipping.mods),
            "nothing but the support and the gates differs between the two"
        );
    }

    #[test]
    fn a_lazer_only_mod_in_the_block_is_refused_by_acronym_settings_carried() {
        let config = resolve_play_configuration(
            &file(30000016, 0, block(&[("DA", vec![("circle_size", 7)]), ("HD", vec![])])),
            false,
        );
        assert_eq!(unsupported(&config), vec!["DA", "HD"]);
        assert_eq!(config.mods[0].settings[0].0, "circle_size");
        assert_eq!(config.provenance, ModProvenance::Block);
    }

    #[test]
    fn an_unknown_acronym_is_refused_by_name_never_silently_nomod() {
        let config = resolve_play_configuration(&file(30000016, 0, block(&[("ZZ", vec![])])), false);
        assert_eq!(unsupported(&config), vec!["ZZ"]);
    }

    #[test]
    fn an_absent_or_empty_block_falls_back_to_the_bitfield_as_inferred() {
        for trailer in [OsrTrailer::absent(), OsrTrailer::empty_block()] {
            let config = resolve_play_configuration(&file(30000016, 0, trailer.clone()), false);
            assert!(config.mods.is_empty());
            assert_eq!(config.provenance, ModProvenance::InferredFromBitfield);
            assert!(config.has_timeline(), "{trailer:?}");

            let with_bits = resolve_play_configuration(&file(30000016, LegacyMods::HARD_ROCK, trailer), false);
            assert_eq!(unsupported(&with_bits), vec!["HR"]);
            assert_eq!(with_bits.provenance, ModProvenance::InferredFromBitfield);
        }
    }

    #[test]
    fn a_malformed_block_refuses_as_unreadable_with_the_readers_reason() {
        let trailer = OsrTrailer {
            block: ScoreInfoBlock::Malformed {
                raw: vec![1, 2, 3],
                reason: "score-info block is not lzma".into(),
            },
            trailing: Vec::new(),
        };
        let config = resolve_play_configuration(&file(30000016, 0, trailer), false);
        assert_eq!(config.provenance, ModProvenance::Unresolvable);
        assert_eq!(
            config.capabilities.simulate,
            SimulationSupport::Refused {
                reason: RefusalReason::UnreadableScoreInfo {
                    reason: "score-info block is not lzma".into()
                }
            }
        );
        assert!(config
            .capabilities
            .edit_frames
            .refusal()
            .unwrap()
            .contains("not lzma"));
    }

    #[test]
    fn a_beatmap_mismatch_refuses_before_anything_else_is_consulted() {
        let config = resolve_play_configuration(&file(20240101, 0, OsrTrailer::none()), true);
        assert_eq!(
            config.capabilities.simulate,
            SimulationSupport::Refused {
                reason: RefusalReason::BeatmapMismatch
            }
        );
        // even a lazer file whose block would name mods: the mismatch wins
        let config = resolve_play_configuration(&file(30000016, 0, block(&[("HD", vec![])])), true);
        assert_eq!(
            config.capabilities.simulate,
            SimulationSupport::Refused {
                reason: RefusalReason::BeatmapMismatch
            }
        );
        assert_eq!(config.mods.len(), 1, "the mods are still resolved for display");
    }

    #[test]
    fn legacy_bits_name_lazers_acronyms_in_its_order_and_leave_no_bit_unnamed() {
        assert!(legacy_mod_acronyms(0).is_empty());
        // nightcore subsumes doubletime, perfect subsumes sudden death
        assert_eq!(
            legacy_mod_acronyms(LegacyMods::NIGHTCORE | LegacyMods::DOUBLE_TIME | LegacyMods::PERFECT | LegacyMods::SUDDEN_DEATH),
            vec!["NC", "PF"]
        );
        assert_eq!(
            legacy_mod_acronyms(LegacyMods::HARD_ROCK | LegacyMods::HIDDEN | LegacyMods::FLASHLIGHT),
            vec!["FL", "HR", "HD"]
        );
        // a bit lazer's converter ignores for osu! is still named, as a flag
        assert_eq!(legacy_mod_acronyms(1 << 30), vec!["0x40000000"]);
        assert_eq!(legacy_mod_acronyms(LegacyMods::SCORE_V2 | (1 << 15)), vec!["SV2", "0x8000"]);
    }

    #[test]
    fn the_nomod_constructor_is_authoritative_under_its_profile() {
        let native = PlayConfiguration::nomod(RulesProfile::Native);
        assert_eq!(native.simulated_profile(), Some(RulesProfile::Native));
        assert!(native.is_authoritative());
        assert_eq!(PlayConfiguration::nomod(RulesProfile::Stable).simulated_profile(), Some(RulesProfile::Stable));
    }
}
