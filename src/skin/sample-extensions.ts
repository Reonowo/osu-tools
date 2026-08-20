// the extensions a sample lookup tries, in the order a store tries them.
//
// mirrors `media.rs`'s `SAMPLE_EXTENSIONS`, which is where the beatmap's own
// files are resolved. it lives here rather than beside the sample sources
// because a SKIN's file map is a directory listing -- keyed with extensions --
// while the beatmap's arrives already keyed by lookup name, so this is the one
// place on the frontend that has to try extensions at all.
//
// `.wav` first is osu-framework's own preference and matters when a skin ships
// the same stem twice.
export const SAMPLE_EXTENSIONS = ["wav", "mp3", "ogg"] as const;
