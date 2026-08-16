//! hit sample lookups: what an object sounds like, never where that sound
//! lives on disk. ports `osu.game/audio/hitsampleinfo.cs` plus the two legacy
//! subclasses in `osu.game/rulesets/objects/legacy/converthitobjectparser.cs`
//! (`LegacyHitSampleInfo`, `FileHitSampleInfo`).
//!
//! this is lazer's `ISampleInfo` -> `ISkin.GetSample(ISampleInfo)` seam, and
//! keeping it is what makes the frontend's skin substitutable: the engine
//! resolves a sample down to (bank, name, suffix, volume) and stops there,
//! and whichever source answers the resulting lookup names owns the file.
//! nothing in this module knows a filesystem path, an extension, or a skin.

use std::fmt;

/// the sample banks a `.osu` file can name. `None` is the file's literal `0`
/// -- "inherit" -- and reaches a resolved sample only by way of a sample
/// control point that itself declares it (`[General] SampleSet: None` folds
/// into every point that does not override it)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum SampleBank {
    #[default]
    None,
    Normal,
    Soft,
    Drum,
}

impl SampleBank {
    /// hitsampleinfo.cs:23-25 -- the strings the lookup names are built from.
    /// `None` prints as `none`, which no shipped file is named after; that is
    /// the point, and the chain falling through to the bare `Gameplay/{name}`
    /// lookup is how such a sample still sounds
    pub const fn as_str(self) -> &'static str {
        match self {
            SampleBank::None => "none",
            SampleBank::Normal => "normal",
            SampleBank::Soft => "soft",
            SampleBank::Drum => "drum",
        }
    }
}

impl fmt::Display for SampleBank {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// what a sample is called. the five defaults are lazer's `HIT_*` constants
/// plus the `slidertick` name a slider's ticks take (`slider.cs:263`);
/// [`SampleName::File`] is the explicit filename an object's `hitSample`
/// field can name, which brings its own lookup names with it
/// (`converthitobjectparser.cs:693-697`)
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SampleName {
    Normal,
    Whistle,
    Finish,
    Clap,
    SliderTick,
    /// what a bonus spin sounds (`spinner.cs:94`)
    SpinnerBonus,
    File(String),
}

impl SampleName {
    /// the printed name; `None` for a file sample, whose name is the file
    pub fn as_str(&self) -> Option<&'static str> {
        match self {
            SampleName::Normal => Some("hitnormal"),
            SampleName::Whistle => Some("hitwhistle"),
            SampleName::Finish => Some("hitfinish"),
            SampleName::Clap => Some("hitclap"),
            SampleName::SliderTick => Some("slidertick"),
            SampleName::SpinnerBonus => Some("spinnerbonus"),
            SampleName::File(_) => None,
        }
    }
}

/// one resolved hit sample: lazer's `LegacyHitSampleInfo` after its sample
/// control point has been applied, minus the fields only an editor reads.
///
/// this is skin-independent by construction. two objects that resolve to the
/// same `(bank, name, suffix)` ask for the same sound at possibly different
/// volumes, which is exactly the identity the frontend's decode cache keys on
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HitSample {
    pub bank: SampleBank,
    pub name: SampleName,
    /// the custom sample bank index when it is >= 2, printed straight after
    /// the name (`normal-hitnormal3`). below 2 it is absent, which is what
    /// makes the suffixed lookup the *optional* first choice rather than a
    /// separate namespace
    pub suffix: Option<u32>,
    /// what the file and the sample control point declared, carried through
    /// unchanged. 0-100 in every legitimate map -- the editor's own control
    /// tops out there -- but NOT a guaranteed range: lazer lower-bounds a
    /// parsed volume at zero and stops (`converthitobjectparser.cs:232`,
    /// `Math.Max(0, ParseInt(...))`), so a crafted file can declare any
    /// `i32`. clamping it here would diverge from the decoder the fixtures
    /// are dumped from, so it is not clamped here: both the per-sample floor
    /// (`max(volume, 5)`) and the ceiling that keeps a crafted value off a
    /// gain node are playback rules, applied together where playback happens
    /// (`playback/hitsound-plan.ts`'s `sampleGain`)
    pub volume: i32,
    /// a `hitnormal` that plays UNDER its object's additions rather than
    /// instead of them: set when the object declares additions but not the
    /// normal bit (`converthitobjectparser.cs`, mirrored by rosu-map's own
    /// `is_layered`). `skin.ini`'s `LayeredHitSounds` can switch the
    /// behaviour off; until legacy skin parsing exists it reads as its
    /// default of on
    pub is_layered: bool,
}

