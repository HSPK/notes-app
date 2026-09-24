use super::*;

#[test]
fn tree_and_documents_work_without_a_mkdocs_project() {
    let workspace = Workspace::new();
    workspace.write("README.md", "# Welcome\n");
    workspace.write("docs/中文.markdown", "Unicode 📝\n");
    for folder in [".git", ".venv", "node_modules", "target", "dist", "venv"] {
        workspace.write(&format!("{folder}/private.md"), "not listed");
    }
    workspace.write("ignored.txt", "attachment");
    let mut server = start(&workspace.root, 0).unwrap();
    assert!(server.is_running());
    assert_eq!(server.root(), fs::canonicalize(&workspace.root).unwrap());
    assert!(
        server
            .url()
            .starts_with(&format!("http://127.0.0.1:{}/#token=", server.port()))
    );
    let client = Client::new(&server);
    assert_eq!(client.token.len(), 64);
    assert!(client.token.bytes().all(|byte| byte.is_ascii_hexdigit()));
    let reply = client.api("GET", "/api/tree", None);
    assert_eq!(reply.status, 200, "{}", reply.text());
    let tree = reply.json();
    assert_eq!(Path::new(tree["root"].as_str().unwrap()), server.root());
    assert_eq!(tree["truncated"], false);
    let entries = tree["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| {
            uuid::Uuid::parse_str(file["id"].as_str().unwrap()).unwrap();
            json!({"path":file["path"],"name":file["name"]})
        })
        .collect::<Vec<_>>();
    assert_eq!(
        json!(entries),
        json!([
            {"path": "README.md", "name": "README.md"},
            {"path": "docs/中文.markdown", "name": "中文.markdown"},
        ])
    );
    let reply = client.get_document("docs/中文.markdown");
    assert_eq!(reply.status, 200, "{}", reply.text());
    assert_eq!(reply.json()["path"], "docs/中文.markdown");
    assert_eq!(reply.json()["content"], "Unicode 📝\n");
    assert_eq!(reply.json()["version"].as_str().unwrap().len(), 64);
    server.stop().unwrap();
    assert!(!server.is_running());
}

#[test]
fn tree_and_documents_expose_frontmatter_titles_and_empty_directories() {
    let workspace = Workspace::new();
    workspace.write(
        "Guides/index.md",
        format!(
            "---\ntitle: Handbook\n---\n# Physical index\n{}",
            "Body\n".repeat(20_000)
        ),
    );
    workspace.write(
        "Guides/intro.md",
        format!(
            "---\ntitle: Getting started\n---\n# Introduction\n{}",
            "Body\n".repeat(20_000)
        ),
    );
    fs::create_dir_all(workspace.root.join("Empty")).unwrap();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let tree = client.api("GET", "/api/tree", None).json();
    assert!(
        tree["directories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["path"] == "Empty" && item["name"] == "Empty")
    );
    assert!(
        tree["directories"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["path"] == "Guides" && item["title"] == "Handbook")
    );
    assert!(
        tree["files"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["path"] == "Guides/intro.md" && item["title"] == "Getting started")
    );
    let document = client.get_document("Guides/intro.md").json();
    assert_eq!(document["title"], "Getting started");
}

#[test]
fn folders_and_documents_can_be_created_inspected_and_moved_without_overwrite() {
    let workspace = Workspace::new();
    workspace.write("Draft.md", "---\ntitle: Draft title\n---\n# Draft\n");
    workspace.write("Existing.md", "# Existing\n");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);

    let created = client.api("POST", "/api/directory", Some(json!({"path": "Archive"})));
    assert_eq!(created.status, 201, "{}", created.text());
    assert!(workspace.root.join("Archive").is_dir());

    let draft = client.resource_id("Draft.md", "document");
    let existing = client.resource_id("Existing.md", "document");
    let archive = created.json()["id"].as_str().unwrap().to_owned();
    let details = client
        .api("GET", &format!("/api/entry?id={draft}"), None)
        .json();
    assert_eq!(details["name"], "Draft.md");
    assert_eq!(details["title"], "Draft title");
    assert!(details["size"].as_u64().unwrap() > 0);

    let moved = client.api(
        "PATCH",
        "/api/entry",
        Some(json!({"id": draft, "destination": "Archive/Renamed.md"})),
    );
    assert_eq!(moved.status, 200, "{}", moved.text());
    assert_eq!(moved.json()["kind"], "file");
    assert_eq!(moved.json()["document"]["path"], "Archive/Renamed.md");
    assert!(!workspace.root.join("Draft.md").exists());
    assert!(workspace.root.join("Archive/Renamed.md").is_file());

    client
        .api(
            "PATCH",
            "/api/entry",
            Some(json!({"id": existing, "destination": "Archive/Renamed.md"})),
        )
        .error(409);
    client
        .api(
            "PATCH",
            "/api/entry",
            Some(json!({"id": archive, "destination": "Archive/Nested"})),
        )
        .error(400);
    let moved_directory = client.api(
        "PATCH",
        "/api/entry",
        Some(json!({"id": archive, "destination": "Published"})),
    );
    assert_eq!(moved_directory.status, 200, "{}", moved_directory.text());
    assert_eq!(moved_directory.json()["kind"], "directory");
    assert!(workspace.root.join("Published/Renamed.md").is_file());
}

