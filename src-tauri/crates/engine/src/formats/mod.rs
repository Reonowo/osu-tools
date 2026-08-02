pub mod beatmap;
pub mod osr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameMode {
    Osu,
    Taiko,
    Catch,
    Mania,
}
