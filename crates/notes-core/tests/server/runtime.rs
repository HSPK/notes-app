use super::*;

#[test]
fn traversal_and_reserved_paths_cannot_access_or_create_outside_root() {
    let workspace = Workspace::new();
    fs::write(workspace.outside.join("secret.md"), "secret outside").unwrap();
    workspace.write("safe.md", "safe");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let cookie = client.session_cookie();
    for path in [
        "../outside/secret.md",
        r"..\outside\secret.md",
        "/outside/secret.md",
        "C:/outside/secret.md",
        r"\\?\C:\outside\secret.md",
        "safe.md:stream",
        ".git/private.md",
        "node_modules/note.md",
        "a/../safe.md",
        "%2e%2e%2foutside%2fsecret.md",
        "%252e%252e%255coutside%255csecret.md",
        "NUL.md",
        "a./note.md",
    ] {
        client.get_document(path).error(403);
        client.resolve_resource(path, "asset").error(403);
        client
            .api(
                "POST",
                "/api/document",
                Some(json!({"path": path, "content": "bad"})),
            )
            .error(403);
        client
            .request(
                "GET",
                &format!("/assets?path={}", encode(path)),
                &[("Cookie", &cookie)],
                b"",
            )
            .error(400);
    }
    assert_eq!(
        fs::read_to_string(workspace.outside.join("secret.md")).unwrap(),
        "secret outside"
    );
    client.get_document("missing.md").error(404);
    client.api("GET", "/api/document", None).error(400);
}

#[test]
fn previews_are_sanitized_and_resolve_links_for_unsaved_documents() {
    let workspace = Workspace::new();
    workspace.write("guides/new.md", "");
    workspace.write("new.md", "");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let nested_id = client.resource_id("guides/new.md", "document");
    let root_id = client.resource_id("new.md", "document");
    let reply = client.api("POST", "/api/preview", Some(json!({
        "id": nested_id,
        "content": "# Hello\n\n<script>bad()</script>\n\n[home](../README.md#hello)\n\n![pic](../images/a.png)\n\n~~old~~\n\n- [x] done",
    })));
    assert_eq!(reply.status, 200, "{}", reply.text());
    let body = reply.json();
    let html = body["html"].as_str().unwrap();
    assert!(html.contains("<h1 id=\"hello\">"));
    assert!(html.contains("&lt;script&gt;"));
    assert!(!html.contains("<script>"));
    let references = body["references"].as_array().unwrap();
    let home = references
        .iter()
        .find(|item| item["source"] == "README.md")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    let image = references
        .iter()
        .find(|item| item["source"] == "images/a.png")
        .unwrap()["id"]
        .as_str()
        .unwrap();
    assert!(html.contains(&format!("href=\"/?document={home}#hello\"")));
    assert!(html.contains(&format!(
        "src=\"/assets?id={image}&amp;document={nested_id}\""
    )));
    assert!(html.contains("<del>old</del>"));
    assert_eq!(fs::read(workspace.root.join("guides/new.md")).unwrap(), b"");

    let changed = client.api(
        "POST",
        "/api/preview",
        Some(json!({"id": nested_id, "content": "# Changed"})),
    );
    assert!(
        changed.json()["html"]
            .as_str()
            .unwrap()
            .contains("id=\"changed\"")
    );

    let source = "[next](next.md)";
    let root_preview = client.api(
        "POST",
        "/api/preview",
        Some(json!({"id": root_id, "content": source})),
    );
    let nested_preview = client.api(
        "POST",
        "/api/preview",
        Some(json!({"id": nested_id, "content": source})),
    );
    assert_eq!(root_preview.json()["references"][0]["source"], "next.md");
    assert_eq!(
        nested_preview.json()["references"][0]["source"],
        "guides/next.md"
    );
    assert_ne!(
        root_preview.json()["references"][0]["id"],
        nested_preview.json()["references"][0]["id"]
    );
}

