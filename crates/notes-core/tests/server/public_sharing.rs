use super::projects::{login, png, request, resource_id, users};
use super::*;

fn permission(client: &Client, cookie: &str, path: &str, permission: &str, reset: bool) -> Value {
    let projects = request(client, cookie, "default", "GET", "/api/projects", None).json();
    let known = projects
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["id"] == "default")
        .and_then(|project| project["documentIds"][path].as_str())
        .map(str::to_owned);
    let document =
        known.unwrap_or_else(|| resource_id(client, cookie, "default", path, "document"));
    let response = request(
        client,
        cookie,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"document","id":"default","document":document,"permission":permission,"resetLink":reset
        })),
    );
    assert_eq!(response.status, 200, "{}", response.text());
    response.json()
}

pub(super) fn public(
    client: &Client,
    token: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Reply {
    client.request(
        method,
        path,
        &[
            ("X-Notes-Share", token),
            ("Content-Type", "application/json"),
        ],
        &body
            .map(|body| serde_json::to_vec(&body).unwrap())
            .unwrap_or_default(),
    )
}

#[test]
fn public_session_source_validation_preserves_rendering_and_rejects_changed_invalid_files() {
    let workspace = Workspace::new();
    workspace.write("shared.md", "---\ntitle: Published\n---\n# Body\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let shared = permission(&client, &alice, "shared.md", "publicRead", false);
    let token = shared["publicLinks"]["shared.md"]["token"]
        .as_str()
        .unwrap();
    let document = shared["publicLinks"]["shared.md"]["document"]
        .as_str()
        .unwrap();
    let session = || public(&client, token, "POST", "/api/public/session", None);
    assert_eq!(session().status, 200);
    let doc = public(
        &client,
        token,
        "GET",
        &format!("/api/public/document?id={document}"),
        None,
    )
    .json();
    assert!(
        doc["html"]
            .as_str()
            .unwrap()
            .contains("<h1 id=\"body\">Body</h1>")
    );
    assert_eq!(session().status, 200);
    workspace.write("shared.md", b"changed\0binary");
    session().error(400);
    workspace.write("shared.md", [0xff]);
    session().error(400);
    fs::remove_file(workspace.root.join("shared.md")).unwrap();
    session().error(404);
}

#[test]
fn document_overrides_restrict_shared_projects_and_restore_inheritance() {
    let workspace = Workspace::new();
    workspace.write(
        "private/INDEX.MD",
        "---\ntitle: Confidential title\n---\n![Secret](../secret.png)\n",
    );
    workspace.write("readonly.md", "# Read only\n");
    workspace.write("open.md", "# Open\n");
    workspace.write("secret.png", png());
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let private = resource_id(&client, &alice, "default", "private/INDEX.MD", "document");
    let readonly = resource_id(&client, &alice, "default", "readonly.md", "document");
    let open = resource_id(&client, &alice, "default", "open.md", "document");
    let secret = resource_id(&client, &alice, "default", "secret.png", "asset");
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(json!({"action":"share","id":"default","shared":"edit"}))
        )
        .status,
        200
    );
    permission(&client, &alice, "private/INDEX.MD", "private", false);
    permission(&client, &alice, "readonly.md", "read", false);
    let tree = request(&client, &bob, "default", "GET", "/api/tree", None);
    assert!(
        !tree.text().contains("INDEX.MD") && !tree.text().contains("Confidential title"),
        "{}",
        tree.text()
    );
    let summary = request(&client, &bob, "default", "GET", "/api/projects", None);
    assert!(!summary.text().contains("INDEX.MD"));
    assert_eq!(summary.json()[0]["gitAvailable"], false);
    for path in [
        format!("/api/document?id={private}"),
        format!("/api/entry?id={private}"),
        format!("/assets?id={secret}&document={open}"),
        "/api/git".into(),
        format!("/api/git/diff?id={private}"),
    ] {
        request(&client, &bob, "default", "GET", &path, None).error(403);
    }
    let doc = request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/api/document?id={readonly}"),
        None,
    )
    .json();
    request(
        &client,
        &bob,
        "default",
        "PUT",
        "/api/document",
        Some(json!({"id":readonly,"version":doc["version"],"content":"Denied"})),
    )
    .error(403);
    request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/preview",
        Some(json!({"id":private,"content":"Denied"})),
    )
    .error(403);
    permission(&client, &alice, "private/INDEX.MD", "inherit", false);
    permission(&client, &alice, "readonly.md", "inherit", false);
    assert_eq!(
        request(&client, &bob, "default", "GET", "/api/git", None).status,
        200
    );
    assert_eq!(
        request(
            &client,
            &bob,
            "default",
            "PUT",
            "/api/document",
            Some(json!({"id":readonly,"version":doc["version"],"content":"Allowed"}))
        )
        .status,
        200
    );
}

