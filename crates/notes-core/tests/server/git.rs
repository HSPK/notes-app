use std::process::{Command, Output};

use super::*;

fn git(root: &Path, arguments: &[&str]) -> Output {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(arguments)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        arguments,
        String::from_utf8_lossy(&output.stderr)
    );
    output
}

fn configure(root: &Path) {
    git(root, &["config", "user.name", "Notes Test"]);
    git(root, &["config", "user.email", "notes@example.invalid"]);
}

#[test]
fn git_status_diff_commit_and_safe_sync_work_without_arbitrary_commands() {
    if Command::new("git").arg("--version").output().is_err() {
        eprintln!("Skipping Git integration test because Git is unavailable.");
        return;
    }
    let workspace = Workspace::new();
    let remote = workspace.base.join("remote.git");
    git(
        &workspace.base,
        &["init", "--bare", remote.to_str().unwrap()],
    );
    git(&workspace.root, &["init", "-b", "main"]);
    configure(&workspace.root);
    workspace.write("note.md", "# Initial\n");
    git(&workspace.root, &["add", "note.md"]);
    git(&workspace.root, &["commit", "-m", "Initial"]);
    git(
        &workspace.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&workspace.root, &["push", "-u", "origin", "main"]);

    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let initial = client.api("GET", "/api/git", None);
    assert_eq!(initial.status, 200, "{}", initial.text());
    assert_eq!(initial.json()["branch"], "main");
    assert_eq!(initial.json()["clean"], true);

    workspace.write("new.md", "# New\n");
    let new_id = client.resource_id("new.md", "document");
    let untracked = client.api("GET", &format!("/api/git/diff?id={new_id}"), None);
    assert_eq!(untracked.status, 200, "{}", untracked.text());
    assert!(
        untracked.json()["text"]
            .as_str()
            .unwrap()
            .contains("+# New")
    );
    fs::remove_file(workspace.root.join("new.md")).unwrap();

    workspace.write("note.md", "# Changed\n");
    let changed = client.api("GET", "/api/git", None).json();
    assert_eq!(changed["files"][0]["path"], "note.md");
    assert_eq!(changed["files"][0]["worktreeStatus"], "M");
    let id = changed["files"][0]["id"].as_str().unwrap();
    let diff = client.api("GET", &format!("/api/git/diff?id={id}"), None);
    assert_eq!(diff.status, 200, "{}", diff.text());
    assert!(diff.json()["text"].as_str().unwrap().contains("+# Changed"));

    let stage = client.api(
        "POST",
        "/api/git",
        Some(json!({"action": "stage", "ids": [id]})),
    );
    assert_eq!(stage.status, 200, "{}", stage.text());
    assert_eq!(stage.json()["files"][0]["indexStatus"], "M");
    let unstage = client.api(
        "POST",
        "/api/git",
        Some(json!({"action": "unstage", "ids": [id]})),
    );
    assert_eq!(unstage.status, 200, "{}", unstage.text());
    assert_eq!(unstage.json()["files"][0]["indexStatus"], ".");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let marker = workspace.base.join("hook-ran");
        let hook = workspace.root.join(".git/hooks/pre-commit");
        fs::write(&hook, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let restaged = client.api(
        "POST",
        "/api/git",
        Some(json!({"action": "stage", "ids": [id]})),
    );
    assert_eq!(restaged.status, 200, "{}", restaged.text());
    let commit = client.api(
        "POST",
        "/api/git",
        Some(json!({"action": "commit", "message": "Update note"})),
    );
    assert_eq!(commit.status, 200, "{}", commit.text());
    assert_eq!(commit.json()["clean"], true);
    #[cfg(unix)]
    assert!(!workspace.base.join("hook-ran").exists());
    assert_eq!(
        String::from_utf8(git(&workspace.root, &["log", "-1", "--pretty=%s"]).stdout)
            .unwrap()
            .trim(),
        "Update note"
    );

    client
        .api(
            "POST",
            "/api/git",
            Some(json!({"action": "push", "confirm": false})),
        )
        .error(400);
    let pushed = client.api(
        "POST",
        "/api/git",
        Some(json!({"action": "push", "confirm": true})),
    );
    assert_eq!(pushed.status, 200, "{}", pushed.text());

    let clone = workspace.outside.join("clone");
    git(
        &workspace.outside,
        &[
            "clone",
            "--branch",
            "main",
            remote.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    configure(&clone);
    fs::write(clone.join("remote.md"), "# Remote\n").unwrap();
    git(&clone, &["add", "remote.md"]);
    git(&clone, &["commit", "-m", "Remote update"]);
    git(&clone, &["push"]);
    client
        .api(
            "POST",
            "/api/git",
            Some(json!({"action": "pull", "confirm": false})),
        )
        .error(400);
    let pulled = client.api(
        "POST",
        "/api/git",
        Some(json!({"action": "pull", "confirm": true})),
    );
    assert_eq!(pulled.status, 200, "{}", pulled.text());
    assert_eq!(
        fs::read_to_string(workspace.root.join("remote.md")).unwrap(),
        "# Remote\n"
    );

    client
        .api(
            "POST",
            "/api/git",
            Some(json!({"action": "stage", "ids": ["../escape.md"]})),
        )
        .error(400);
}
