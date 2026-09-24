use super::projects::{login, request, users};
use super::public_sharing::public;
use super::*;

fn resource(client: &Client, cookie: &str, project: &str, path: &str, kind: &str) -> String {
    let result = request(
        client,
        cookie,
        project,
        "POST",
        "/api/resources/resolve",
        Some(json!({"path":path,"kind":kind})),
    );
    assert_eq!(result.status, 200, "{}", result.text());
    result.json()["id"].as_str().unwrap().into()
}

#[test]
fn uuid_document_bookmarks_survive_move_restart_and_keep_shared_access() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Original\n\n![image](assets/picture.png)\n");
    workspace.write("assets/picture.png", projects::png());
    let user_store = users(&workspace);
    let server = start_with_users(&workspace.root, 0, user_store.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let id = resource(&client, &alice, "default", "note.md", "document");
    assert_eq!(uuid::Uuid::parse_str(&id).unwrap().get_version_num(), 7);
    let read = |client: &Client, cookie: &str| {
        request(
            client,
            cookie,
            "default",
            "GET",
            &format!("/api/document?id={id}"),
            None,
        )
    };
    request(
        &client,
        &alice,
        "default",
        "GET",
        "/api/document?path=note.md",
        None,
    )
    .error(400);
    let original = read(&client, &alice).json();
    assert_eq!(original["id"], id);
    assert!(original["html"].as_str().unwrap().contains("/assets?id="));
    assert!(!original["html"].as_str().unwrap().contains("?path="));
    let shared = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"document","id":"default","document":id,"permission":"publicRead"})),
    );
    assert_eq!(shared.status, 200, "{}", shared.text());
    let token = shared.json()["publicLinks"]["note.md"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(read(&client, &bob).status, 200);
    let moved = request(
        &client,
        &alice,
        "default",
        "PATCH",
        "/api/entry",
        Some(json!({"id":id,"destination":"renamed.md","updateLinks":false})),
    );
    assert_eq!(moved.status, 200, "{}", moved.text());
    assert_eq!(moved.json()["id"], id);
    assert_eq!(read(&client, &bob).json()["path"], "renamed.md");
    let guest = public(&client, &token, "POST", "/api/public/session", None);
    assert_eq!(guest.status, 200, "{}", guest.text());
    assert_eq!(guest.json()["id"], id);
    assert_eq!(guest.json()["path"], "renamed.md");
    let asset = resource(&client, &alice, "default", "assets/picture.png", "asset");
    assert_eq!(
        public(
            &client,
            &token,
            "GET",
            &format!("/api/public/assets?id={asset}&document={id}"),
            None
        )
        .status,
        200
    );
    drop(server);
    let server = start_with_users(&workspace.root, 0, user_store).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    assert_eq!(read(&client, &alice).json()["path"], "renamed.md");
    assert_eq!(
        resource(&client, &alice, "default", "renamed.md", "document"),
        id
    );
}

#[test]
fn replaced_path_cannot_reuse_deleted_document_history_or_public_link() {
    let workspace = Workspace::new();
    workspace.write("note.md", "\u{feff}# Original\r\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let old = resource(&client, &alice, "default", "note.md", "document");
    let original = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={old}"),
        None,
    )
    .json();
    let shared = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"document","id":"default","document":old,"permission":"publicRead"})),
    )
    .json();
    let token = shared["publicLinks"]["note.md"]["token"].as_str().unwrap();
    let recycled = request(
        &client,
        &alice,
        "default",
        "DELETE",
        "/api/document",
        Some(json!({"id":old,"version":original["version"]})),
    );
    assert_eq!(recycled.status, 200, "{}", recycled.text());
    let fresh = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/document",
        Some(json!({"path":"note.md","content":"# Replacement\n"})),
    )
    .json();
    assert_ne!(fresh["id"], old);
    request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={old}"),
        None,
    )
    .error(404);
    let history = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/history?document={old}"),
        None,
    )
    .json();
    assert!(history["currentVersion"].is_null());
    assert_eq!(history["revisions"].as_array().unwrap().len(), 1);
    let old_revision = &history["revisions"][0]["id"];
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "GET",
            &format!("/api/history/content?document={old}&revision={old_revision}"),
            None
        )
        .json()["content"],
        "\u{feff}# Original\r\n"
    );
    request(
        &client,
        &alice,
        "default",
        "GET",
        &format!(
            "/api/history/content?document={}&revision={old_revision}",
            fresh["id"].as_str().unwrap()
        ),
        None,
    )
    .error(400);
    public(&client, token, "POST", "/api/public/session", None).error(403);
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/trash/restore",
        Some(json!({"id":recycled.json()["id"]})),
    )
    .error(409);
    let newer_trash = request(
        &client,
        &alice,
        "default",
        "DELETE",
        "/api/document",
        Some(json!({"id":fresh["id"],"version":fresh["version"]})),
    );
    assert_eq!(newer_trash.status, 200);
    let restored = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/trash/restore",
        Some(json!({"id":recycled.json()["id"]})),
    );
    assert_eq!(restored.status, 200, "{}", restored.text());
    assert_eq!(restored.json()["id"], old);
    assert_eq!(
        fs::read(workspace.root.join("note.md")).unwrap(),
        "\u{feff}# Original\r\n".as_bytes()
    );
}