#[test]
fn editor_styles_use_a_nonce_separate_from_private_api_credentials() {
    let workspace = Workspace::new();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let page = client.request("GET", "/", &[], b"");
    let html = page.text();
    let nonce = html
        .split_once("name=\"notes-style-nonce\" content=\"")
        .unwrap()
        .1
        .split('"')
        .next()
        .unwrap();
    assert_eq!(nonce.len(), 32);
    assert!(nonce.bytes().all(|byte| byte.is_ascii_hexdigit()));
    assert!(!html.contains("__STYLE_NONCE__"));
    assert!(
        page.headers["content-security-policy"]
            .contains(&format!("style-src 'self' 'nonce-{nonce}'"))
    );
    client
        .request(
            "GET",
            "/api/tree",
            &[("Authorization", &format!("Bearer {nonce}"))],
            b"",
        )
        .error(401);
    let another = start(&workspace.root, 0).unwrap();
    let other_page = Client::new(&another).request("GET", "/", &[], b"");
    assert_ne!(
        page.headers["content-security-policy"],
        other_page.headers["content-security-policy"]
    );
}

#[test]
fn appearance_changes_are_authenticated_and_do_not_restart_the_document_session() {
    use notes_core::appearance::{Appearance, Theme};
    let workspace = Workspace::new();
    workspace.write("note.md", "# Keep this document\n");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let url = server.url().to_owned();
    let original = client.get_document("note.md").json();
    client
        .request("GET", "/api/appearance", &[], b"")
        .error(401);
    assert_eq!(
        client.api("GET", "/api/appearance", None).json(),
        serde_json::to_value(Appearance::default()).unwrap()
    );
    server
        .set_appearance(Appearance {
            theme: Theme::Dark,
            latin_font: "Georgia".into(),
            cjk_font: "微软雅黑".into(),
        })
        .unwrap();
    let updated = client.api("GET", "/api/appearance", None);
    assert_eq!(updated.status, 200);
    assert_eq!(
        updated.json(),
        json!({
            "theme": "dark", "latinFont": "Georgia", "cjkFont": "微软雅黑",
        })
    );
    assert_eq!(server.url(), url);
    assert!(server.is_running());
    assert_eq!(client.get_document("note.md").json(), original);
    assert!(
        server
            .set_appearance(Appearance {
                latin_font: "".into(),
                ..Appearance::default()
            })
            .is_err()
    );
    assert_eq!(
        client.api("GET", "/api/appearance", None).json(),
        updated.json()
    );
    client
        .api("POST", "/api/appearance", Some(json!({"theme": "light"})))
        .error(405);
}

#[test]
fn app_icons_are_embedded_with_crisp_native_sizes() {
    let workspace = Workspace::new();
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let icon = client.request("GET", "/favicon.ico", &[], b"");
    assert_eq!(icon.status, 200);
    assert_eq!(icon.headers["content-type"], "image/x-icon");
    assert_eq!(
        icon.body,
        include_bytes!("../../../../Shared/Resources/Notes.ico")
    );
    assert_eq!(&icon.body[..4], &[0, 0, 1, 0]);
    let sizes = [16_u32, 20, 24, 32, 40, 48, 64, 128, 256];
    assert_eq!(
        u16::from_le_bytes(icon.body[4..6].try_into().unwrap()) as usize,
        sizes.len()
    );
    let mut next_offset = 6 + sizes.len() * 16;
    for (index, size) in sizes.iter().enumerate() {
        let entry = &icon.body[6 + index * 16..6 + (index + 1) * 16];
        let dimension = if *size == 256 { 0 } else { *size as u8 };
        assert_eq!(&entry[..2], &[dimension, dimension]);
        assert_eq!(&entry[4..8], &[1, 0, 32, 0]);
        let length = u32::from_le_bytes(entry[8..12].try_into().unwrap()) as usize;
        let offset = u32::from_le_bytes(entry[12..16].try_into().unwrap()) as usize;
        assert_eq!(offset, next_offset);
        let png = &icon.body[offset..offset + length];
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), *size);
        assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), *size);
        next_offset = offset + length;
    }
    assert_eq!(next_offset, icon.body.len());
    let vector = client.request("GET", "/icon.svg", &[], b"");
    assert_eq!(vector.status, 200);
    assert_eq!(vector.headers["content-type"], "image/svg+xml");
    assert_eq!(
        vector.body,
        include_bytes!("../../../../Shared/Resources/NotesIcon.svg")
    );
    let page = client.request("GET", "/", &[], b"");
    assert!(page.text().contains("href=\"/favicon.ico\""));
    assert!(page.text().contains("href=\"/icon.svg\""));
    let png = include_bytes!("../../../../Shared/Resources/NotesIcon.png");
    assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 1024);
    assert_eq!(u32::from_be_bytes(png[20..24].try_into().unwrap()), 1024);
}

