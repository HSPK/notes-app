use super::projects::{login, request, resource_id, users};
use super::*;

#[test]
fn history_restores_exact_bytes_and_trash_restore_never_reopens_old_public_links() {
    let workspace = Workspace::new();
    let original = "\u{feff}---\r\ntags: [notes]\r\n---\r\n\r\n# Original 中文\r\n";
    workspace.write("note.md", original);
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document_id = resource_id(&client, &alice, "default", "note.md", "document");
    let first = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={document_id}"),
        None,
    )
    .json();
    let saved = request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/document",
        Some(json!({"id":document_id,"content":"# Edited\n","version":first["version"]})),
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    let history = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/history?document={document_id}"),
        None,
    )
    .json();
    assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
    let old = &history["revisions"][1];
    let snapshot = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!(
            "/api/history/content?document={document_id}&revision={}",
            old["id"]
        ),
        None,
    );
    assert_eq!(snapshot.json()["content"], original);
    workspace.write("note.md", "# External LF without BOM\n");
    let current = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={document_id}"),
        None,
    )
    .json();
    let restored = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/history/restore",
        Some(json!({"document":document_id,"revision":old["id"],"version":current["version"]})),
    );
    assert_eq!(restored.status, 200, "{}", restored.text());
    assert_eq!(
        fs::read(workspace.root.join("note.md")).unwrap(),
        original.as_bytes()
    );
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"share","id":"default","shared":"edit"})),
    );
    request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/api/history?document={document_id}"),
        None,
    )
    .error(403);
    let public = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(
            json!({"action":"document","id":"default","document":document_id,"permission":"publicEdit"}),
        ),
    )
    .json();
    let token = public["publicLinks"]["note.md"]["token"].as_str().unwrap();
    let deleted = request(
        &client,
        &alice,
        "default",
        "DELETE",
        "/api/document",
        Some(json!({"id":document_id,"version":restored.json()["version"]})),
    );
    assert_eq!(deleted.status, 200, "{}", deleted.text());
    assert!(!workspace.root.join("note.md").exists());
    let trash = request(&client, &alice, "default", "GET", "/api/trash", None).json();
    assert_eq!(trash.as_array().unwrap().len(), 1);
    request(&client, &bob, "default", "GET", "/api/trash", None).error(403);
    let recovered = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/trash/restore",
        Some(json!({"id":trash[0]["id"]})),
    );
    assert_eq!(recovered.status, 200, "{}", recovered.text());
    assert_eq!(
        fs::read(workspace.root.join("note.md")).unwrap(),
        original.as_bytes()
    );
    client
        .request(
            "POST",
            "/api/public/session",
            &[("X-Notes-Share", token)],
            b"",
        )
        .error(403);
    request(
        &client,
        &bob,
        "default",
        "GET",
        &format!("/api/document?id={document_id}"),
        None,
    )
    .error(403);
}

#[test]
fn history_retains_at_most_one_hundred_versions_and_restoring_trash_never_overwrites() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Start\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document_id = resource_id(&client, &alice, "default", "note.md", "document");
    let mut document = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={document_id}"),
        None,
    )
    .json();
    for index in 0..105 {
        let reply = request(
            &client,
            &alice,
            "default",
            "PUT",
            "/api/document",
            Some(
                json!({"id":document_id,"content":format!("# Version {index}\n"),"version":document["version"]}),
            ),
        );
        assert_eq!(reply.status, 200, "{}", reply.text());
        document = reply.json();
    }
    let revisions = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/history?document={document_id}"),
        None,
    )
    .json();
    assert_eq!(revisions["revisions"].as_array().unwrap().len(), 100);
    let versions = revisions["revisions"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["version"].as_str().unwrap())
        .collect::<std::collections::HashSet<_>>();
    assert_eq!(versions.len(), 100);
    let deleted = request(
        &client,
        &alice,
        "default",
        "DELETE",
        "/api/document",
        Some(json!({"id":document_id,"version":document["version"]})),
    )
    .json();
    workspace.write("note.md", "# A replacement\n");
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/trash/restore",
        Some(json!({"id":deleted["id"]})),
    )
    .error(409);
    assert_eq!(
        fs::read_to_string(workspace.root.join("note.md")).unwrap(),
        "# A replacement\n"
    );
    assert_eq!(
        request(&client, &alice, "default", "GET", "/api/trash", None)
            .json()
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
