//! Command-line process adapter for the shared Notes runtime.

mod users;

use std::{
    collections::HashSet,
    ffi::OsString,
    net::Ipv4Addr,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use notes_core::{
    appearance::{Appearance, Theme},
    auth::UserStore,
    server::{self, AllowedHostname, RunningServer},
};

const HELP: &str = "Notes Core

notes-core --serve <folder> [--host <IPv4>] [--port <0..65535>]
  [--allow-host <hostname>]...
  [--ready-file <path>] [--stop-file <path>]
  [--auth-file <path>] [--auth-mode users|token]
  [--theme system|light|dark] [--latin-font <family>] [--cjk-font <family>]

The first browser visit creates the initial administrator.
Account maintenance:
  notes-core user list [--auth-file <path>]
  notes-core user add <name> [--role user|admin] [--password-stdin]
  notes-core user password <name> [--password-stdin]
  notes-core user remove <name>

Passwords are prompted securely unless --password-stdin is used.
The default host is 127.0.0.1. Use --host 0.0.0.0 for network access with user authentication.
Use --allow-host for each trusted DNS hostname (no scheme, port, or wildcard).
Token mode is retained for loopback-only diagnostics and automated tests.
Create the stop file or press Ctrl+C to stop.";

#[derive(Debug, Eq, PartialEq)]
enum AuthenticationMode {
    Users,
    LaunchToken,
}

#[derive(Debug, Eq, PartialEq)]
struct ServeOptions {
    folder: PathBuf,
    host: Ipv4Addr,
    allowed_hosts: Vec<AllowedHostname>,
    port: u16,
    ready_file: Option<PathBuf>,
    stop_file: Option<PathBuf>,
    auth_file: Option<PathBuf>,
    auth_mode: AuthenticationMode,
    appearance: Appearance,
}

impl ServeOptions {
    fn parse(args: &[OsString]) -> Result<Option<Self>, String> {
        if args.is_empty()
            || args.len() == 1
                && args[0]
                    .to_str()
                    .is_some_and(|argument| matches!(argument, "--help" | "-h"))
        {
            return Ok(None);
        }

        let mut folder = None;
        let mut host = Ipv4Addr::LOCALHOST;
        let mut allowed_hosts = Vec::new();
        let mut port = 8123;
        let mut ready_file = None;
        let mut stop_file = None;
        let mut auth_file = None;
        let mut auth_mode = AuthenticationMode::Users;
        let mut appearance = Appearance::default();
        let mut seen = HashSet::new();
        let mut index = 0;

        while index < args.len() {
            let key = args[index].to_str().ok_or("Invalid option encoding.")?;
            if !seen.insert(key) && key != "--allow-host" {
                return Err(format!("Option specified more than once: {key}"));
            }
            let value = args
                .get(index + 1)
                .ok_or("Option requires a value. Use --help.")?;
            match key {
                "--serve" => folder = Some(PathBuf::from(value)),
                "--host" => {
                    host = value
                        .to_str()
                        .ok_or("Invalid host.")?
                        .parse::<Ipv4Addr>()
                        .map_err(|_| "Host must be an IPv4 address.")?;
                }
                "--allow-host" => {
                    let host = value
                        .to_str()
                        .ok_or("Invalid allowed hostname encoding.")?
                        .parse()?;
                    if !allowed_hosts.contains(&host) {
                        allowed_hosts.push(host);
                    }
                }
                "--port" => {
                    port = value
                        .to_str()
                        .ok_or("Invalid port.")?
                        .parse::<u16>()
                        .map_err(|_| "Invalid port.")?;
                }
                "--ready-file" => ready_file = Some(PathBuf::from(value)),
                "--stop-file" => stop_file = Some(PathBuf::from(value)),
                "--auth-file" => auth_file = Some(PathBuf::from(value)),
                "--auth-mode" => {
                    auth_mode = match value.to_str() {
                        Some("users") => AuthenticationMode::Users,
                        Some("token") => AuthenticationMode::LaunchToken,
                        _ => return Err("Authentication mode must be users or token.".into()),
                    };
                }
                "--theme" => {
                    appearance.theme = match value.to_str() {
                        Some("system") => Theme::System,
                        Some("light") => Theme::Light,
                        Some("dark") => Theme::Dark,
                        _ => return Err("Theme must be system, light or dark.".into()),
                    };
                }
                "--latin-font" => {
                    appearance.latin_font = value.to_str().ok_or("Invalid font name.")?.into();
                }
                "--cjk-font" => {
                    appearance.cjk_font = value.to_str().ok_or("Invalid font name.")?.into();
                }
                _ => return Err(format!("Unknown option: {key}")),
            }
            index += 2;
        }

        appearance.validate()?;
        if auth_file.is_some() && auth_mode == AuthenticationMode::LaunchToken {
            return Err("--auth-file cannot be used with token authentication.".into());
        }
        if auth_mode == AuthenticationMode::LaunchToken && !host.is_loopback() {
            return Err("Token authentication is limited to loopback hosts. Use user authentication for network access.".into());
        }
        if auth_mode == AuthenticationMode::LaunchToken && !allowed_hosts.is_empty() {
            return Err("--allow-host requires user authentication.".into());
        }
        Ok(Some(Self {
            folder: folder.ok_or("Expected --serve <folder>. Use --help.")?,
            host,
            allowed_hosts,
            port,
            ready_file,
            stop_file,
            auth_file,
            auth_mode,
            appearance,
        }))
    }
}

pub fn run(args: &[OsString]) -> Result<(), String> {
    if args.first().and_then(|value| value.to_str()) == Some("user") {
        return users::run(&args[1..]);
    }
    let Some(options) = ServeOptions::parse(args)? else {
        println!("{HELP}");
        return Ok(());
    };

    let stopped = Arc::new(AtomicBool::new(false));
    let signal = stopped.clone();
    ctrlc::set_handler(move || signal.store(true, Ordering::Relaxed))
        .map_err(|error| format!("Could not register shutdown signals: {error}"))?;

    let mut server = match options.auth_mode {
        AuthenticationMode::Users => {
            let users = options
                .auth_file
                .map(UserStore::new)
                .map_or_else(UserStore::platform_default, Ok)?;
            server::start_with_users_on_hosts(
                &options.folder,
                options.host,
                options.port,
                users,
                &options.allowed_hosts,
            )?
        }
        AuthenticationMode::LaunchToken => {
            server::start_on(&options.folder, options.host, options.port)?
        }
    };
    server.set_appearance(options.appearance)?;
    publish_ready(
        &server,
        options.ready_file.as_deref(),
        &options.allowed_hosts,
    )?;
    wait_for_shutdown(&server, &stopped, options.stop_file.as_deref())?;
    server.stop()
}

fn publish_ready(
    server: &RunningServer,
    ready_file: Option<&Path>,
    allowed_hosts: &[AllowedHostname],
) -> Result<(), String> {
    let Some(path) = ready_file else {
        println!("{}", server.url());
        return Ok(());
    };

    use std::io::Write;

    let data = serde_json::json!({
        "url": server.url(),
        "port": server.port(),
        "host": server.host().to_string(),
        "allowedHosts": allowed_hosts.iter().map(AllowedHostname::as_str).collect::<Vec<_>>(),
        "root": server.root(),
        "pid": std::process::id(),
    });
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
        .map_err(|error| format!("Could not write the ready file: {error}"))
}

fn wait_for_shutdown(
    server: &RunningServer,
    stopped: &AtomicBool,
    stop_file: Option<&Path>,
) -> Result<(), String> {
    loop {
        if stopped.load(Ordering::Relaxed) {
            return Ok(());
        }
        if let Some(path) = stop_file {
            match path.try_exists() {
                Ok(true) => return Ok(()),
                Ok(false) => {}
                Err(error) => return Err(format!("Could not inspect the stop file: {error}")),
            }
        }
        if !server.is_running() {
            return Err("The notes service stopped unexpectedly.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn help_does_not_require_a_notes_folder() {
        assert_eq!(ServeOptions::parse(&[]).unwrap(), None);
        assert_eq!(ServeOptions::parse(&args(&["--help"])).unwrap(), None);
        assert_eq!(ServeOptions::parse(&args(&["-h"])).unwrap(), None);
    }

    #[test]
    fn parses_typed_serve_options_and_rejects_duplicates() {
        let options = ServeOptions::parse(&args(&[
            "--serve",
            "notes",
            "--port",
            "0",
            "--theme",
            "dark",
            "--latin-font",
            "Inter",
            "--cjk-font",
            "Noto Sans CJK SC",
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(options.folder, PathBuf::from("notes"));
        assert_eq!(options.port, 0);
        assert_eq!(options.host, Ipv4Addr::LOCALHOST);
        assert!(options.allowed_hosts.is_empty());
        assert_eq!(options.appearance.theme, Theme::Dark);
        assert_eq!(options.appearance.latin_font, "Inter");
        assert_eq!(options.appearance.cjk_font, "Noto Sans CJK SC");
        assert_eq!(options.auth_mode, AuthenticationMode::Users);
        assert!(
            ServeOptions::parse(&args(&["--serve", "a", "--serve", "b"]))
                .unwrap_err()
                .contains("more than once")
        );
    }

    #[test]
    fn network_binding_is_explicit_and_requires_user_authentication() {
        let options = ServeOptions::parse(&args(&["--serve", "notes", "--host", "0.0.0.0"]))
            .unwrap()
            .unwrap();
        assert_eq!(options.host, Ipv4Addr::UNSPECIFIED);
        for host in ["example.com", "::", "0.0.0.0:8123", "999.0.0.1"] {
            assert!(ServeOptions::parse(&args(&["--serve", "notes", "--host", host])).is_err());
        }
        assert!(
            ServeOptions::parse(&args(&[
                "--serve",
                "notes",
                "--host",
                "0.0.0.0",
                "--auth-mode",
                "token"
            ]))
            .is_err()
        );
    }

    #[test]
    fn allowed_hostnames_are_explicit_validated_and_repeatable() {
        let options = ServeOptions::parse(&args(&[
            "--serve",
            "notes",
            "--allow-host",
            "Notes.Example",
            "--allow-host",
            "other.example",
            "--allow-host",
            "notes.example",
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(
            options
                .allowed_hosts
                .iter()
                .map(AllowedHostname::as_str)
                .collect::<Vec<_>>(),
            ["notes.example", "other.example"]
        );
        for host in [
            "",
            "*",
            "*.example",
            "http://notes.example",
            "notes.example:8123",
            "notes.example/",
            "user@notes.example",
            "notes.example.",
            "-notes.example",
            "notes-.example",
            "notes..example",
            "notes_example",
            "notes example",
            "127.0.0.1",
            "::1",
            "笔记.example",
        ] {
            assert!(
                ServeOptions::parse(&args(&["--serve", "notes", "--allow-host", host])).is_err(),
                "{host}"
            );
        }
        for host in [
            format!("{}.example", "x".repeat(64)),
            "abc.".repeat(64) + "example",
        ] {
            assert!(
                ServeOptions::parse(&args(&["--serve", "notes", "--allow-host", &host])).is_err()
            );
        }
        assert!(
            ServeOptions::parse(&args(&[
                "--serve",
                "notes",
                "--auth-mode",
                "token",
                "--allow-host",
                "notes.example",
            ]))
            .is_err()
        );
    }
}
