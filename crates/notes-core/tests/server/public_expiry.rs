use super::projects::{login, request, resource_id, users};
use super::public_sharing::public;
use super::*;

#[test]
fn public_link_expiration_is_enforced_and_missing_documents_can_still_be_revoked() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"document","id":"default","document":document,"permission":"publicRead",
            "publicOptions":{"expiresAt":1}
        })),
    )
    .error(400);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let created = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"document","id":"default","document":document,"permission":"publicRead",
            "publicOptions":{"expiresAt":now+86400000}
        })),
    );
    assert_eq!(created.status, 200, "{}", created.text());
    let token = created.json()["publicLinks"]["note.md"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        public(
            &client,
            &token,
            "GET",
            &format!("/api/public/document?id={document}"),
            None
        )
        .status,
        200
    );
    let catalog = fs::read_dir(workspace.base.join("config"))
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            entry.file_name().to_string_lossy().starts_with("projects-")
                && entry.path().extension().is_some_and(|ext| ext == "json")
        })
        .unwrap()
        .path();
    let mut stored: Value = serde_json::from_slice(&fs::read(&catalog).unwrap()).unwrap();
    stored["projects"]["default"]["publicLinks"]["note.md"]["expiresAt"] = json!(1);
    fs::write(&catalog, serde_json::to_vec_pretty(&stored).unwrap()).unwrap();
    let denied = public(
        &client,
        &token,
        "GET",
        &format!("/api/public/document?id={document}"),
        None,
    );
    denied.error(403);
    assert!(denied.text().contains("expired"));
    fs::remove_file(workspace.root.join("note.md")).unwrap();
    let revoked = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"revokePublic","id":"default","document":document})),
    );
    assert_eq!(revoked.status, 200, "{}", revoked.text());
    assert_eq!(
        request(&client, &alice, "default", "GET", "/api/shares", None).json(),
        json!([])
    );
}
