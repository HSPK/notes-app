use super::*;
use std::{path::PathBuf, sync::mpsc, thread};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        Self(
            std::env::current_dir()
                .unwrap()
                .join("target/store-read-tests")
                .join(super::super::hex(&random)),
        )
    }
    fn store(&self) -> Arc<Store> {
        Store::open(&self.0.join("workspace.sqlite")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!(
                "Could not remove read fixture {}: {error}",
                self.0.display()
            );
        }
    }
}

#[test]
fn workspace_reader_sees_committed_state_without_waiting_for_a_writer() {
    let fixture = Fixture::new();
    let store = fixture.store();
    store
        .with(|connection| {
            connection.execute(
            "INSERT INTO user_workspaces(user_id,revision,data) VALUES ('reader-test',1,?1)",
            [r#"{"tabs":[],"favorites":[],"recent":[]}"#],
        ).map_err(db_error)?;
            Ok(())
        })
        .unwrap();
    let (started, waiting) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let writer_store = store.clone();
    let writer = thread::spawn(move || {
        writer_store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE user_workspaces SET revision=2 WHERE user_id='reader-test'",
                    [],
                )
                .map_err(db_error)?;
            started.send(()).unwrap();
            resume.recv().unwrap();
            transaction.commit().map_err(db_error)
        })
    });
    waiting.recv().unwrap();
    let (finished, received) = mpsc::channel();
    let reader_store = store.clone();
    let reader = thread::spawn(move || {
        finished
            .send(
                reader_store
                    .workspace("reader-test")
                    .map(|state| state.revision),
            )
            .unwrap()
    });
    let before_commit = received.recv_timeout(Duration::from_secs(3));
    release.send(()).unwrap();
    writer.join().unwrap().unwrap();
    reader.join().unwrap();
    assert_eq!(
        before_commit
            .expect("Workspace read waited for the write transaction")
            .unwrap(),
        1
    );
    assert_eq!(store.workspace("reader-test").unwrap().revision, 2);
    store
        .with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE user_workspaces SET revision=3 WHERE user_id='reader-test'",
                    [],
                )
                .map_err(db_error)?;
            assert_eq!(store.workspace("reader-test")?.revision, 2);
            transaction.rollback().map_err(db_error)
        })
        .unwrap();
    assert_eq!(store.workspace("reader-test").unwrap().revision, 2);
    assert_eq!(store.workspace("another-user").unwrap().revision, 0);
    let blocked = store
        .with_read(|connection| {
            Ok(connection
                .execute("DELETE FROM user_workspaces", [])
                .unwrap_err())
        })
        .unwrap();
    assert!(
        matches!(blocked, rusqlite::Error::SqliteFailure(error, _) if error.code == rusqlite::ErrorCode::ReadOnly)
    );
    let synchronous: i64 = store
        .with(|connection| {
            connection
                .query_row("PRAGMA synchronous", [], |row| row.get(0))
                .map_err(db_error)
        })
        .unwrap();
    assert_eq!(synchronous, 2);
    drop(store);
    assert_eq!(
        fixture.store().workspace("reader-test").unwrap().revision,
        2
    );
}

#[test]
fn visitor_reads_do_not_wait_for_writes_and_observe_committed_revocation() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let project = store.project("visitor-project");
    let (token, _) = project.issue_visitor("link", "signature", None).unwrap();
    let name = project
        .visitor(&token, "link", "signature")
        .unwrap()
        .unwrap();
    assert!(
        project
            .visitor(&token, "other-link", "signature")
            .unwrap()
            .is_none()
    );
    assert!(
        project
            .visitor(&token, "link", "changed-signature")
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .project("other-project")
            .visitor(&token, "link", "signature")
            .unwrap()
            .is_none()
    );
    let (started, waiting) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let writer_store = store.clone();
    let writer = thread::spawn(move || {
        writer_store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM public_sessions WHERE project='visitor-project'",
                    [],
                )
                .map_err(db_error)?;
            started.send(()).unwrap();
            resume.recv().unwrap();
            transaction.commit().map_err(db_error)
        })
    });
    waiting.recv().unwrap();
    let (finished, received) = mpsc::channel();
    let reader_project = project.clone();
    let reader_token = token.clone();
    let reader = thread::spawn(move || {
        finished
            .send(reader_project.visitor(&reader_token, "link", "signature"))
            .unwrap();
    });
    let before_commit = received.recv_timeout(Duration::from_secs(3));
    release.send(()).unwrap();
    writer.join().unwrap().unwrap();
    reader.join().unwrap();
    assert_eq!(
        before_commit
            .expect("Visitor lookup waited for the writer")
            .unwrap()
            .as_deref(),
        Some(name.as_str())
    );
    assert!(
        project
            .visitor(&token, "link", "signature")
            .unwrap()
            .is_none()
    );
    let (expired, _) = project.issue_visitor("link", "signature", None).unwrap();
    store
        .with(|connection| {
            connection
                .execute(
                    "UPDATE public_sessions SET expires=0 WHERE project='visitor-project'",
                    [],
                )
                .map_err(db_error)?;
            Ok(())
        })
        .unwrap();
    assert!(
        project
            .visitor(&expired, "link", "signature")
            .unwrap()
            .is_none()
    );
}

