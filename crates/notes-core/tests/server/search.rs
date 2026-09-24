use super::projects::{login, request, resource_id, users};
use super::*;

#[test]
fn unchanged_workspaces_keep_the_revision_without_committing_database_writes() {
    let workspace = Workspace::new();
    workspace.write("note.md", "---\ntitle: First\n---\n# Note\n");
    workspace.write("other.md", "# Other\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let ids = ["note.md", "other.md"]
        .map(|path| {
            (
                path,
                resource_id(&client, &alice, "default", path, "document"),
            )
        })
        .into_iter()
        .collect::<HashMap<_, _>>();
    let post = |action, path: &str, value: Option<bool>| {
        let mut body = json!({"action":action,"project":"default","id":ids[path]});
        if let Some(value) = value {
            body["value"] = json!(value);
        }
        let response = request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/workspace",
            Some(body),
        );
        assert_eq!(response.status, 200, "{}", response.text());
        response.json()
    };
    let mut state = post("visit", "note.md", None);
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
    let data_version = || {
        database
            .query_row("PRAGMA data_version", [], |row| row.get::<_, i64>(0))
            .unwrap()
    };
    let unchanged = |action, path, value, expected: &Value| {
        let before = data_version();
        let result = post(action, path, value);
        assert_eq!(&result, expected);
        assert_eq!(data_version(), before);
    };
    unchanged("visit", "note.md", None, &state);
    unchanged("favorite", "other.md", Some(false), &state);
    let favorite = post("favorite", "note.md", Some(true));
    assert!(favorite["revision"].as_i64().unwrap() > state["revision"].as_i64().unwrap());
    state = favorite;
    unchanged("favorite", "note.md", Some(true), &state);
    post("favorite", "other.md", Some(true));
    state = post("favorite", "note.md", Some(true));
    assert_eq!(state["workspace"]["favorites"][0]["path"], "other.md");
    assert_eq!(state["workspace"]["favorites"][1]["path"], "note.md");
    unchanged("favorite", "note.md", Some(true), &state);
    let moved = post("visit", "other.md", None);
    assert!(moved["revision"].as_i64().unwrap() > state["revision"].as_i64().unwrap());
    assert_eq!(moved["workspace"]["recent"][0]["path"], "other.md");
    workspace.write("note.md", "---\ntitle: Updated title\n---\n# Note\n");
    state = post("visit", "note.md", None);
    assert_eq!(state["workspace"]["recent"][0]["title"], "Updated title");
    assert_eq!(state["workspace"]["favorites"][1]["title"], "Updated title");
    unchanged("visit", "note.md", None, &state);
    state = post("pin", "note.md", Some(true));
    unchanged("pin", "note.md", Some(true), &state);
    state = post("close", "note.md", None);
    unchanged("close", "note.md", None, &state);
}

#[test]
fn unchanged_workspace_requests_still_require_current_document_access() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(json!({"action":"share","id":"default","shared":"read"}))
        )
        .status,
        200
    );
    let action = json!({"action":"favorite","project":"default","id":document,"value":true});
    assert_eq!(
        request(
            &client,
            &bob,
            "default",
            "POST",
            "/api/workspace",
            Some(action.clone())
        )
        .status,
        200
    );
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(json!({"action":"share","id":"default","shared":"private"}))
        )
        .status,
        200
    );
    request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/workspace",
        Some(action),
    )
    .error(403);
}