impl HitSample {
    /// every filename that may source this sample, most preferred first.
    ///
    /// hitsampleinfo.cs:87-98 for the default names -- the suffixed form only
    /// when there is a suffix, then the banked form, then the bare one -- and
    /// converthitobjectparser.cs:693-697 for a file sample, which prepends
    /// the filename and its extension-stripped form before falling back to
    /// the same base list (built as a `hitnormal` on the normal bank, since
    /// `FileHitSampleInfo` constructs itself that way).
    ///
    /// these are lookup *names*, not paths: no extension is chosen here and
    /// no source is consulted. a source that holds several extensions for one
    /// name resolves that itself, exactly as osu-framework's sample store does
    pub fn lookup_names(&self) -> Vec<String> {
        let mut names = Vec::with_capacity(4);
        let printed = match &self.name {
            SampleName::File(filename) => {
                names.push(filename.clone());
                // path.changeextension(filename, null) -- the last dot and
                // everything after it, and only when the dot is in the file
                // name itself
                if let Some(stem) = strip_extension(filename) {
                    names.push(stem.to_string());
                }
                // the base list a FileHitSampleInfo falls back to is a plain
                // normal-bank hitnormal, never the object's own bank
                names.push("Gameplay/normal-hitnormal".to_string());
                names.push("Gameplay/hitnormal".to_string());
                return names;
            }
            other => other.as_str().expect("only File has no printed name"),
        };
        if let Some(suffix) = self.suffix {
            names.push(format!("Gameplay/{}-{printed}{suffix}", self.bank));
        }
        names.push(format!("Gameplay/{}-{printed}", self.bank));
        names.push(format!("Gameplay/{printed}"));
        names
    }
}

/// `Path.ChangeExtension(name, null)` for the shapes a `.osu` `hitSample`
/// field can hold: strips from the last `.` in the file name, and answers
/// `None` when there is nothing to strip (so the caller does not offer a
/// duplicate lookup name)
fn strip_extension(filename: &str) -> Option<&str> {
    let name_start = filename
        .rfind(['/', '\\'])
        .map_or(0, |sep| sep + 1);
    let dot = filename[name_start..].rfind('.')? + name_start;
    Some(&filename[..dot])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(bank: SampleBank, name: SampleName, suffix: Option<u32>) -> HitSample {
        HitSample {
            bank,
            name,
            suffix,
            volume: 100,
            is_layered: false,
        }
    }

    #[test]
    fn lookup_names_follow_hitsampleinfo_order() {
        let s = sample(SampleBank::Drum, SampleName::Whistle, None);
        assert_eq!(
            s.lookup_names(),
            vec!["Gameplay/drum-hitwhistle", "Gameplay/hitwhistle"]
        );
    }

    #[test]
    fn a_suffix_adds_a_preferred_first_name_rather_than_replacing_the_others() {
        // hitsampleinfo.cs:91-96 -- the suffixed name is yielded first and the
        // unsuffixed ones still follow, which is what makes a custom index
        // fall back to the plain bank file when the skin ships no `3`
        let s = sample(SampleBank::Soft, SampleName::Clap, Some(3));
        assert_eq!(
            s.lookup_names(),
            vec![
                "Gameplay/soft-hitclap3",
                "Gameplay/soft-hitclap",
                "Gameplay/hitclap"
            ]
        );
    }

    #[test]
    fn slider_ticks_are_an_ordinary_name_on_the_sliders_own_bank() {
        // slider.cs:263 -- the tick sample is the slider's own sample
        // `.With("slidertick")`, so a slider hitsounded onto drum ticks in drum
        let s = sample(SampleBank::Drum, SampleName::SliderTick, None);
        assert_eq!(
            s.lookup_names(),
            vec!["Gameplay/drum-slidertick", "Gameplay/slidertick"]
        );
    }

    #[test]
    fn file_samples_offer_the_filename_then_its_stem_then_the_plain_hitnormal() {
        // converthitobjectparser.cs:693-697. the base list is a normal-bank
        // hitnormal because FileHitSampleInfo constructs itself as one --
        // NOT the object's own bank
        let s = sample(SampleBank::Drum, SampleName::File("custom-hit.wav".into()), None);
        assert_eq!(
            s.lookup_names(),
            vec![
                "custom-hit.wav",
                "custom-hit",
                "Gameplay/normal-hitnormal",
                "Gameplay/hitnormal"
            ]
        );
    }

    #[test]
    fn an_extensionless_file_sample_offers_no_duplicate_stem() {
        let s = sample(SampleBank::Normal, SampleName::File("custom".into()), None);
        assert_eq!(
            s.lookup_names(),
            vec!["custom", "Gameplay/normal-hitnormal", "Gameplay/hitnormal"]
        );
    }

    #[test]
    fn a_dot_outside_the_file_name_is_not_an_extension() {
        // Path.ChangeExtension only looks at the file name; a dotted directory
        // must not have its tail treated as the extension
        assert_eq!(strip_extension("a.b/custom"), None);
        assert_eq!(strip_extension("a.b/custom.wav"), Some("a.b/custom"));
        assert_eq!(strip_extension("custom.wav"), Some("custom"));
        assert_eq!(strip_extension("custom"), None);
    }

    #[test]
    fn the_none_bank_prints_as_none_and_still_reaches_the_bare_lookup() {
        // a `SampleSet: None` map resolves to a bank no file is named after;
        // the third lookup name is what keeps such an object audible
        let s = sample(SampleBank::None, SampleName::Normal, None);
        assert_eq!(
            s.lookup_names(),
            vec!["Gameplay/none-hitnormal", "Gameplay/hitnormal"]
        );
    }
}
