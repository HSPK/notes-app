pub(super) use super::resource_fixture::resource_id;
use super::*;

pub(super) fn login(client: &Client, username: &str) -> String {
    let response = client.request(
        "POST",
        "/api/auth/login",
        &[("Content-Type", "application/json")],
        &serde_json::to_vec(
            &json!({"username":username,"password":"project test password long enough"}),
        )
        .unwrap(),
    );
    assert_eq!(response.status, 200, "{}", response.text());
    response.headers["set-cookie"]
        .split(';')
        .next()
        .unwrap()
        .into()
}

pub(super) fn request(
    client: &Client,
    cookie: &str,
    project: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Reply {
    client.request(
        method,
        path,
        &[
            ("Cookie", cookie),
            ("X-Notes-Project", project),
            ("Content-Type", "application/json"),
        ],
        &body
            .map(|body| serde_json::to_vec(&body).unwrap())
            .unwrap_or_default(),
    )
}

pub(super) fn users(workspace: &Workspace) -> UserStore {
    let users = UserStore::new(workspace.base.join("config/users.json"));
    users
        .initialize_admin("alice", "project test password long enough")
        .unwrap();
    users
        .add("bob", "project test password long enough", Role::User)
        .unwrap();
    users
}

#[test]
fn diagnostic_token_mode_explicitly_rejects_account_project_configuration() {
    let workspace = Workspace::new();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    client.api("GET", "/api/projects", None).error(403);
    client
        .api(
            "POST",
            "/api/projects",
            Some(json!({"action":"create","kind":"new","name":"Private"})),
        )
        .error(403);
}

#[test]
fn projects_are_private_by_default_and_shared_permissions_cover_every_endpoint() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Private\n");
    let users = users(&workspace);
    let mut server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let private = resource_id(&client, &alice, "default", "note.md", "document");
    let alice_projects = request(&client, &alice, "default", "GET", "/api/projects", None).json();
    assert_eq!(alice_projects[0]["shared"], "private");
    assert_eq!(alice_projects[0]["owner"], "alice");
    assert_eq!(
        request(&client, &bob, "default", "GET", "/api/projects", None).json(),
        json!([])
    );
    for path in [
        "/api/tree".to_owned(),
        format!("/api/document?id={private}"),
        format!("/api/entry?id={private}"),
        "/api/git".into(),
        format!("/api/git/diff?id={private}"),
        format!("/assets?id={private}"),
    ] {
        request(&client, &bob, "default", "GET", &path, None).error(403);
    }
    request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/collaboration/join",
        Some(json!({"document":private})),
    )
    .error(403);
    request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/preview",
        Some(json!({"id":private,"content":"# Probe"})),
    )
    .error(403);
    request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"create","name":"Forbidden","kind":"folder","source":workspace.outside
        })),
    )
    .error(403);
    let created = request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"create","name":"Personal","kind":"new"
        })),
    );
    assert_eq!(created.status, 200, "{}", created.text());
    let id = created.json()["id"].as_str().unwrap().to_owned();
    let root = PathBuf::from(created.json()["root"].as_str().unwrap());
    assert!(root.is_dir());
    request(&client, &alice, &id, "GET", "/api/tree", None).error(403);
    let document = request(
        &client,
        &bob,
        &id,
        "POST",
        "/api/document",
        Some(json!({"path":"note.md","content":"# Bob\n"})),
    );
    assert_eq!(document.status, 201);
    let note_id = document.json()["id"].as_str().unwrap().to_owned();
    let shared = request(
        &client,
        &bob,
        &id,
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":id,"shared":"read"})),
    );
    assert_eq!(shared.status, 200, "{}", shared.text());
    assert_eq!(
        request(
            &client,
            &alice,
            &id,
            "GET",
            &format!("/api/document?id={note_id}"),
            None
        )
        .json()["content"],
        "# Bob\n"
    );
    request(
        &client,
        &alice,
        &id,
        "PUT",
        "/api/document",
        Some(json!({
            "id":note_id,"content":"# Changed","version":document.json()["version"]
        })),
    )
    .error(403);
    request(
        &client,
        &alice,
        &id,
        "POST",
        "/api/directory",
        Some(json!({"path":"nested"})),
    )
    .error(403);
    request(
        &client,
        &alice,
        &id,
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":id,"shared":"edit"})),
    )
    .error(403);
    request(
        &client,
        &alice,
        &id,
        "POST",
        "/api/git",
        Some(json!({"action":"stage","ids":[note_id]})),
    )
    .error(403);
    request(
        &client,
        &bob,
        &id,
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":id,"shared":"edit"})),
    );
    assert_eq!(
        request(
            &client,
            &alice,
            &id,
            "PUT",
            "/api/document",
            Some(json!({
                "id":note_id,"content":"# Shared edit\n","version":document.json()["version"]
            }))
        )
        .status,
        200
    );
    assert_eq!(
        fs::read_to_string(workspace.root.join("note.md")).unwrap(),
        "# Private\n"
    );
    server.stop().unwrap();
    let restarted = start_with_users(&workspace.root, 0, users).unwrap();
    let client = Client::new(&restarted);
    assert_eq!(
        request(
            &client,
            &bob,
            &id,
            "GET",
            &format!("/api/document?id={note_id}"),
            None
        )
        .json()["content"],
        "# Shared edit\n"
    );
}

