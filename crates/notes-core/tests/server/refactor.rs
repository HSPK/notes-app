use super::projects::{login, request, resource_id, users};
use super::*;

#[test]
fn renaming_a_note_updates_wiki_markdown_and_reference_links_and_keeps_history() {
    let workspace = Workspace::new();
    workspace.write("Old.md", "# Old\n");
    workspace.write("source.md","---\ntitle: Keep\n---\n[[Old|Alias]] [link](Old.md \"same\") [ref][id]\n\n[id]: Old.md\n`[[Old]]`\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document = resource_id(&client, &alice, "default", "Old.md", "document");
    let before = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={document}"),
        None,
    )
    .json();
    request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/document",
        Some(json!({"id":document,"content":"# New contents\n","version":before["version"]})),
    );
    let moved = request(
        &client,
        &alice,
        "default",
        "PATCH",
        "/api/entry",
        Some(json!({"id":document,"destination":"New.md"})),
    );
    assert_eq!(moved.status, 200, "{}", moved.text());
    assert_eq!(moved.json()["referencesUpdated"], 1);
    let source = fs::read_to_string(workspace.root.join("source.md")).unwrap();
    assert!(
        source.contains("[[New.md|Alias]]")
            && source.contains("[link](New.md \"same\")")
            && source.contains("[id]: New.md")
    );
    assert!(source.contains("`[[Old]]`"));
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "GET",
            &format!("/api/history?document={document}"),
            None
        )
        .json()["revisions"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let refs = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/backlinks?document={document}"),
        None,
    )
    .json();
    assert_eq!(refs[0]["path"], "source.md");
}