#[test]
fn editing_and_creating_preserve_unicode_bom_and_crlf() {
    let workspace = Workspace::new();
    workspace.write("docs/original.md", "\u{feff}# 原文\r\nsecond\r\n");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let original = client.get_document("docs/original.md").json();
    assert_eq!(original["content"], "# 原文\r\nsecond\r\n");
    let saved = client.api(
        "PUT",
        "/api/document",
        Some(json!({
            "id": original["id"],
            "content": "# 已保存 📝\nnext\n",
            "version": original["version"],
        })),
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    assert_eq!(saved.json()["content"], "# 已保存 📝\r\nnext\r\n");
    assert_ne!(saved.json()["version"], original["version"]);
    assert_eq!(
        fs::read(workspace.root.join("docs").join("original.md")).unwrap(),
        "\u{feff}# 已保存 📝\r\nnext\r\n".as_bytes()
    );
    let created = client.api(
        "POST",
        "/api/document",
        Some(json!({
            "path": "docs/新笔记.MARKDOWN", "content": "# New\ncontent 📝\n",
        })),
    );
    assert_eq!(created.status, 201, "{}", created.text());
    assert_eq!(created.json()["content"], "# New\ncontent 📝\n");
    assert_eq!(
        fs::read_to_string(workspace.root.join("docs").join("新笔记.MARKDOWN")).unwrap(),
        "# New\ncontent 📝\n"
    );
    let duplicate = client.api(
        "POST",
        "/api/document",
        Some(json!({
            "path": "docs/新笔记.MARKDOWN", "content": "overwrite",
        })),
    );
    duplicate.error(409);
    assert_eq!(
        client.get_document("docs/新笔记.MARKDOWN").json(),
        created.json()
    );
    client
        .api(
            "POST",
            "/api/document",
            Some(json!({
                "path": "missing/new.md", "content": "no parent",
            })),
        )
        .error(404);
    client
        .api(
            "POST",
            "/api/document",
            Some(json!({
                "path": "docs/new.txt", "content": "wrong extension",
            })),
        )
        .error(400);
    client
        .api(
            "PUT",
            "/api/document",
            Some(json!({
                "id": original["id"], "content": "no expected version",
            })),
        )
        .error(400);
    assert!(
        fs::read_dir(workspace.root.join("docs"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".notes-save-"))
    );
}

#[test]
fn external_changes_and_deletions_do_not_get_overwritten() {
    let workspace = Workspace::new();
    workspace.write("note.md", "original");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let original = client.get_document("note.md").json();
    workspace.write("note.md", "external change");
    let body =
        json!({"id": original["id"], "content": "app change", "version": original["version"]});
    client
        .api("PUT", "/api/document", Some(body.clone()))
        .error(409);
    assert_eq!(
        fs::read_to_string(workspace.root.join("note.md")).unwrap(),
        "external change"
    );
    workspace.write("note.md", b"external\0binary");
    client
        .api("PUT", "/api/document", Some(body.clone()))
        .error(409);
    assert_eq!(
        fs::read(workspace.root.join("note.md")).unwrap(),
        b"external\0binary"
    );
    fs::remove_file(workspace.root.join("note.md")).unwrap();
    client.api("PUT", "/api/document", Some(body)).error(409);
    assert!(!workspace.root.join("note.md").exists());
}

#[test]
fn read_only_documents_and_failed_saves_retain_the_original() {
    let workspace = Workspace::new();
    workspace.write("note.md", "read-only original");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let original = client.get_document("note.md").json();
    let path = workspace.root.join("note.md");
    let permissions = fs::metadata(&path).unwrap().permissions();
    let mut readonly = permissions.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&path, readonly).unwrap();
    let reply = client.api(
        "PUT",
        "/api/document",
        Some(json!({
            "id": original["id"], "content": "overwrite", "version": original["version"],
        })),
    );
    fs::set_permissions(&path, permissions).unwrap();
    reply.error(403);
    assert_eq!(fs::read_to_string(path).unwrap(), "read-only original");
    assert_eq!(fs::read_dir(&workspace.root).unwrap().count(), 1);
}

#[test]
fn concurrent_app_saves_are_serialized_by_expected_version() {
    let workspace = Workspace::new();
    workspace.write("note.md", "original");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let original = client.get_document("note.md").json();
    let barrier = Arc::new(Barrier::new(2));
    let mut handles = Vec::new();
    for content in ["first", "second"] {
        let client = client.clone();
        let barrier = barrier.clone();
        let version = original["version"].clone();
        let id = original["id"].clone();
        handles.push(thread::spawn(move || {
            barrier.wait();
            client.api(
                "PUT",
                "/api/document",
                Some(json!({
                    "id": id, "content": content, "version": version,
                })),
            )
        }));
    }
    let responses = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    let mut statuses = responses
        .iter()
        .map(|reply| reply.status)
        .collect::<Vec<_>>();
    statuses.sort();
    assert_eq!(statuses, [200, 409]);
    let successful = responses
        .iter()
        .find(|reply| reply.status == 200)
        .unwrap()
        .json();
    assert_eq!(
        fs::read_to_string(workspace.root.join("note.md")).unwrap(),
        successful["content"].as_str().unwrap()
    );
}
