use std::{
    fs,
    io::Write,
    path::PathBuf,
    process::{Command, Stdio},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use notes_core::auth::UserStore;

#[test]
fn cli_reports_help_and_rejects_invalid_options() {
    let help = Command::new(env!("CARGO_BIN_EXE_notes-core"))
        .arg("--help")
        .output()
        .unwrap();
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("--serve"));
    assert!(String::from_utf8_lossy(&help.stdout).contains("--host"));
    assert!(String::from_utf8_lossy(&help.stdout).contains("--allow-host"));
    let invalid = Command::new(env!("CARGO_BIN_EXE_notes-core"))
        .args(["--serve", ".", "--port", "70000"])
        .output()
        .unwrap();
    assert!(!invalid.status.success());
    assert!(String::from_utf8_lossy(&invalid.stderr).contains("Invalid port"));
    let invalid_host = Command::new(env!("CARGO_BIN_EXE_notes-core"))
        .args(["--serve", ".", "--host", "example.com"])
        .output()
        .unwrap();
    assert!(!invalid_host.status.success());
    assert!(String::from_utf8_lossy(&invalid_host.stderr).contains("IPv4"));
}

#[test]
fn cli_starts_and_stops_without_loading_desktop_settings() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("cli-{stamp}"));
    fs::create_dir_all(base.join("notes")).unwrap();
    fs::write(base.join("notes").join("note.md"), "# Shared core\n").unwrap();
    let ready = base.join("ready.json");
    let stop = base.join("stop");
    let mut child = Command::new(env!("CARGO_BIN_EXE_notes-core"))
        .arg("--serve")
        .arg(base.join("notes"))
        .args(["--host", "0.0.0.0", "--port", "0", "--theme", "dark"])
        .args([
            "--allow-host",
            "notes.example",
            "--allow-host",
            "other.example",
        ])
        .arg("--ready-file")
        .arg(&ready)
        .arg("--stop-file")
        .arg(&stop)
        .env("LOCALAPPDATA", base.join("unused-settings"))
        .env("HOME", base.join("unused-home"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let started = Instant::now();
    while !ready.exists()
        && child.try_wait().unwrap().is_none()
        && started.elapsed() < Duration::from_secs(10)
    {
        std::thread::sleep(Duration::from_millis(25));
    }
    let initialized = ready.exists();
    fs::write(&stop, "").unwrap();
    let stopping = Instant::now();
    while child.try_wait().unwrap().is_none() && stopping.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(25));
    }
    let hung = child.try_wait().unwrap().is_none();
    if hung {
        child.kill().unwrap();
    }
    let output = child.wait_with_output().unwrap();
    assert!(!hung, "CLI did not stop");
    assert!(
        initialized && output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = fs::read_to_string(&ready).unwrap();
    assert!(text.contains("http://127.0.0.1:"));
    assert!(text.contains("\"host\":\"0.0.0.0\""));
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["allowedHosts"],
        serde_json::json!(["notes.example", "other.example"])
    );
    assert!(!text.contains("#token="));
    assert!(!base.join("unused-settings").exists());
    assert!(!base.join("unused-home").exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(ready).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    fs::remove_dir_all(base).unwrap();
}

#[test]
fn cli_manages_users_after_browser_style_initial_setup() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("cli-users-{stamp}"));
    fs::create_dir_all(&base).unwrap();
    let auth_file = base.join("users.json");
    UserStore::new(&auth_file)
        .initialize_admin("owner", "correct horse battery staple")
        .unwrap();

    let run_with_password = |arguments: &[&str], password: &str| {
        let mut child = Command::new(env!("CARGO_BIN_EXE_notes-core"))
            .args(arguments)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(format!("{password}\n").as_bytes())
            .unwrap();
        child.wait_with_output().unwrap()
    };

    let added = run_with_password(
        &[
            "user",
            "add",
            "writer",
            "--auth-file",
            auth_file.to_str().unwrap(),
            "--password-stdin",
        ],
        "writer password long enough",
    );
    assert!(
        added.status.success(),
        "{}",
        String::from_utf8_lossy(&added.stderr)
    );
    let listed = Command::new(env!("CARGO_BIN_EXE_notes-core"))
        .args(["user", "list", "--auth-file"])
        .arg(&auth_file)
        .output()
        .unwrap();
    let users = String::from_utf8_lossy(&listed.stdout);
    assert!(listed.status.success());
    assert!(users.contains("owner\tadmin"));
    assert!(users.contains("writer\tuser"));

    let removed = Command::new(env!("CARGO_BIN_EXE_notes-core"))
        .args(["user", "remove", "writer", "--auth-file"])
        .arg(&auth_file)
        .output()
        .unwrap();
    assert!(
        removed.status.success(),
        "{}",
        String::from_utf8_lossy(&removed.stderr)
    );
    assert_eq!(UserStore::new(&auth_file).list().unwrap().len(), 1);
    fs::remove_dir_all(base).unwrap();
}
