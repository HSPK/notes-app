use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::{Duration, Instant};

use notes_core::server::{RunningServer, start};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};

struct Workspace {
    base: PathBuf,
    root: PathBuf,
    outside: PathBuf,
}

impl Workspace {
    fn new() -> Self {
        let mut random = [0_u8; 12];
        getrandom::fill(&mut random).unwrap();
        let name = random
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        // Keep disposable fixtures in the checkout, never in a user's notes or OS temp folder.
        let base = std::env::current_dir()
            .unwrap()
            .join("target")
            .join("server-tests")
            .join(name);
        let root = base.join("notes");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        Self {
            base,
            root,
            outside,
        }
    }

    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let path = self.root.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }
}

impl Drop for Workspace {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.base) {
            eprintln!(
                "Could not clean backend test fixture {}: {error}",
                self.base.display()
            );
        }
    }
}

#[derive(Clone)]
struct Client {
    port: u16,
    token: String,
}

impl Client {
    fn new(server: &RunningServer) -> Self {
        Self {
            port: server.port(),
            token: server.url().split_once("#token=").unwrap().1.to_owned(),
        }
    }

    fn request(&self, method: &str, target: &str, headers: &[(&str, &str)], body: &[u8]) -> Reply {
        let mut stream = TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, self.port).into(),
            Duration::from_secs(2),
        )
        .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(15)))
            .unwrap();
        stream
            .set_write_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(
            stream,
            "{method} {target} HTTP/1.1\r\nConnection: close\r\n"
        )
        .unwrap();
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("host"))
        {
            write!(stream, "Host: 127.0.0.1:{}\r\n", self.port).unwrap();
        }
        if !headers
            .iter()
            .any(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        {
            write!(stream, "Content-Length: {}\r\n", body.len()).unwrap();
        }
        for (name, value) in headers {
            write!(stream, "{name}: {value}\r\n").unwrap();
        }
        stream.write_all(b"\r\n").unwrap();
        stream.write_all(body).unwrap();
        stream.flush().unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).unwrap();
        Reply::parse(&bytes)
    }

    fn api(&self, method: &str, target: &str, body: Option<Value>) -> Reply {
        let body = body
            .map(|value| serde_json::to_vec(&value).unwrap())
            .unwrap_or_default();
        self.request(
            method,
            target,
            &[
                ("Authorization", &format!("Bearer {}", self.token)),
                ("Content-Type", "application/json"),
            ],
            &body,
        )
    }

    fn session_cookie(&self) -> String {
        let reply = self.api("POST", "/api/session", None);
        assert_eq!(reply.status, 200, "{}", reply.text());
        let cookie = &reply.headers["set-cookie"];
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Strict"));
        assert!(cookie.contains("Path=/assets"));
        assert!(cookie.starts_with(&format!("notes_session_{}=", self.port)));
        assert_eq!(reply.json()["port"], self.port);
        cookie.split(';').next().unwrap().to_owned()
    }

    fn get_document(&self, path: &str) -> Reply {
        self.api("GET", &format!("/api/document?path={}", encode(path)), None)
    }
}