#[test]
fn uuid_is_not_authorization_and_cross_project_ids_are_rejected() {
    let workspace = Workspace::new();
    workspace.write("private.md", "# Private\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let id = resource(&client, &alice, "default", "private.md", "document");
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/resources/resolve",
        Some(json!({"path":"private.md","kind":"asset"})),
    )
    .error(400);
    request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/api/resource?id={id}"),
        None,
    )
    .error(403);
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"document","id":"default","path":"private.md","permission":"read"})),
    )
    .error(400);
    let other = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"create","kind":"new","name":"Second"})),
    )
    .json();
    request(
        &client,
        &alice,
        other["id"].as_str().unwrap(),
        "GET",
        &format!("/api/document?id={id}"),
        None,
    )
    .error(403);
}

#[test]
fn existing_public_link_metadata_is_bound_to_persistent_ids_without_rotating_credentials() {
    let workspace = Workspace::new();
    workspace.write("shared.md", "# Shared\n");
    let users = users(&workspace);
    let server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let id = resource(&client, &alice, "default", "shared.md", "document");
    let shared = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"document","id":"default","document":id,"permission":"publicRead"})),
    )
    .json();
    let token = shared["publicLinks"]["shared.md"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    drop(server);
    let catalog = fs::read_dir(workspace.base.join("config"))
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            entry.file_name().to_string_lossy().starts_with("projects-")
                && entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "json")
        })
        .unwrap()
        .path();
    let mut saved: Value = serde_json::from_slice(&fs::read(&catalog).unwrap()).unwrap();
    saved["projects"]["default"]["publicLinks"]["shared.md"]
        .as_object_mut()
        .unwrap()
        .remove("resource");
    fs::write(&catalog, serde_json::to_vec(&saved).unwrap()).unwrap();
    let restarted = start_with_users(&workspace.root, 0, users).unwrap();
    let client = Client::new(&restarted);
    let session = public(&client, &token, "POST", "/api/public/session", None);
    assert_eq!(session.status, 200, "{}", session.text());
    assert_eq!(session.json()["id"], id);
    let saved: Value = serde_json::from_slice(&fs::read(catalog).unwrap()).unwrap();
    assert_eq!(
        saved["projects"]["default"]["publicLinks"]["shared.md"]["resource"],
        id
    );
    assert_eq!(
        saved["projects"]["default"]["publicLinks"]["shared.md"]["token"],
        token
    );
}

#[cfg(unix)]
#[test]
fn issued_resource_ids_do_not_bypass_filesystem_symlink_checks() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Original\n");
    workspace.write("image.png", projects::png());
    fs::write(workspace.outside.join("secret.md"), "outside secret").unwrap();
    fs::write(workspace.outside.join("image.png"), b"outside image").unwrap();
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document = resource(&client, &alice, "default", "note.md", "document");
    let asset = resource(&client, &alice, "default", "image.png", "asset");
    let original = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={document}"),
        None,
    )
    .json();
    fs::remove_file(workspace.root.join("note.md")).unwrap();
    fs::remove_file(workspace.root.join("image.png")).unwrap();
    std::os::unix::fs::symlink(
        workspace.outside.join("secret.md"),
        workspace.root.join("note.md"),
    )
    .unwrap();
    std::os::unix::fs::symlink(
        workspace.outside.join("image.png"),
        workspace.root.join("image.png"),
    )
    .unwrap();
    request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={document}"),
        None,
    )
    .error(403);
    request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/document",
        Some(json!({"id":document,"version":original["version"],"content":"wrong target"})),
    )
    .error(403);
    request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/assets?id={asset}&document={document}"),
        None,
    )
    .error(403);
    assert_eq!(
        fs::read_to_string(workspace.outside.join("secret.md")).unwrap(),
        "outside secret"
    );
}
