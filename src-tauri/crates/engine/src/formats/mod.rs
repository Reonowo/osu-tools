pub mod beatmap;
pub mod osr;
pub mod samples;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameMode {
    Osu,
    Taiko,
    Catch,
    Mania,
}