#[test]
fn independently_shared_pages_hide_siblings_git_and_unshared_attachments() {
    let workspace = Workspace::new();
    workspace.write(
        "folder/shared.md",
        "# Shared\n\n![Allowed](../images/allowed.png)\n",
    );
    workspace.write("folder/secret.md", "Top secret sibling");
    workspace.write("images/allowed.png", b"allowed");
    workspace.write("images/secret.png", b"private");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let shared_id = resource_id(&client, &alice, "default", "folder/shared.md", "document");
    let secret_id = resource_id(&client, &alice, "default", "folder/secret.md", "document");
    let allowed_asset = resource_id(&client, &alice, "default", "images/allowed.png", "asset");
    let secret_asset = resource_id(&client, &alice, "default", "images/secret.png", "asset");
    let folder = resource_id(&client, &alice, "default", "folder", "directory");
    let share = |level| {
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(json!({
                "action":"share","id":"default","document":shared_id,"shared":level
            })),
        )
    };
    assert_eq!(share("edit").status, 200);
    let tree = request(&client, &bob, "default", "GET", "/api/tree", None).json();
    assert_eq!(tree["files"].as_array().unwrap().len(), 1);
    assert_eq!(tree["files"][0]["path"], "folder/shared.md");
    assert_eq!(tree["root"], "default");
    assert_eq!(tree["directories"], json!([]));
    for path in [
        format!("/api/document?id={secret_id}"),
        format!("/api/entry?id={secret_id}"),
        "/api/git".into(),
        format!("/api/git/diff?id={secret_id}"),
        format!("/assets?id={secret_asset}&document={shared_id}"),
    ] {
        request(&client, &bob, "default", "GET", &path, None).error(403);
    }
    assert_eq!(
        request(
            &client,
            &bob,
            "default",
            "GET",
            &format!("/assets?id={allowed_asset}&document={shared_id}"),
            None
        )
        .body,
        b"allowed"
    );
    request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/document",
        Some(json!({"path":"new.md","content":"new"})),
    )
    .error(403);
    request(
        &client,
        &bob,
        "default",
        "PATCH",
        "/api/entry",
        Some(json!({"id":shared_id,"destination":"new.md"})),
    )
    .error(403);
    let doc = request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/api/document?id={shared_id}"),
        None,
    )
    .json();
    assert_eq!(
        request(
            &client,
            &bob,
            "default",
            "PUT",
            "/api/document",
            Some(json!({
                "id":shared_id,"version":doc["version"],"content":"![Probe](../images/secret.png)\n"
            }))
        )
        .status,
        200
    );
    request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/assets?id={secret_asset}&document={shared_id}"),
        None,
    )
    .error(403);
    let moved = request(
        &client,
        &alice,
        "default",
        "PATCH",
        "/api/entry",
        Some(json!({"id":folder,"destination":"renamed"})),
    );
    assert_eq!(moved.status, 200, "{}", moved.text());
    assert_eq!(
        request(
            &client,
            &bob,
            "default",
            "GET",
            &format!("/api/document?id={shared_id}"),
            None
        )
        .json()["path"],
        "renamed/shared.md"
    );
    assert_eq!(share("private").status, 200);
    request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/api/document?id={shared_id}"),
        None,
    )
    .error(403);
    request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/assets?id={allowed_asset}&document={shared_id}"),
        None,
    )
    .error(403);
}

pub(super) fn png() -> Vec<u8> {
    let mut output = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(2, 2, image::Rgba([1, 2, 3, 255]))
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    output.into_inner()
}

