// このファイルは lib.rs の run() を呼ぶだけ。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rustvideoedit_lib::run();
}
