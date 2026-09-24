use super::*;
use crate::{
    auth::{AuthenticatedUser, Role, UserStore},
    server::files,
};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

struct Fixture {
    root: PathBuf,
    remote: PathBuf,
    base: PathBuf,
    users: UserStore,
    registry: Arc<Registry>,
}

fn git(root: &Path, args: &[&str]) -> String {
    let mut command = Command::new("git");
    command.arg("-C").arg(root);
    if root.join("HEAD").is_file() {
        command.arg("--git-dir").arg(root);
    }
    let output = command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap().trim().into()
}

impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        let base = std::env::current_dir()
            .unwrap()
            .join("target/git-sync-tests")
            .join(crate::server::hex(&random));
        let root = base.join("notes");
        let remote = base.join("remote.git");
        fs::create_dir_all(&root).unwrap();
        git(&base, &["init", "--bare", remote.to_str().unwrap()]);
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Sync Test"]);
        git(&root, &["config", "user.email", "sync@example.invalid"]);
        fs::write(root.join("note.md"), "initial").unwrap();
        fs::write(root.join(".gitignore"), "ignored.md\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(&root, &["push", "-u", "origin", "main"]);
        let users = UserStore::new(base.join("config/users.json"));
        users
            .initialize_admin("alice", "test password long enough")
            .unwrap();
        let registry = Self::open(&root, &users);
        registry
            .resolve(
                "default",
                &AuthenticatedUser {
                    username: "alice".into(),
                    role: Role::Admin,
                },
            )
            .unwrap();
        users
            .add("admin2", "test password long enough", Role::Admin)
            .unwrap();
        Self {
            root,
            remote,
            base,
            users,
            registry,
        }
    }
    fn open(root: &Path, users: &UserStore) -> Arc<Registry> {
        Arc::new(Registry::open(Arc::new(files::Root::open(root).unwrap()), users).unwrap())
    }
    fn enable(&self) {
        self.registry
            .mutate(|catalog| {
                let project = catalog.projects.get_mut("default").unwrap();
                project.git_sync = Config {
                    enabled: true,
                    interval_minutes: 30,
                    revision: 1,
                    target: Some(
                        self.registry
                            .library("default", project)?
                            .git
                            .sync_target(&|| Ok(()))?,
                    ),
                };
                Ok(())
            })
            .unwrap();
    }
    fn error(&self) -> Option<String> {
        self.registry
            .sync_status
            .lock()
            .unwrap()
            .get("default")
            .and_then(|status| status.error.clone())
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.base).unwrap();
    }
}

fn due(registry: &Registry, schedules: &mut HashMap<String, Schedule>, health: &Health) {
    schedules.get_mut("default").unwrap().next = Instant::now();
    registry.sync_tick(schedules, health).unwrap();
}

#[test]
fn automatic_sync_stages_commits_pushes_and_preserves_ignore_rules_without_empty_commits() {
    let fixture = Fixture::new();
    let health = Health::default();
    let mut schedules = HashMap::new();
    fixture.registry.sync_tick(&mut schedules, &health).unwrap();
    assert!(schedules.is_empty());
    fixture.enable();
    fixture.registry.sync_tick(&mut schedules, &health).unwrap();
    assert!(schedules["default"].next > Instant::now());
    git(&fixture.root, &["config", "remote.origin.mirror", "true"]);
    git(
        &fixture.root,
        &[
            "config",
            "remote.origin.push",
            "+refs/heads/main:refs/heads/other",
        ],
    );
    fs::write(fixture.root.join("note.md"), "changed").unwrap();
    fs::write(fixture.root.join("new.md"), "new").unwrap();
    fs::write(fixture.root.join("ignored.md"), "must stay local").unwrap();
    due(&fixture.registry, &mut schedules, &health);
    assert_eq!(fixture.error(), None);
    assert_eq!(git(&fixture.remote, &["show", "main:note.md"]), "changed");
    assert_eq!(git(&fixture.remote, &["show", "main:new.md"]), "new");
    assert_eq!(
        git(
            &fixture.remote,
            &["for-each-ref", "--format=%(refname)", "refs/heads/"]
        ),
        "refs/heads/main"
    );
    assert!(!git(&fixture.remote, &["ls-tree", "--name-only", "main"]).contains("ignored.md"));
    let committed = git(&fixture.root, &["rev-parse", "HEAD"]);
    due(&fixture.registry, &mut schedules, &health);
    assert_eq!(git(&fixture.root, &["rev-parse", "HEAD"]), committed);
    fs::remove_file(fixture.root.join("new.md")).unwrap();
    due(&fixture.registry, &mut schedules, &health);
    assert!(!git(&fixture.remote, &["ls-tree", "--name-only", "main"]).contains("new.md"));
    assert!(
        fixture.registry.sync_status.lock().unwrap()["default"]
            .last_success_at
            .is_some()
    );
}