#[test]
fn lazy_search_sources_preserve_fields_offsets_and_permission_filtered_facets_past_the_result_limit()
 {
    let workspace = Workspace::new();
    for index in 0..160 {
        workspace.write(&format!("Bench{index:04}.md"), format!(
            "---\ntitle: Atlas {index}\ntags: [common, group-{}]\ntopic: metamarker{index}\n---\n\n# Body\n\n{}bodymarker{index}\n",
            index % 8, "Text to index.\n".repeat(100),
        ));
    }
    workspace.write(
        "Hidden/skip.md",
        "---\ntags: [hidden-facet]\n---\nHidden text\n",
    );
    workspace.write(
        "private.md",
        "---\ntags: [private-facet]\n---\nPrivate text\n",
    );
    let unicode = "\u{feff}---\r\ntitle: Atlas 0\r\ntags: [common, group-0]\r\n---\r\n\r\n# 😀İstanbul\r\n中文 bodymarker0\r\n";
    workspace.write("Bench0000.md", unicode);
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let private = resource_id(&client, &alice, "default", "private.md", "document");
    for body in [
        json!({"action":"share","id":"default","shared":"read"}),
        json!({"action":"document","id":"default","document":private,"permission":"private"}),
    ] {
        assert_eq!(
            request(
                &client,
                &alice,
                "default",
                "POST",
                "/api/projects",
                Some(body)
            )
            .status,
            200
        );
    }
    let mut preferences =
        request(&client, &alice, "default", "GET", "/api/preferences", None).json();
    preferences["web"]["hiddenPatterns"] = json!(["Hidden/**"]);
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "PUT",
            "/api/preferences",
            Some(preferences)
        )
        .status,
        200
    );
    let all = search(&client, &bob, json!({"query":"","refresh":true}));
    assert_eq!(all["results"].as_array().unwrap().len(), 100);
    assert_eq!(all["truncated"], true);
    assert!(
        all["tags"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tag| tag["tag"] == "common" && tag["count"] == 160)
    );
    assert!(!all.to_string().contains("private-facet"));
    assert!(!all.to_string().contains("hidden-facet"));
    for (query, field, expected) in [
        ("Atlas", "title", 100),
        ("bodymarker159", "body", 1),
        ("metamarker157", "metadata", 1),
        ("Atlas bodymarker158", "all", 1),
        ("bodymarker159", "title", 0),
        ("metamarker157", "body", 0),
    ] {
        let found = search(&client, &bob, json!({"query":query,"field":field}));
        assert_eq!(
            found["results"].as_array().unwrap().len(),
            expected,
            "{query}: {found}"
        );
    }
    let source = unicode.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let found = search(&client, &bob, json!({"query":"stanb","field":"body"}));
    let hit = &found["results"][0];
    assert_eq!(hit["path"], "Bench0000.md");
    assert!(hit["snippet"].as_str().unwrap().contains("😀İstanbul"));
    let expected = source[..source.find("stanb").unwrap()]
        .encode_utf16()
        .count();
    assert_eq!(hit["offset"], expected);
    let selected = search(&client, &bob, json!({"tags":["group-7"]}));
    assert_eq!(selected["results"].as_array().unwrap().len(), 20);
}

fn search(client: &Client, cookie: &str, mut body: Value) -> Value {
    for _ in 0..30 {
        let reply = request(
            client,
            cookie,
            "default",
            "POST",
            "/api/search",
            Some(body.clone()),
        );
        assert_eq!(reply.status, 200, "{}", reply.text());
        let result = reply.json();
        if result["indexing"] == false {
            return result;
        }
        body["cursor"] = result["cursor"].clone();
        body["refresh"] = json!(false);
    }
    panic!("Search indexing did not finish");
}

#[test]
fn full_text_search_and_tag_facets_filter_private_documents_and_update_after_edits() {
    let workspace = Workspace::new();
    workspace.write(
        "notes.md",
        "---\ntitle: Algorithms\ntags: [Rust, 中文]\n---\n# Notes\n中文算法 searchable body\n",
    );
    workspace.write("other.md", "---\ntag: linux\n---\n# Commands\n");
    workspace.write(
        "private.md",
        "---\ntags: [confidential]\n---\nClassifiedNeedle\n",
    );
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let private = resource_id(&client, &alice, "default", "private.md", "document");
    let document = resource_id(&client, &alice, "default", "notes.md", "document");
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
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"document","id":"default","document":private,"permission":"private"})),
    );
    let visible = search(&client, &bob, json!({"query":"","refresh":true}));
    assert_eq!(visible["results"].as_array().unwrap().len(), 2);
    assert!(!visible.to_string().contains("ClassifiedNeedle"));
    assert!(!visible.to_string().contains("confidential"));
    let chinese = search(&client, &bob, json!({"query":"算法","tags":["rust"]}));
    assert_eq!(chinese["results"][0]["path"], "notes.md");
    assert_eq!(
        search(&client, &bob, json!({"query":"ClassifiedNeedle"}))["results"],
        json!([])
    );
    assert_eq!(
        search(&client, &alice, json!({"query":"ClassifiedNeedle"}))["results"][0]["path"],
        "private.md"
    );
    assert_eq!(
        search(&client, &bob, json!({"query":"linux","field":"metadata"}))["results"][0]["path"],
        "other.md"
    );
    let before = request(
        &client,
        &alice,
        "default",
        "GET",
        &format!("/api/document?id={document}"),
        None,
    )
    .json();
    let saved = request(
        &client,
        &alice,
        "default",
        "PUT",
        "/api/document",
        Some(json!({
            "id":document,"content":"---\ntitle: Algorithms\ntags: [Go]\n---\nUpdated searchable body\n","version":before["version"]
        })),
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    assert_eq!(
        search(&client, &bob, json!({"tags":["rust"]}))["results"],
        json!([])
    );
    assert_eq!(
        search(&client, &bob, json!({"tags":["go"]}))["results"][0]["path"],
        "notes.md"
    );
    let personal = request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/projects",
        Some(json!({"action":"create","kind":"new","name":"Bob only"})),
    )
    .json();
    let id = personal["id"].as_str().unwrap();
    request(
        &client,
        &bob,
        id,
        "POST",
        "/api/document",
        Some(json!({"path":"mine.md","content":"OnlyBobNeedle\n"})),
    );
    assert_eq!(
        search(
            &client,
            &bob,
            json!({"query":"OnlyBobNeedle","refresh":true})
        )["results"][0]["project"],
        id
    );
    assert_eq!(
        search(&client, &alice, json!({"query":"OnlyBobNeedle"}))["results"],
        json!([])
    );
}

