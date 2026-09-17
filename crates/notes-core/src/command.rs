use std::{
    ffi::OsString,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use crate::{
    appearance::{Appearance, Theme},
    server,
};

/// Shared headless entry point used by the CLI and diagnostic wrapper modes.
pub fn run(args: &[OsString]) -> Result<(), String> {
    if args.is_empty() || args.len() == 1 && (args[0] == "--help" || args[0] == "-h") {
        println!(
            "Notes Core\n\nnotes-core --serve <folder> [--port <0..65535>]\n  [--ready-file <path>] [--stop-file <path>]\n  [--theme system|light|dark] [--latin-font <family>] [--cjk-font <family>]\n\nThis headless mode does not read or modify desktop settings.\nThe launch URL contains a private access token. Do not share it.\nCreate the stop file or press Ctrl+C to stop."
        );
        return Ok(());
    }
    let mut folder = None;
    let mut port = 8123;
    let mut ready = None;
    let mut stop = None;
    let mut appearance = Appearance::default();
    let mut seen = std::collections::HashSet::new();
    let mut index = 0;
    while index < args.len() {
        let key = args[index].to_str().ok_or("Invalid option encoding.")?;
        if !seen.insert(key) {
            return Err(format!("Option specified more than once: {key}"));
        }
        let value = args
            .get(index + 1)
            .ok_or("Option requires a value. Use --help.")?;
        match key {
            "--serve" => folder = Some(PathBuf::from(value)),
            "--port" => {
                port = value
                    .to_str()
                    .ok_or("Invalid port.")?
                    .parse::<u16>()
                    .map_err(|_| "Invalid port.")?
            }
            "--ready-file" => ready = Some(PathBuf::from(value)),
            "--stop-file" => stop = Some(PathBuf::from(value)),
            "--theme" => {
                appearance.theme = match value.to_str() {
                    Some("system") => Theme::System,
                    Some("light") => Theme::Light,
                    Some("dark") => Theme::Dark,
                    _ => return Err("Theme must be system, light or dark.".into()),
                }
            }
            "--latin-font" => {
                appearance.latin_font = value.to_str().ok_or("Invalid font name.")?.into()
            }
            "--cjk-font" => {
                appearance.cjk_font = value.to_str().ok_or("Invalid font name.")?.into()
            }
            _ => return Err(format!("Unknown option: {key}")),
        }
        index += 2;
    }
    let folder = folder.ok_or("Expected --serve <folder>. Use --help.")?;
    appearance.validate()?;
    let stopped = Arc::new(AtomicBool::new(false));
    let signal = stopped.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))
        .map_err(|error| format!("Could not register shutdown signals: {error}"))?;
    let mut server = server::start(&folder, port)?;
    server.set_appearance(appearance)?;
    if let Some(path) = ready {
        use std::io::Write;
        let data = serde_json::json!({"url":server.url(),"port":server.port(),"root":server.root(),"pid":std::process::id()});
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(path)
            .map_err(|error| format!("Could not create the ready file: {error}"))?;
        file.write_all(&serde_json::to_vec(&data).map_err(|error| error.to_string())?)
            .and_then(|_| file.sync_all())
            .map_err(|error| format!("Could not write the ready file: {error}"))?;
    } else {
        println!("{}", server.url());
    }
    loop {
        if stopped.load(Ordering::Relaxed) {
            break;
        }
        if let Some(path) = &stop {
            match path.try_exists() {
                Ok(true) => break,
                Ok(false) => {}
                Err(error) => return Err(format!("Could not inspect the stop file: {error}")),
            }
        }
        if !server.is_running() {
            return Err("The notes service stopped unexpectedly.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    server.stop()
}
