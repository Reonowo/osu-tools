pub mod beatmap;
pub mod osr;
pub mod samples;
pub mod skin_ini;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GameMode {
    Osu,
    Taiko,
    Catch,
    Mania,
}
