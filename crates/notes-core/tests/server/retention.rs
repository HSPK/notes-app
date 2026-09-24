use super::projects::{login, request, resource_id, users};
use super::*;

#[test]
fn expired_history_and_trash_cannot_be_restored_and_do_not_remove_current_markdown() {
    let workspace = Workspace::new();
    workspace.write("keep.md", "# Current\n");
    workspace.write("delete.md", "# Recycle\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let kept = resource_id(&client, &alice, "default", "keep.md", "document");
    let recycled = resource_id(&client, &alice, "default", "delete.md", "document");
    let history = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/history?document={kept}"),
        None,
    )
    .json();
    let revision = history["revisions"][0]["id"].as_i64().unwrap();
    let document = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={recycled}"),
        None,
    )
    .json();
    let deleted = request(
        &client,
        &alice,
        "default",
        "DELETE",
        "/api/document",
        Some(json!({"id":recycled,"version":document["version"]})),
    )
    .json();
    let directory = fs::read_dir(workspace.base.join("config"))
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            entry.file_type().unwrap().is_dir()
                && entry.file_name().to_string_lossy().starts_with("projects-")
        })
        .unwrap();
    let database =
        rusqlite::Connection::open(directory.path().join(".state/workspace.sqlite")).unwrap();
    let old = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        - 31 * 24 * 60 * 60 * 1000;
    database
        .execute("UPDATE revisions SET created=?1", [old])
        .unwrap();
    database
        .execute("UPDATE trash SET deleted=?1", [old])
        .unwrap();
    request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/history/content?document={kept}&revision={revision}"),
        None,
    )
    .error(400);
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/trash/restore",
        Some(json!({"id":deleted["id"]})),
    )
    .error(400);
    assert_eq!(
        request(&client, &alice, "default", "GET", "/api/trash", None).json(),
        json!([])
    );
    assert_eq!(
        fs::read_to_string(workspace.root.join("keep.md")).unwrap(),
        "# Current\n"
    );
    let fresh = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/history?document={kept}"),
        None,
    )
    .json();
    assert_ne!(fresh["revisions"][0]["id"].as_i64().unwrap(), revision);
}