#[test]
fn public_links_are_document_scoped_revocable_and_readonly_until_explicitly_enabled() {
    let workspace = Workspace::new();
    workspace.write("shared.md", "# Shared\n\n![Image](public.png)\n");
    workspace.write("secret.md", "# Private sibling\n");
    workspace.write("public.png", png());
    workspace.write("secret.png", png());
    let store = users(&workspace);
    let mut server = start_with_users(&workspace.root, 0, store.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document = resource_id(&client, &alice, "default", "shared.md", "document");
    let secret = resource_id(&client, &alice, "default", "secret.md", "document");
    let image = resource_id(&client, &alice, "default", "public.png", "asset");
    let private_image = resource_id(&client, &alice, "default", "secret.png", "asset");
    let project = permission(&client, &alice, "shared.md", "publicRead", false);
    let token = project["publicLinks"]["shared.md"]["token"]
        .as_str()
        .unwrap();
    assert_eq!(token.len(), 64);
    assert!(
        !request(&client, &bob, "default", "GET", "/api/projects", None)
            .text()
            .contains(token)
    );
    let session = public(&client, token, "POST", "/api/public/session", None);
    assert_eq!(
        session.json(),
        json!({"id":document,"project":"default","path":"shared.md","writable":false})
    );
    let doc = public(
        &client,
        token,
        "GET",
        &format!("/api/public/document?id={document}"),
        None,
    )
    .json();
    assert_eq!(doc["content"], "# Shared\n\n![Image](public.png)\n");
    public(
        &client,
        "bad",
        "GET",
        &format!("/api/public/document?id={document}"),
        None,
    )
    .error(403);
    for path in [
        format!("/api/public/document?id={secret}"),
        format!("/api/public/assets?id={private_image}&document={document}"),
    ] {
        public(&client, token, "GET", &path, None).error(403);
    }
    public(
        &client,
        token,
        "GET",
        "/api/public/document?id=../secret.md",
        None,
    )
    .error(400);
    public(
        &client,
        token,
        "GET",
        &format!("/api/public/assets?id={secret}&document={document}"),
        None,
    )
    .error(400);

    for path in [
        "/api/tree",
        "/api/projects",
        "/api/git",
        "/api/admin/accounts",
        "/api/public/tree",
    ] {
        public(&client, token, "GET", path, None).error(401);
    }
    assert_eq!(
        public(
            &client,
            token,
            "GET",
            &format!("/api/public/assets?id={image}&document={document}"),
            None
        )
        .body,
        png()
    );
    public(
        &client,
        token,
        "PUT",
        "/api/public/document",
        Some(json!({"id":document,"version":doc["version"],"content":"Denied"})),
    )
    .error(403);
    public(
        &client,
        token,
        "POST",
        "/api/public/collaboration/join",
        Some(json!({"document":secret})),
    )
    .error(403);
    let enabled = permission(&client, &alice, "shared.md", "publicEdit", false);
    assert_eq!(enabled["publicLinks"]["shared.md"]["token"], token);
    let saved = public(
        &client,
        token,
        "PUT",
        "/api/public/document",
        Some(json!({
            "id":document,"version":doc["version"],"content":"# Anonymous edit\n"
        })),
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    let upload = client.request(
        "POST",
        &format!("/api/public/images?document={document}"),
        &[("X-Notes-Share", token), ("Content-Type", "image/png")],
        &png(),
    );
    assert_eq!(upload.status, 200, "{}", upload.text());
    let image = upload.json()["id"].as_str().unwrap().to_owned();
    assert_eq!(
        public(
            &client,
            token,
            "GET",
            &format!("/api/public/assets?id={image}&document={document}"),
            None
        )
        .body,
        png()
    );
    permission(&client, &alice, "shared.md", "publicRead", false);
    client
        .request(
            "POST",
            &format!("/api/public/images?document={document}"),
            &[("X-Notes-Share", token), ("Content-Type", "image/png")],
            &png(),
        )
        .error(403);
    let rotated = permission(&client, &alice, "shared.md", "publicRead", true);
    let replacement = rotated["publicLinks"]["shared.md"]["token"]
        .as_str()
        .unwrap();
    assert_ne!(replacement, token);
    public(&client, token, "POST", "/api/public/session", None).error(403);
    server.stop().unwrap();
    let restarted = start_with_users(&workspace.root, 0, store).unwrap();
    let client = Client::new(&restarted);
    assert_eq!(
        public(&client, replacement, "POST", "/api/public/session", None).status,
        200
    );
    assert_eq!(
        fs::read_to_string(workspace.root.join("shared.md")).unwrap(),
        "# Anonymous edit\n"
    );
    fs::remove_file(workspace.root.join("shared.md")).unwrap();
    permission(&client, &alice, "shared.md", "private", false);
    public(
        &client,
        replacement,
        "GET",
        &format!("/api/public/document?id={document}"),
        None,
    )
    .error(403);
    workspace.write("shared.md", "# Different contents at the old shared path\n");
    public(
        &client,
        replacement,
        "GET",
        &format!("/api/public/document?id={document}"),
        None,
    )
    .error(403);
}
