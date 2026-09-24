use super::*;
use std::{cell::Cell, fs, path::PathBuf, sync::Arc};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        Self(
            std::env::current_dir()
                .unwrap()
                .join("target/resource-tests")
                .join(crate::server::hex(&random)),
        )
    }
    fn open(&self) -> Arc<Store> {
        Store::open(&self.0.join("workspace.sqlite")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!(
                "Could not remove resource fixture {}: {error}",
                self.0.display()
            );
        }
    }
}

#[test]
fn ids_are_persistent_scoped_and_not_derived_from_path_or_content() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let a = store.project("first");
    let b = store.project("second");
    let resource = a.identify("notes/one.md", ResourceKind::Document).unwrap();
    validate_id(&resource.id).unwrap();
    assert_eq!(
        a.identify("notes/one.md", ResourceKind::Document)
            .unwrap()
            .id,
        resource.id
    );
    assert_ne!(
        b.identify("notes/one.md", ResourceKind::Document)
            .unwrap()
            .id,
        resource.id
    );
    assert!(b.resource(&resource.id, false).is_err());
    assert!(a.identify("notes/one.md", ResourceKind::Directory).is_err());
    assert!(a.identify("../escape.md", ResourceKind::Document).is_err());
    for bad in [
        "one.md",
        "00000000-0000-4000-8000-000000000000",
        "00000000-0000-7000-0000-000000000000",
    ] {
        assert!(validate_id(bad).is_err());
    }
    drop(a);
    drop(b);
    drop(store);
    let reopened = fixture.open();
    assert_eq!(
        reopened
            .project("first")
            .resource(&resource.id, false)
            .unwrap()
            .path,
        "notes/one.md"
    );
}

#[test]
fn moving_folders_preserves_descendants_and_rolls_back_storage_on_failed_move() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let project = store.project("first");
    let originals = project
        .identify_many(&[
            ("old".into(), ResourceKind::Directory),
            ("old/one.md".into(), ResourceKind::Document),
            ("old/image.png".into(), ResourceKind::Asset),
        ])
        .unwrap();
    let untouched = project
        .identify("older/one.md", ResourceKind::Document)
        .unwrap();
    let epoch = project.identity_revision().unwrap();
    let moved = Cell::new(false);
    project
        .move_resources(
            "old",
            "new",
            || {
                moved.set(true);
                Ok(())
            },
            || panic!("No rollback expected"),
        )
        .unwrap();
    assert!(moved.get());
    for resource in &originals {
        assert_eq!(
            project.resource(&resource.id, false).unwrap().path,
            resource.path.replacen("old", "new", 1)
        );
    }
    assert_eq!(
        project.resource(&untouched.id, false).unwrap().path,
        untouched.path
    );
    assert!(project.identity_revision().unwrap() > epoch);
    let epoch = project.identity_revision().unwrap();
    assert!(
        project
            .move_resources(
                "new",
                "failed",
                || Err(ApiError::conflict("Fixture move failure")),
                || panic!("File was not moved")
            )
            .is_err()
    );
    assert_eq!(
        project.resource(&originals[0].id, false).unwrap().path,
        "new"
    );
    assert_eq!(project.identity_revision().unwrap(), epoch);
}

#[test]
fn deleted_identity_is_not_reused_by_a_new_file_at_the_same_path() {
    let fixture = Fixture::new();
    let store = fixture.open();
    let project = store.project("first");
    let original = project.identify("one.md", ResourceKind::Document).unwrap();
    project.retire_resource("one.md").unwrap();
    assert!(project.resource(&original.id, false).is_err());
    assert!(project.resource(&original.id, true).unwrap().deleted);
    let replacement = project.identify("one.md", ResourceKind::Document).unwrap();
    assert_ne!(replacement.id, original.id);
    project.retire_resource("one.md").unwrap();
    project
        .restore_resource(&original.id, "restored.md")
        .unwrap();
    assert_eq!(
        project.resource(&original.id, false).unwrap().path,
        "restored.md"
    );
    assert!(project.resource(&replacement.id, false).is_err());
}

#[test]
fn migration_preserves_legacy_history_and_workspace_references_with_one_identity() {
    let fixture = Fixture::new();
    fs::create_dir_all(&fixture.0).unwrap();
    let db = rusqlite::Connection::open(fixture.0.join("workspace.sqlite")).unwrap();
    db.execute_batch(
        "CREATE TABLE revisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,project TEXT NOT NULL,path TEXT NOT NULL,
            version TEXT NOT NULL,content BLOB NOT NULL,size INTEGER NOT NULL,
            actor TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL);
         CREATE TABLE user_workspaces(user_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,data TEXT NOT NULL);"
    ).unwrap();
    let content = "\u{feff}# Legacy\r\n";
    db.execute("INSERT INTO revisions(project,path,version,content,size,actor,kind,created) VALUES ('project','note.md',?1,?2,?3,'owner','save',?4)",
        params!["a".repeat(64),super::super::compress(content.as_bytes()).unwrap(),content.len(),now().unwrap()]).unwrap();
    db.execute("INSERT INTO user_workspaces VALUES ('owner',1,?1)", [
        r#"{"favorites":[{"project":"project","path":"note.md","title":"Saved title"}],"recent":[{"project":"project","path":"note.md","title":"Saved title"}]}"#
    ]).unwrap();
    drop(db);
    let store = fixture.open();
    let project = store.project("project");
    let identity = project.resource_at_path("note.md", false).unwrap().unwrap();
    validate_id(&identity.id).unwrap();
    let revisions = project.revisions_for_resource(&identity.id).unwrap();
    assert_eq!(revisions.len(), 1);
    assert_eq!(
        project
            .revision_for_resource(&identity.id, revisions[0].id)
            .unwrap()
            .content,
        content
    );
    let workspace = store.workspace("owner").unwrap();
    assert!(workspace.revision > 1);
    assert_eq!(
        workspace.workspace.favorites[0].id.as_deref(),
        Some(identity.id.as_str())
    );
    assert_eq!(
        workspace.workspace.recent[0].id.as_deref(),
        Some(identity.id.as_str())
    );
    assert_eq!(workspace.workspace.favorites[0].title, "Saved title");
    let revision = workspace.revision;
    drop(project);
    drop(store);
    let reopened = fixture.open();
    assert_eq!(
        reopened
            .project("project")
            .resource_at_path("note.md", false)
            .unwrap()
            .unwrap()
            .id,
        identity.id
    );
    assert_eq!(reopened.workspace("owner").unwrap().revision, revision);
}