#[test]
fn mkdocs_frontmatter_is_preserved_in_documents_but_not_rendered_as_body() {
    let workspace = Workspace::new();
    let header = "---\r\n# Keep metadata comments\r\n\
title: 'Metadata title'\r\n\
description: >-\r\n  A longer description.\r\n\
tags: [notes, writing]\r\n\
custom:\r\n  enabled: true\r\n...\r\n\r\n";
    let original = format!("{header}# Real heading\r\n\r\nOriginal paragraph.\r\n");
    workspace.write("notes.md", format!("\u{feff}{original}"));
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let document = client.get_document("notes.md").json();
    assert_eq!(document["content"], original);
    let html = document["html"].as_str().unwrap();
    assert!(html.contains("<h1 id=\"real-heading\">Real heading</h1>"));
    assert!(!html.contains("Metadata title"));
    assert!(!html.contains("Keep metadata comments"));
    assert!(!html.contains("<hr"));
    let updated = format!("{header}# Real heading\r\n\r\nEdited **in place**.\r\n");
    let saved = client.api(
        "PUT",
        "/api/document",
        Some(json!({
            "id": document["id"], "content": updated, "version": document["version"],
        })),
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    assert_eq!(saved.json()["content"], updated);
    assert_eq!(
        fs::read(workspace.root.join("notes.md")).unwrap(),
        format!("\u{feff}{updated}").as_bytes()
    );
    let preview = client.api(
        "POST",
        "/api/preview",
        Some(json!({
            "id": document["id"], "content": updated,
        })),
    );
    assert_eq!(preview.status, 200, "{}", preview.text());
    assert_eq!(preview.json()["html"], saved.json()["html"]);
    assert!(
        preview.json()["html"]
            .as_str()
            .unwrap()
            .contains("<strong>in place</strong>")
    );
    workspace.write(
        "notes.md",
        updated.replace("Metadata title", "Changed outside"),
    );
    client
        .api(
            "PUT",
            "/api/document",
            Some(json!({
                "id": document["id"], "content": updated, "version": saved.json()["version"],
            })),
        )
        .error(409);
    assert!(
        fs::read_to_string(workspace.root.join("notes.md"))
            .unwrap()
            .contains("Changed outside")
    );
}

#[test]
fn invalid_and_oversized_documents_are_explicit_errors() {
    let workspace = Workspace::new();
    workspace.write("invalid.md", [0xff_u8, 0xfe]);
    workspace.write("binary.md", b"text\0binary");
    workspace.write("large.md", vec![b'a'; 4 * 1024 * 1024 + 1]);
    fs::File::create(workspace.root.join("large.png"))
        .unwrap()
        .set_len(16 * 1024 * 1024 + 1)
        .unwrap();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    client.get_document("invalid.md").error(400);
    client.get_document("binary.md").error(400);
    client.get_document("large.md").error(413);
    let image = client.resource_id("large.png", "asset");
    let document = client.resource_id("large.md", "document");
    client
        .request(
            "GET",
            &format!("/assets?id={image}"),
            &[("Cookie", &client.session_cookie())],
            b"",
        )
        .error(413);
    client
        .api(
            "POST",
            "/api/preview",
            Some(json!({
                "id": document, "content": "a".repeat(4 * 1024 * 1024 + 1),
            })),
        )
        .error(413);
    client
        .api(
            "POST",
            "/api/document",
            Some(json!({
                "path": "new.md", "content": "text\u{0000}binary",
            })),
        )
        .error(400);
    assert!(!workspace.root.join("new.md").exists());
    client
        .request(
            "POST",
            "/api/preview",
            &[
                ("Authorization", &format!("Bearer {}", client.token)),
                ("Content-Type", "application/json"),
                ("Content-Length", "30000000"),
            ],
            b"",
        )
        .error(413);
    client
        .request(
            "POST",
            "/api/preview",
            &[
                ("Authorization", &format!("Bearer {}", client.token)),
                ("Content-Type", "application/json"),
            ],
            b"{ not json",
        )
        .error(400);
}

#[test]
fn cached_images_follow_external_file_changes() {
    let workspace = Workspace::new();
    workspace.write("image.png", vec![0x11; 64 * 1024]);
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let cookie = client.session_cookie();
    let image = client.resource_id("image.png", "asset");
    let get = || {
        client.request(
            "GET",
            &format!("/assets?id={image}"),
            &[("Cookie", &cookie)],
            b"",
        )
    };
    assert_eq!(get().body, vec![0x11; 64 * 1024]);
    assert_eq!(get().body, vec![0x11; 64 * 1024]);
    workspace.write("image.png", vec![0x22; 64 * 1024 + 1]);
    let changed = get();
    assert_eq!(changed.body, vec![0x22; 64 * 1024 + 1]);
    assert_eq!(changed.headers["cache-control"], "no-store");
}

#[test]
fn cached_documents_follow_external_file_changes() {
    let workspace = Workspace::new();
    workspace.write(
        "note.md",
        "---\ntitle: Original\n---\n\n# Original\n\ncontent\n",
    );
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let original = client.get_document("note.md");
    assert_eq!(original.status, 200);
    let original_version = original.json()["version"].clone();
    assert_eq!(client.get_document("note.md").json()["title"], "Original");

    workspace.write(
        "note.md",
        "---\ntitle: Changed\n---\n\n# Changed\n\nexternal content\n",
    );
    let changed = client.get_document("note.md");
    assert_eq!(changed.status, 200);
    assert_eq!(changed.json()["title"], "Changed");
    assert_eq!(
        changed.json()["content"],
        "---\ntitle: Changed\n---\n\n# Changed\n\nexternal content\n"
    );
    assert!(
        changed.json()["html"]
            .as_str()
            .unwrap()
            .contains(">Changed</h1>")
    );
    assert_ne!(changed.json()["version"], original_version);
}

#[test]
fn web_preferences_validate_apply_and_persist_for_authenticated_servers() {
    let preferences = json!({
        "appearance": {
            "theme": "dark",
            "latinFont": "Georgia",
            "cjkFont": "SimSun"
        },
        "web": {
            "imageDirectory": "assets/images",
            "imageCompression": "original",
            "imageMaxEdge": 0,
            "imageQuality": 85,
            "autoSaveDelayMs": 500,
            "defaultView": "source",
            "sourceLineWrap": false,
            "spellcheck": false,
            "fontSizePx": 19,
            "lineHeightPercent": 190,
            "density": "compact",
            "defaultSidebar": "git",
            "sidebarOpen": false,
            "hiddenPatterns": ["drafts/**"],
            "treeRefreshSeconds": 30,
            "gitRefreshSeconds": 5,
            "gitShowUntracked": false,
            "gitDefaultDiff": "staged",
            "largeDocumentThresholdKib": 1024,
            "previewDelayMs": 500,
            "outlineDelayMs": 100,
            "reducedMotion": true,
            "highContrast": true,
            "strongFocus": false
        }
    });
    let workspace = Workspace::new();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let updated = client.api("PUT", "/api/preferences", Some(preferences.clone()));
    assert_eq!(updated.status, 200, "{}", updated.text());
    assert_eq!(
        client.api("GET", "/api/preferences", None).json(),
        preferences
    );
    assert_eq!(
        client.api("GET", "/api/appearance", None).json()["theme"],
        "dark"
    );
    let mut invalid = preferences.clone();
    invalid["web"]["autoSaveDelayMs"] = json!(1);
    client
        .api("PUT", "/api/preferences", Some(invalid))
        .error(400);
    drop(server);

    let users = UserStore::new(workspace.base.join("users.json"));
    users
        .initialize_admin("owner", "correct horse battery staple")
        .unwrap();
    let server = start_with_users(&workspace.root, 0, users).unwrap();
    let client = Client::new(&server);
    let credentials = serde_json::to_vec(&json!({
        "username": "owner",
        "password": "correct horse battery staple"
    }))
    .unwrap();
    let login = client.request(
        "POST",
        "/api/auth/login",
        &[("Content-Type", "application/json")],
        &credentials,
    );
    assert_eq!(login.status, 200, "{}", login.text());
    let cookie = login.headers["set-cookie"]
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body = serde_json::to_vec(&preferences).unwrap();
    let saved = client.request(
        "PUT",
        "/api/preferences",
        &[("Content-Type", "application/json"), ("Cookie", &cookie)],
        &body,
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    let stored = SettingsStore::new(workspace.base.join("settings.json"))
        .load()
        .unwrap()
        .unwrap();
    assert_eq!(stored.web.default_view, DefaultView::Source);
    assert_eq!(stored.web.hidden_patterns, ["drafts/**"]);
}

#[test]
fn occupied_ports_fail_without_interfering_with_an_external_listener() {
    let workspace = Workspace::new();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let error = match start(&workspace.root, port) {
        Ok(_) => panic!("an occupied port was silently reused"),
        Err(error) => error,
    };
    assert!(error.contains(&format!("127.0.0.1:{port}")));
    let connection = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    let (_, address) = listener.accept().unwrap();
    assert_eq!(address.ip(), Ipv4Addr::LOCALHOST);
    drop(connection);
}

#[test]
fn shutdown_is_bounded_with_incomplete_headers_and_bodies() {
    let workspace = Workspace::new();
    let mut server = start(&workspace.root, 0).unwrap();
    let old_token = Client::new(&server).token;
    let port = server.port();
    let mut incomplete_headers = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    incomplete_headers
        .write_all(b"GET /api/tree HTTP/1.1\r\nHost:")
        .unwrap();
    let mut incomplete_body = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
    write!(
        incomplete_body,
        "POST /api/preview HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\
        Authorization: Bearer {old_token}\r\nContent-Type: application/json\r\n\
        Content-Length: 100000\r\n\r\n{{"
    )
    .unwrap();
    assert!(server.is_running());
    let started = Instant::now();
    server.stop().unwrap();
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!server.is_running());
    server.stop().unwrap();
    drop(incomplete_headers);
    drop(incomplete_body);
    let restarted = start(&workspace.root, port).unwrap();
    assert_ne!(Client::new(&restarted).token, old_token);
    assert_eq!(
        Client::new(&restarted).api("GET", "/api/tree", None).status,
        200
    );
}

#[test]
fn incomplete_api_body_times_out_as_json() {
    let workspace = Workspace::new();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(14)))
        .unwrap();
    write!(
        stream,
        "POST /api/preview HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\
        Authorization: Bearer {}\r\nContent-Type: application/json\r\n\
        Content-Length: 100000\r\nConnection: close\r\n\r\n{{",
        client.port, client.token
    )
    .unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).unwrap();
    Reply::parse(&response).error(408);
    assert!(server.is_running());
}