#[test]
fn history_reads_use_committed_snapshots_and_keep_scope_expiry_and_content_checks() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let project = store.project("history-project");
    let original = "\u{feff}# Before\r\nKept exactly.\r\n";
    project
        .record(
            &crate::server::files::Document {
                id: None,
                project: None,
                references: Vec::new(),
                warning: None,
                bom: true,
                path: "note.md".into(),
                content: original.trim_start_matches('\u{feff}').into(),
                html: String::new(),
                version: "a".repeat(64),
                title: None,
            },
            "owner",
            "save",
        )
        .unwrap();
    let id = project.revisions("note.md").unwrap()[0].id;
    let changed = "\u{feff}# After\r\nNew content.\r\n";
    let bytes = compress(changed.as_bytes()).unwrap();
    let (started, waiting) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let writer_store = store.clone();
    let writer = thread::spawn(move || {
        writer_store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE revisions SET content=?1,size=?2,version=?3 WHERE id=?4",
                    rusqlite::params![bytes, changed.len(), "b".repeat(64), id],
                )
                .map_err(db_error)?;
            started.send(()).unwrap();
            resume.recv().unwrap();
            transaction.commit().map_err(db_error)
        })
    });
    waiting.recv().unwrap();
    let (finished, received) = mpsc::channel();
    let reader_project = project.clone();
    let reader = thread::spawn(move || {
        finished
            .send(reader_project.revision("note.md", id))
            .unwrap()
    });
    let pending = received.recv_timeout(Duration::from_secs(3));
    release.send(()).unwrap();
    writer.join().unwrap().unwrap();
    reader.join().unwrap();
    assert_eq!(
        pending
            .expect("History read waited for the writer")
            .unwrap()
            .content,
        original
    );
    assert_eq!(project.revision("note.md", id).unwrap().content, changed);
    assert!(project.revision("other.md", id).is_err());
    assert!(
        store
            .project("another-project")
            .revision("note.md", id)
            .is_err()
    );
    store
        .with(|connection| {
            connection
                .execute("UPDATE revisions SET created=0 WHERE id=?1", [id])
                .map_err(db_error)?;
            Ok(())
        })
        .unwrap();
    assert!(project.revision("note.md", id).is_err());
    store
        .with(|connection| {
            connection
                .execute(
                    "UPDATE revisions SET created=?1,content=?2 WHERE id=?3",
                    rusqlite::params![now()?, compress(&[0xff])?, id],
                )
                .map_err(db_error)?;
            Ok(())
        })
        .unwrap();
    assert!(project.revision("note.md", id).is_err());
}

#[test]
fn serialized_workspace_reads_remain_available_without_a_wal_reader() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let Ok(mut store) = Arc::try_unwrap(store) else {
        panic!("Unexpected store owner");
    };
    store.reader = None;
    assert_eq!(store.workspace("reader-test").unwrap().revision, 0);
    let store = Arc::new(store);
    let project = store.project("fallback");
    let (token, _) = project.issue_visitor("link", "signature", None).unwrap();
    assert!(
        project
            .visitor(&token, "link", "signature")
            .unwrap()
            .is_some()
    );
}