struct Reply {
    status: u16,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Reply {
    fn parse(bytes: &[u8]) -> Self {
        let split = bytes
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap_or_else(|| panic!("invalid HTTP response: {}", String::from_utf8_lossy(bytes)));
        let head = std::str::from_utf8(&bytes[..split]).unwrap();
        let mut lines = head.split("\r\n");
        let status = lines
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse()
            .unwrap();
        let headers = lines
            .map(|line| {
                let (name, value) = line.split_once(':').unwrap();
                (name.to_ascii_lowercase(), value.trim().to_owned())
            })
            .collect::<HashMap<_, _>>();
        let body = if headers
            .get("transfer-encoding")
            .is_some_and(|value| value == "chunked")
        {
            let mut remaining = &bytes[split + 4..];
            let mut body = Vec::new();
            loop {
                let line_end = remaining
                    .windows(2)
                    .position(|part| part == b"\r\n")
                    .unwrap();
                let length = usize::from_str_radix(
                    std::str::from_utf8(&remaining[..line_end])
                        .unwrap()
                        .split(';')
                        .next()
                        .unwrap(),
                    16,
                )
                .unwrap();
                remaining = &remaining[line_end + 2..];
                if length == 0 {
                    break;
                }
                body.extend_from_slice(&remaining[..length]);
                remaining = &remaining[length + 2..];
            }
            body
        } else {
            bytes[split + 4..].to_vec()
        };
        Self {
            status,
            headers,
            body,
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|error| {
            panic!(
                "invalid JSON: {error}; status {}; {}",
                self.status,
                self.text()
            )
        })
    }

    fn error(&self, status: u16) {
        assert_eq!(self.status, status, "{}", self.text());
        assert!(
            self.json()["error"]
                .as_str()
                .is_some_and(|message| !message.is_empty())
        );
        assert_eq!(self.headers["x-content-type-options"], "nosniff");
        assert_eq!(self.headers["cache-control"], "no-store");
    }
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

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
    assert_eq!(
        tree["files"],
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
        include_bytes!("../../../Shared/Resources/Notes.ico")
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
        include_bytes!("../../../Shared/Resources/NotesIcon.svg")
    );
    let page = client.request("GET", "/", &[], b"");
    assert!(page.text().contains("href=\"/favicon.ico\""));
    assert!(page.text().contains("href=\"/icon.svg\""));
    let png = include_bytes!("../../../Shared/Resources/NotesIcon.png");
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
            "path": "docs/original.md",
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
                "path": "docs/original.md", "content": "no expected version",
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
    let body = json!({"path": "note.md", "content": "app change", "version": original["version"]});
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
            "path": "note.md", "content": "overwrite", "version": original["version"],
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
        handles.push(thread::spawn(move || {
            barrier.wait();
            client.api(
                "PUT",
                "/api/document",
                Some(json!({
                    "path": "note.md", "content": content, "version": version,
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

#[test]
fn authentication_host_origin_and_asset_cookie_gates_are_enforced() {
    let workspace = Workspace::new();
    workspace.write("note.md", "private");
    workspace.write("images/test.png", b"\x89PNG\r\n\x1a\nexample");
    workspace.write(
        "images/test.svg",
        "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    );
    workspace.write("files/info.txt", "<script>plain text</script>");
    workspace.write("files/evil.html", "<script>alert(1)</script>");
    workspace.write("files/evil.js", "alert(1)");
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let authorization = format!("Bearer {}", client.token);
    client.request("GET", "/api/tree", &[], b"").error(401);
    client
        .request(
            "POST",
            "/api/session",
            &[("Authorization", "Bearer wrong")],
            b"",
        )
        .error(401);
    client
        .request(
            "GET",
            "/api/tree",
            &[("Host", "evil.example"), ("Authorization", &authorization)],
            b"",
        )
        .error(403);
    client
        .request(
            "GET",
            "/",
            &[("Host", &format!("localhost:{}", client.port))],
            b"",
        )
        .error(403);
    client
        .request(
            "PUT",
            "/api/document",
            &[
                ("Origin", "https://evil.example"),
                ("Authorization", &authorization),
                ("Content-Type", "application/json"),
            ],
            b"{}",
        )
        .error(403);
    client
        .request(
            "GET",
            "/api/tree",
            &[("Origin", "null"), ("Authorization", &authorization)],
            b"",
        )
        .error(403);
    assert_eq!(
        client
            .request(
                "POST",
                "/api/session",
                &[
                    ("Origin", &format!("http://127.0.0.1:{}", client.port)),
                    ("Authorization", &authorization),
                ],
                b""
            )
            .status,
        200
    );
    let cookie = client.session_cookie();
    client
        .request("GET", "/api/tree", &[("Cookie", &cookie)], b"")
        .error(401);
    client
        .request("PUT", "/api/document", &[("Cookie", &cookie)], b"{}")
        .error(401);
    client
        .request("GET", "/assets?path=images%2Ftest.png", &[], b"")
        .error(401);
    client
        .request(
            "GET",
            "/assets?path=images%2Ftest.png",
            &[("Authorization", &authorization)],
            b"",
        )
        .error(401);
    client
        .request(
            "GET",
            "/assets?path=images%2Ftest.png",
            &[("Cookie", &format!("notes_session_0={}", client.token))],
            b"",
        )
        .error(401);
    let asset = client.request(
        "GET",
        "/assets?path=images%2Ftest.png",
        &[("Cookie", &cookie)],
        b"",
    );
    assert_eq!(asset.status, 200, "{}", asset.text());
    assert_eq!(asset.body, b"\x89PNG\r\n\x1a\nexample");
    assert_eq!(asset.headers["content-type"], "image/png");
    assert!(asset.headers["content-security-policy"].contains("sandbox"));
    assert_eq!(asset.headers["x-content-type-options"], "nosniff");
    let svg = client.request(
        "GET",
        "/assets?path=images%2Ftest.svg",
        &[("Cookie", &cookie)],
        b"",
    );
    assert_eq!(svg.status, 200);
    assert!(svg.headers["content-security-policy"].contains("script-src 'none'"));
    let text = client.request(
        "GET",
        "/assets?path=files%2Finfo.txt",
        &[("Cookie", &cookie)],
        b"",
    );
    assert_eq!(text.status, 200);
    assert_eq!(text.headers["content-type"], "text/plain; charset=utf-8");
    assert_eq!(text.headers["content-disposition"], "attachment");
    for path in ["files/evil.html", "files/evil.js"] {
        client
            .request(
                "GET",
                &format!("/assets?path={}", encode(path)),
                &[("Cookie", &cookie)],
                b"",
            )
            .error(403);
    }
    for path in [
        "/",
        "/app.mjs",
        "/model.mjs",
        "/styles.css",
        "/editor.bundle.mjs",
        "/editor.bundle.css",
        "/editor-helpers.mjs",
        "/THIRD-PARTY-LICENSES.txt",
    ] {
        let asset = client.request("GET", path, &[], b"");
        assert_eq!(asset.status, 200, "{}", asset.text());
        assert_eq!(asset.headers["referrer-policy"], "no-referrer");
        assert!(asset.headers["content-security-policy"].contains("script-src 'self'"));
        let policy = &asset.headers["content-security-policy"];
        assert!(
            policy
                .split(';')
                .any(|part| part.trim() == "script-src 'self'")
        );
        assert!(
            policy
                .split(';')
                .any(|part| part.trim().starts_with("style-src 'self' 'nonce-")
                    && !part.contains("'unsafe-inline'"))
        );
    }
    client.api("DELETE", "/api/document", None).error(405);
    client.request("GET", "/not-a-route", &[], b"").error(404);
}

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
            .error(403);
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
    let server = start(&workspace.root, 0).unwrap();
    let client = Client::new(&server);
    let reply = client.api("POST", "/api/preview", Some(json!({
        "path": "guides/new.md",
        "content": "# Hello\n\n<script>bad()</script>\n\n[home](../README.md#hello)\n\n![pic](../images/a.png)\n\n~~old~~\n\n- [x] done",
    })));
    assert_eq!(reply.status, 200, "{}", reply.text());
    let body = reply.json();
    let html = body["html"].as_str().unwrap();
    assert!(html.contains("<h1 id=\"hello\">"));
    assert!(html.contains("&lt;script&gt;"));
    assert!(!html.contains("<script>"));
    assert!(html.contains("href=\"/?file=README.md#hello\""));
    assert!(html.contains("src=\"/assets?path=images%2Fa.png\""));
    assert!(html.contains("<del>old</del>"));
    assert!(!workspace.root.join("guides").exists());
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
            "path": "notes.md", "content": updated, "version": document["version"],
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
            "path": "notes.md", "content": updated,
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
                "path": "notes.md", "content": updated, "version": saved.json()["version"],
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
    client
        .request(
            "GET",
            "/assets?path=large.png",
            &[("Cookie", &client.session_cookie())],
            b"",
        )
        .error(413);
    client
        .api(
            "POST",
            "/api/preview",
            Some(json!({
                "path": "new.md", "content": "a".repeat(4 * 1024 * 1024 + 1),
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
    assert_eq!(
        client.api("GET", "/api/tree", None).json()["files"],
        json!([{"path": "safe.md", "name": "safe.md"}])
    );
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
        .api(
            "PUT",
            "/api/document",
            Some(json!({
                "path": "escape/secret.md", "content": "bad", "version": "0".repeat(64),
            })),
        )
        .error(403);
    client
        .request(
            "GET",
            "/assets?path=escape%2Fimage.png",
            &[("Cookie", &cookie)],
            b"",
        )
        .error(403);
    if file_link_created {
        client.get_document("linked.md").error(403);
        client
            .api(
                "PUT",
                "/api/document",
                Some(json!({
                    "path": "linked.md", "content": "bad", "version": "0".repeat(64),
                })),
            )
            .error(403);
    }
    assert!(!workspace.outside.join("new.md").exists());
    assert_eq!(
        fs::read_to_string(workspace.outside.join("secret.md")).unwrap(),
        "private outside"
    );
}
