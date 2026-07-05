//! ffmpeg / ffprobe 連携(DESIGN.md §2, §8)。

pub mod encode;
pub mod filtergraph;
pub mod locate;
pub mod probe;

use std::process::Command;

/// Windows で子プロセス起動時にコンソールウィンドウが一瞬表示されるのを防ぐフラグ。
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// ffprobe/ffmpeg/サムネイル生成、全ての子プロセス起動にこのヘルパーを通すこと。
pub fn no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}
