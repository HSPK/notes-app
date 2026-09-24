#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if !args.is_empty() {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::System::Console::AttachConsole(
                windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS,
            );
        }
        if let Err(error) = notes_cli::run(&args) {
            eprintln!("{error}");
            std::process::exit(1);
        }
    } else {
        #[cfg(windows)]
        notes_app_windows::native::run();
        #[cfg(not(windows))]
        {
            eprintln!("Use the notes-core CLI on this platform.");
            std::process::exit(1);
        }
    }
}
