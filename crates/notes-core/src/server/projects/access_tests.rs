use super::watch_access::WatchAccess;
use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        Self(
            std::env::current_dir()
                .unwrap()
                .join("target/access-tests")
                .join(hex(&random)),
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!(
                "Could not clean access fixture {}: {error}",
                self.0.display()
            );
        }
    }
}

#[test]
fn retained_access_and_weak_grants_recheck_current_permissions() {
    let fixture = Fixture::new();
    let notes = fixture.0.join("notes");
    fs::create_dir_all(&notes).unwrap();
    fs::write(notes.join("note.md"), "# Note\n").unwrap();
    let users = UserStore::new(fixture.0.join("config/users.json"));
    users
        .initialize_admin("alice", "access test password long enough")
        .unwrap();
    users
        .add("bob", "access test password long enough", Role::User)
        .unwrap();
    let root = Arc::new(files::Root::open(&notes).unwrap());
    let registry = Arc::new(Registry::open(root, &users).unwrap());
    let owner = registry
        .resolve(
            "default",
            &AuthenticatedUser {
                username: "alice".into(),
                role: Role::Admin,
            },
        )
        .unwrap();
    let share = |level| {
        registry
            .mutate(|catalog| {
                catalog.projects.get_mut("default").unwrap().shared = level;
                Ok(())
            })
            .unwrap()
    };
    share(Sharing::Edit);
    let member = registry
        .resolve(
            "default",
            &AuthenticatedUser {
                username: "bob".into(),
                role: Role::User,
            },
        )
        .unwrap();
    let watched = WatchAccess::new(&member);
    assert!(
        member
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
    share(Sharing::Read);
    assert!(!member.document_permissions("note.md").unwrap().writable);
    assert!(
        !watched
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
    assert_eq!(
        member.check(Some("note.md"), true).unwrap_err().status,
        axum::http::StatusCode::FORBIDDEN
    );
    assert!(owner.document_permissions("note.md").unwrap().writable);
    assert!(!owner.document_permissions("note.md").unwrap().collaborative);
    share(Sharing::Private);
    assert!(member.document_permissions("note.md").is_err());
    assert!(watched.document_permissions("note.md").is_err());
    share(Sharing::Edit);
    registry
        .mutate(|catalog| {
            catalog
                .projects
                .get_mut("default")
                .unwrap()
                .pages
                .insert("note.md".into(), Sharing::Private);
            Ok(())
        })
        .unwrap();
    assert!(member.check(Some("note.md"), false).is_err());
    assert!(!owner.document_permissions("note.md").unwrap().collaborative);
    registry
        .mutate(|catalog| {
            catalog
                .projects
                .get_mut("default")
                .unwrap()
                .pages
                .remove("note.md");
            Ok(())
        })
        .unwrap();
    assert!(
        member
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
    assert!(
        watched
            .document_permissions("note.md")
            .unwrap()
            .collaborative
    );
}
