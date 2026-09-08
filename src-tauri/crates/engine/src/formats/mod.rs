pub mod beatmap;
/// the byte-level reads the binary osu! formats share; internal to the
/// crate, since nothing outside it parses osu!'s framing by hand
pub(crate) mod binary;
pub mod local_scores;
pub mod osr;
pub mod samples;
pub mod skin_ini;
pub mod stable_listing;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameMode {
    Osu,
    Taiko,
    Catch,
    Mania,
}