#[test]
fn symlink_or_junction_escapes_are_not_followed() {
    let workspace = Workspace::new();
    workspace.write("safe.md", "safe");
    fs::write(workspace.outside.join("secret.md"), "private outside").unwrap();
    fs::write(workspace.outside.join("image.png"), "outside image").unwrap();
    let link = workspace.root.join("escape");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&workspace.outside, &link).unwrap();
    #[cfg(windows)]
    {
        let result = std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&workspace.outside)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "could not create test junction: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
    }
    let file_link = workspace.root.join("linked.md");
    #[cfg(unix)]
    let file_link_created = {
        std::os::unix::fs::symlink(workspace.outside.join("secret.md"), &file_link).unwrap();
        true
    };
    #[cfg(windows)]
    let file_link_created =
        match std::os::windows::fs::symlink_file(workspace.outside.join("secret.md"), &file_link) {
            Ok(()) => true,
            Err(error)
                if error.kind() == std::io::ErrorKind::PermissionDenied
                    || error.raw_os_error() == Some(1314) =>
            {
                eprintln!(
                    "File-symlink creation is not privileged; directory junction checks still run."
                );
                false
            }
            Err(error) => panic!("could not create file symlink: {error}"),
        };
    #[cfg(not(any(windows, unix)))]
    let file_link_created = false;
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let cookie = client.session_cookie();
    let tree = client.api("GET", "/api/tree", None).json();
    assert_eq!(tree["files"].as_array().unwrap().len(), 1);
    assert_eq!(tree["files"][0]["path"], "safe.md");
    assert_eq!(tree["files"][0]["name"], "safe.md");
    uuid::Uuid::parse_str(tree["files"][0]["id"].as_str().unwrap()).unwrap();
    client.get_document("escape/secret.md").error(403);
    client
        .api(
            "POST",
            "/api/document",
            Some(json!({
                "path": "escape/new.md", "content": "bad",
            })),
        )
        .error(403);
    client
        .resolve_resource("escape/secret.md", "document")
        .error(403);
    client
        .resolve_resource("escape/image.png", "asset")
        .error(403);
    client
        .request(
            "GET",
            "/assets?path=escape%2Fimage.png",
            &[("Cookie", &cookie)],
            b"",
        )
        .error(400);
    if file_link_created {
        client.get_document("linked.md").error(403);
        client.resolve_resource("linked.md", "document").error(403);
    }
    assert!(!workspace.outside.join("new.md").exists());
    assert_eq!(
        fs::read_to_string(workspace.outside.join("secret.md")).unwrap(),
        "private outside"
    );
}
