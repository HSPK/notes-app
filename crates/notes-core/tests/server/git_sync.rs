use super::{
    projects::{login, request, users},
    *,
};
use std::{
    process::Command,
    time::{Duration, Instant},
};

fn git(root: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.arg("-C").arg(root);
    if root.join("HEAD").is_file() {
        command.arg("--git-dir").arg(root);
    }
    let output = command.args(args).output().unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

#[test]
fn project_sync_settings_require_owner_confirmation_and_survive_restart() {
    let workspace = Workspace::new();
    let store = users(&workspace);
    let mut server = start_with_users(&workspace.root, 0, store.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let state = request(&client, &alice, "default", "GET", "/api/git/sync", None).json();
    assert_eq!(state["enabled"], false);
    assert_eq!(state["intervalMinutes"], 30);
    request(&client, &bob, "default", "GET", "/api/git/sync", None).error(403);
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":"default","shared":"edit"})),
    );
    request(&client, &bob, "default", "GET", "/api/git/sync", None).error(403);
    request(
        &client,
        &bob,
        "default",
        "PUT",
        "/api/git/sync",
        Some(json!({"enabled":false,"intervalMinutes":10})),
    )
    .error(403);
    for interval in [0, 1441] {
        request(
            &client,
            &alice,
            "default",
            "PUT",
            "/api/git/sync",
            Some(json!({"enabled":false,"intervalMinutes":interval})),
        )
        .error(400);
    }
    request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/git/sync",
        Some(json!({"enabled":true,"intervalMinutes":30})),
    )
    .error(400);
    request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/git/sync",
        Some(json!({"enabled":true,"intervalMinutes":30,"confirm":true})),
    )
    .error(403);
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "PUT",
            "/api/git/sync",
            Some(json!({"enabled":false,"intervalMinutes":15}))
        )
        .status,
        200
    );
    let second = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"create","kind":"new","name":"Second"})),
    )
    .json();
    assert_eq!(
        request(
            &client,
            &alice,
            second["id"].as_str().unwrap(),
            "GET",
            "/api/git/sync",
            None
        )
        .json()["intervalMinutes"],
        30
    );
    server.stop().unwrap();
    let server = start_with_users(&workspace.root, 0, store).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    assert_eq!(
        request(&client, &alice, "default", "GET", "/api/git/sync", None).json()["intervalMinutes"],
        15
    );
    let token = start(&workspace.outside, 0).unwrap();
    Client::new(&token)
        .api("GET", "/api/git/sync", None)
        .error(403);
}

#[test]
fn backend_timer_commits_and_pushes_after_restart_without_browser_requests() {
    let workspace = Workspace::new();
    let remote = workspace.base.join("remote.git");
    git(
        &workspace.base,
        &["init", "--bare", remote.to_str().unwrap()],
    );
    git(&workspace.root, &["init", "-b", "main"]);
    git(&workspace.root, &["config", "user.name", "Notes Test"]);
    git(
        &workspace.root,
        &["config", "user.email", "notes@example.invalid"],
    );
    workspace.write("note.md", "initial");
    git(&workspace.root, &["add", "."]);
    git(&workspace.root, &["commit", "-m", "initial"]);
    git(
        &workspace.root,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    git(&workspace.root, &["push", "-u", "origin", "main"]);
    let store = users(&workspace);
    let mut server = start_with_users(&workspace.root, 0, store.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let enabled = request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/git/sync",
        Some(json!({"enabled":true,"intervalMinutes":1,"confirm":true})),
    );
    assert_eq!(enabled.status, 200, "{}", enabled.text());
    assert_eq!(enabled.json()["upstream"], "origin/main");
    server.stop().unwrap();
    workspace.write("note.md", "automatic");
    let mut server = start_with_users(&workspace.root, 0, store).unwrap();
    let deadline = Instant::now() + Duration::from_secs(75);
    loop {
        if git(&remote, &["show", "main:note.md"]) == "automatic" {
            break;
        }
        assert!(Instant::now() < deadline, "backend timer did not push");
        std::thread::sleep(Duration::from_millis(500));
    }
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let result = request(&client, &alice, "default", "GET", "/api/git/sync", None).json();
    assert_eq!(result["error"], Value::Null);
    assert!(result["lastSuccessAt"].is_number());
    assert_eq!(
        git(&workspace.root, &["log", "-1", "--pretty=%s"]),
        "Notes: automatic sync"
    );
    let shutdown = Instant::now();
    server.stop().unwrap();
    assert!(shutdown.elapsed() < Duration::from_secs(2));
}