#[test]
fn resetting_a_password_preserves_project_ownership_but_recreating_a_username_does_not() {
    let workspace = Workspace::new();
    let users = users(&workspace);
    let server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let client = Client::new(&server);
    let bob = login(&client, "bob");
    let created = request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"create","kind":"new","name":"Private original owner"})),
    )
    .json();
    let id = created["id"].as_str().unwrap();
    users
        .set_password("bob", "project test password long enough")
        .unwrap();
    let reset = login(&client, "bob");
    assert_eq!(
        request(&client, &reset, id, "GET", "/api/tree", None).status,
        200
    );
    users.remove("bob").unwrap();
    users
        .add("bob", "project test password long enough", Role::User)
        .unwrap();
    let recreated = login(&client, "bob");
    request(&client, &recreated, id, "GET", "/api/tree", None).error(403);
    assert_eq!(
        request(&client, &recreated, "default", "GET", "/api/projects", None).json(),
        json!([])
    );
}

#[test]
#[ignore = "requires network access to a public GitHub fixture"]
fn github_project_clones_a_public_repository_and_can_commit_without_host_identity() {
    let workspace = Workspace::new();
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let bob = login(&client, "bob");
    let created = request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"create","kind":"github","name":"GitHub fixture","source":"octocat/Hello-World"
        })),
    );
    assert_eq!(created.status, 200, "{}", created.text());
    let project = created.json();
    assert!(project.get("token").is_none());
    let id = project["id"].as_str().unwrap();
    let root = PathBuf::from(project["root"].as_str().unwrap());
    assert!(root.join("README").exists());
    assert_eq!(
        request(
            &client,
            &bob,
            id,
            "POST",
            "/api/document",
            Some(json!({"path":"test.md","content":"# Local test\n"}))
        )
        .status,
        201
    );
    let document = resource_id(&client, &bob, id, "test.md", "document");
    for action in [
        json!({"action":"stage","ids":[document]}),
        json!({"action":"commit","message":"Local fixture commit"}),
    ] {
        let response = request(&client, &bob, id, "POST", "/api/git", Some(action));
        assert_eq!(response.status, 200, "{}", response.text());
    }
    assert!(
        fs::read_to_string(root.join(".git/config"))
            .unwrap()
            .contains("bob@notes.invalid")
    );
}

#[test]
fn image_uploads_validate_contents_honor_project_directories_and_grant_only_the_shared_page() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    workspace.write("other.md", "# Other\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    let other = resource_id(&client, &alice, "default", "other.md", "document");
    let configure = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"share","id":"default","shared":"private","imageDirectory":"media/pasted"
        })),
    );
    assert_eq!(configure.status, 200, "{}", configure.text());
    let upload = |cookie: &str, document: &str, mime: &str, data: &[u8]| {
        client.request(
            "POST",
            &format!("/api/images?document={document}"),
            &[
                ("Cookie", cookie),
                ("X-Notes-Project", "default"),
                ("Content-Type", mime),
            ],
            data,
        )
    };
    upload(&bob, &document, "image/png", &png()).error(403);
    upload(&alice, &document, "image/png", b"<svg/>").error(400);
    upload(&alice, &document, "image/jpeg", &png()).error(400);
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":"default","shared":"read","document":document})),
    );
    upload(&bob, &document, "image/png", &png()).error(403);
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":"default","shared":"edit","document":document})),
    );
    let uploaded = upload(&bob, &document, "image/png", &png());
    assert_eq!(uploaded.status, 200, "{}", uploaded.text());
    let path = uploaded.json()["path"].as_str().unwrap().to_owned();
    let asset = uploaded.json()["id"].as_str().unwrap().to_owned();
    assert!(path.starts_with("media/pasted/image-") && path.ends_with(".png"));
    assert_eq!(fs::read(workspace.root.join(&path)).unwrap(), png());
    assert_eq!(
        request(
            &client,
            &bob,
            "default",
            "GET",
            &format!("/assets?id={asset}&document={document}"),
            None
        )
        .body,
        png()
    );
    request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/assets?id={asset}&document={other}"),
        None,
    )
    .error(403);
    request(&client, &alice, "default", "POST", "/api/projects", Some(json!({"action":"share","id":"default","shared":"private","imageDirectory":"../outside"}))).error(403);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&workspace.outside, workspace.root.join("linked")).unwrap();
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(
                json!({"action":"share","id":"default","shared":"private","imageDirectory":"linked"}),
            ),
        );
        upload(&alice, &document, "image/png", &png()).error(403);
        assert_eq!(fs::read_dir(&workspace.outside).unwrap().count(), 0);
    }
}