#[test]
fn workspaces_and_recovery_keys_belong_to_the_authenticated_account() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    let status =
        |cookie: &str| request(&client, cookie, "default", "GET", "/api/auth/status", None).json();
    let first = status(&alice);
    assert_eq!(first["draftKey"].as_str().unwrap().len(), 64);
    assert_eq!(first["draftKey"], status(&alice)["draftKey"]);
    assert_ne!(first["draftKey"], status(&bob)["draftKey"]);
    for action in [
        json!({"action":"visit","project":"default","id":document}),
        json!({"action":"favorite","project":"default","id":document,"value":true}),
        json!({"action":"pin","project":"default","id":document,"value":true}),
    ] {
        let response = request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/workspace",
            Some(action),
        );
        assert_eq!(response.status, 200, "{}", response.text());
    }

    let saved = request(&client, &alice, "default", "GET", "/api/workspace", None).json();
    assert_eq!(saved["workspace"]["favorites"].as_array().unwrap().len(), 1);
    assert_eq!(saved["workspace"]["tabs"][0]["pinned"], true);
    assert_eq!(
        request(&client, &bob, "default", "GET", "/api/workspace", None).json()["workspace"]["tabs"],
        json!([])
    );
    request(
        &client,
        &bob,
        "default",
        "POST",
        "/api/workspace",
        Some(json!({"action":"visit","project":"default","id":document})),
    )
    .error(403);
    client
        .request(
            "POST",
            "/api/workspace",
            &[
                ("Cookie", &alice),
                ("X-Notes-User", status(&bob)["id"].as_str().unwrap()),
                ("Content-Type", "application/json"),
            ],
            &serde_json::to_vec(&json!({"action":"close","project":"default","id":document}))
                .unwrap(),
        )
        .error(403);
}

#[test]
fn recent_visits_do_not_create_tabs_or_hit_the_legacy_tab_limit() {
    let workspace = Workspace::new();
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    for index in 0..132 {
        let path = format!("note-{index}.md");
        workspace.write(&path, format!("---\ntitle: Note {index}\n---\n# Body\n"));
        let document = resource_id(&client, &alice, "default", &path, "document");
        let reply = request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/workspace",
            Some(json!({"action":"visit","project":"default","id":document})),
        );
        assert_eq!(reply.status, 200, "{}", reply.text());
    }
    let saved = request(&client, &alice, "default", "GET", "/api/workspace", None).json();
    assert_eq!(saved["workspace"]["tabs"], json!([]));
    assert_eq!(saved["workspace"]["recent"].as_array().unwrap().len(), 100);
    assert_eq!(saved["workspace"]["recent"][0]["title"], "Note 131");
    assert_eq!(saved["workspace"]["recent"][99]["path"], "note-32.md");
}

#[test]
fn workspace_titles_refresh_from_validated_source_without_rendering_the_body() {
    let workspace = Workspace::new();
    workspace.write(
        "note.md",
        format!("---\ntitle: First\n---\n{}", "# Body\n".repeat(20_000)),
    );
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    let visit = || {
        request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/workspace",
            Some(json!({"action":"visit","project":"default","id":document})),
        )
    };
    assert_eq!(visit().json()["workspace"]["recent"][0]["title"], "First");
    workspace.write(
        "note.md",
        "\u{feff}---\r\ntitle: Changed\r\n---\r\n# Body\r\n",
    );
    assert_eq!(visit().json()["workspace"]["recent"][0]["title"], "Changed");
    workspace.write("note.md", b"---\ntitle: Invalid\n---\n\0");
    visit().error(400);
    workspace.write("note.md", [0xff]);
    visit().error(400);
    fs::remove_file(workspace.root.join("note.md")).unwrap();
    visit().error(404);
}