#[test]
fn automatic_sync_is_persistent_owner_bound_disableable_and_exclusive_between_services() {
    let fixture = Fixture::new();
    fixture.enable();
    let other = Fixture::open(&fixture.root, &fixture.users);
    assert!(
        other.catalog().unwrap().projects["default"]
            .git_sync
            .enabled
    );
    let health = Health::default();
    let mut first = HashMap::new();
    let mut second = HashMap::new();
    fixture.registry.sync_tick(&mut first, &health).unwrap();
    other.sync_tick(&mut second, &health).unwrap();
    assert!(second.is_empty());
    assert!(other.sync_status.lock().unwrap()["default"].error.is_some());
    fixture.users.remove("alice").unwrap();
    fs::write(fixture.root.join("note.md"), "not published").unwrap();
    due(&fixture.registry, &mut first, &health);
    assert!(fixture.error().unwrap().contains("account"));
    assert_eq!(git(&fixture.remote, &["show", "main:note.md"]), "initial");
    fixture
        .registry
        .mutate(|catalog| {
            catalog
                .projects
                .get_mut("default")
                .unwrap()
                .git_sync
                .enabled = false;
            Ok(())
        })
        .unwrap();
    fixture.registry.sync_tick(&mut first, &health).unwrap();
    assert!(first.is_empty());
    assert!(
        fixture.registry.sync_status.lock().unwrap()["default"]
            .next_run_at
            .is_none()
    );
}

#[test]
fn automatic_sync_rejects_changed_targets_in_progress_operations_and_non_fast_forward_push() {
    let fixture = Fixture::new();
    fixture.enable();
    let health = Health::default();
    let mut schedules = HashMap::new();
    fixture.registry.sync_tick(&mut schedules, &health).unwrap();
    git(&fixture.root, &["checkout", "-b", "other"]);
    git(&fixture.root, &["branch", "--set-upstream-to=origin/main"]);
    due(&fixture.registry, &mut schedules, &health);
    assert!(fixture.error().unwrap().contains("changed"));
    git(&fixture.root, &["checkout", "main"]);
    fs::write(
        fixture.root.join(".git/MERGE_HEAD"),
        git(&fixture.root, &["rev-parse", "HEAD"]),
    )
    .unwrap();
    due(&fixture.registry, &mut schedules, &health);
    assert!(fixture.error().unwrap().contains("in-progress"));
    fs::remove_file(fixture.root.join(".git/MERGE_HEAD")).unwrap();
    let clone = fixture.base.join("other");
    git(
        &fixture.base,
        &[
            "clone",
            "--branch",
            "main",
            fixture.remote.to_str().unwrap(),
            clone.to_str().unwrap(),
        ],
    );
    git(&clone, &["config", "user.name", "Other"]);
    git(&clone, &["config", "user.email", "other@example.invalid"]);
    fs::write(clone.join("remote.md"), "remote update").unwrap();
    git(&clone, &["add", "."]);
    git(&clone, &["commit", "-m", "remote"]);
    git(&clone, &["push"]);
    let remote_head = git(&fixture.remote, &["rev-parse", "main"]);
    fs::write(fixture.root.join("note.md"), "local update").unwrap();
    due(&fixture.registry, &mut schedules, &health);
    assert!(fixture.error().is_some());
    assert_eq!(git(&fixture.remote, &["rev-parse", "main"]), remote_head);
    assert_eq!(
        git(&fixture.root, &["show", "HEAD:note.md"]),
        "local update"
    );
    let local_head = git(&fixture.root, &["rev-parse", "HEAD"]);
    due(&fixture.registry, &mut schedules, &health);
    assert_eq!(git(&fixture.root, &["rev-parse", "HEAD"]), local_head);
}

#[test]
fn automatic_sync_checks_shutdown_before_writing() {
    let fixture = Fixture::new();
    fixture.enable();
    let health = Health::default();
    let mut schedules = HashMap::new();
    fixture.registry.sync_tick(&mut schedules, &health).unwrap();
    fs::write(fixture.root.join("note.md"), "unsynced").unwrap();
    health.stopping.store(true, Ordering::Release);
    due(&fixture.registry, &mut schedules, &health);
    assert_eq!(git(&fixture.remote, &["show", "main:note.md"]), "initial");
    assert_eq!(git(&fixture.root, &["show", "HEAD:note.md"]), "initial");
}

#[test]
#[cfg(unix)]
fn automatic_sync_cancels_an_inflight_push_and_its_children_on_shutdown() {
    use std::os::unix::fs::PermissionsExt;
    let fixture = Fixture::new();
    fixture.enable();
    let project = fixture.registry.catalog().unwrap().projects["default"].clone();
    let library = fixture.registry.library("default", &project).unwrap();
    let hook = fixture.remote.join("hooks/pre-receive");
    fs::write(&hook, "#!/bin/sh\ntouch hook-started\nsleep 30\n").unwrap();
    fs::set_permissions(hook, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        fixture.root.join("note.md"),
        "local commit before cancellation",
    )
    .unwrap();
    let health = Health::default();
    let started = Instant::now();
    let result = library.git.automatic_sync(
        &library.saves,
        project.git_sync.target.as_ref().unwrap(),
        &|| {
            if fixture.remote.join("hook-started").is_file() {
                health.stopping.store(true, Ordering::Release);
            }
            fixture
                .registry
                .sync_permitted("default", &project.git_sync, &health)
        },
    );
    assert!(result.is_err());
    assert!(fixture.remote.join("hook-started").is_file());
    assert!(started.elapsed() < Duration::from_secs(3));
    assert_eq!(git(&fixture.remote, &["show", "main:note.md"]), "initial");
    assert_eq!(
        git(&fixture.root, &["show", "HEAD:note.md"]),
        "local commit before cancellation"
    );
}
