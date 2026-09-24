use super::*;

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
    assert_eq!(
        client
            .request(
                "GET",
                "/",
                &[("Host", &format!("localhost:{}", client.port))],
                b"",
            )
            .status,
        200
    );
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
    let forwarded_port = if client.port == 65535 {
        49152
    } else {
        client.port + 1
    };
    let mismatched_port = if forwarded_port == 65535 {
        49151
    } else {
        forwarded_port + 1
    };
    assert_eq!(
        client
            .request(
                "POST",
                "/api/session",
                &[
                    ("Host", &format!("localhost:{forwarded_port}")),
                    ("Origin", &format!("http://localhost:{forwarded_port}")),
                    ("Authorization", &authorization),
                ],
                b""
            )
            .status,
        200
    );
    client
        .request(
            "POST",
            "/api/session",
            &[
                ("Host", &format!("localhost:{forwarded_port}")),
                ("Origin", &format!("http://localhost:{mismatched_port}")),
                ("Authorization", &authorization),
            ],
            b"",
        )
        .error(403);
    let cookie = client.session_cookie();
    let png_url = format!(
        "/assets?id={}",
        client.resource_id("images/test.png", "asset")
    );
    client
        .request("GET", "/api/tree", &[("Cookie", &cookie)], b"")
        .error(401);
    client
        .request("PUT", "/api/document", &[("Cookie", &cookie)], b"{}")
        .error(401);
    client.request("GET", &png_url, &[], b"").error(401);
    client
        .request("GET", &png_url, &[("Authorization", &authorization)], b"")
        .error(401);
    client
        .request(
            "GET",
            &png_url,
            &[("Cookie", &format!("notes_session_0={}", client.token))],
            b"",
        )
        .error(401);
    let asset = client.request("GET", &png_url, &[("Cookie", &cookie)], b"");
    assert_eq!(asset.status, 200, "{}", asset.text());
    assert_eq!(asset.body, b"\x89PNG\r\n\x1a\nexample");
    assert_eq!(asset.headers["content-type"], "image/png");
    assert!(asset.headers["content-security-policy"].contains("sandbox"));
    assert_eq!(asset.headers["x-content-type-options"], "nosniff");
    let svg = client.request(
        "GET",
        &format!(
            "/assets?id={}",
            client.resource_id("images/test.svg", "asset")
        ),
        &[("Cookie", &cookie)],
        b"",
    );
    assert_eq!(svg.status, 200);
    assert!(svg.headers["content-security-policy"].contains("script-src 'none'"));
    let text = client.request(
        "GET",
        &format!(
            "/assets?id={}",
            client.resource_id("files/info.txt", "asset")
        ),
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
                &format!("/assets?id={}", client.resource_id(path, "asset")),
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
    client.api("PATCH", "/api/document", None).error(405);
    client.request("GET", "/not-a-route", &[], b"").error(404);
}

#[test]
fn initial_admin_and_multi_user_sessions_guard_the_shared_library() {
    let workspace = Workspace::new();
    workspace.write("shared.md", "# Shared");
    let store = UserStore::new(workspace.base.join("users.json"));
    let server = start_with_users(&workspace.root, 0, store.clone()).unwrap();
    let client = Client::new(&server);
    assert!(!server.url().contains("#token="));
    client.request("GET", "/api/tree", &[], b"").error(401);

    let initial = client.request("GET", "/api/auth/status", &[], b"").json();
    assert_eq!(initial["mode"], "users");
    assert_eq!(initial["setupRequired"], true);
    assert_eq!(initial["authenticated"], false);

    let setup = client.request(
        "POST",
        "/api/auth/setup",
        &[("Content-Type", "application/json")],
        &serde_json::to_vec(&json!({
            "username": "Owner",
            "password": "correct horse battery staple"
        }))
        .unwrap(),
    );
    assert_eq!(setup.status, 200, "{}", setup.text());
    assert_eq!(setup.json()["user"]["username"], "owner");
    assert_eq!(setup.json()["user"]["role"], "admin");
    let owner_cookie = setup.headers["set-cookie"]
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert!(setup.headers["set-cookie"].contains("HttpOnly"));
    assert!(setup.headers["set-cookie"].contains("SameSite=Strict"));
    assert!(setup.headers["set-cookie"].contains("Path=/"));

    assert_eq!(
        client
            .request("GET", "/api/auth/status", &[("Cookie", &owner_cookie)], b"")
            .json()["authenticated"],
        true
    );
    assert_eq!(
        client
            .request("GET", "/api/tree", &[("Cookie", &owner_cookie)], b"")
            .status,
        200
    );
    client
        .request(
            "POST",
            "/api/auth/setup",
            &[("Content-Type", "application/json")],
            &serde_json::to_vec(&json!({
                "username": "second",
                "password": "another secure password"
            }))
            .unwrap(),
        )
        .error(409);

    store
        .add("writer", "writer password long enough", Role::User)
        .unwrap();
    client
        .request(
            "POST",
            "/api/auth/login",
            &[("Content-Type", "application/json")],
            &serde_json::to_vec(&json!({
                "username": "writer",
                "password": "wrong password"
            }))
            .unwrap(),
        )
        .error(401);
    let writer = client.request(
        "POST",
        "/api/auth/login",
        &[("Content-Type", "application/json")],
        &serde_json::to_vec(&json!({
            "username": "writer",
            "password": "writer password long enough"
        }))
        .unwrap(),
    );
    assert_eq!(writer.status, 200, "{}", writer.text());
    assert_eq!(writer.json()["user"]["role"], "user");
    let writer_cookie = writer.headers["set-cookie"]
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    client
        .request("GET", "/api/tree", &[("Cookie", &writer_cookie)], b"")
        .error(403);
    let share = client.request(
        "POST",
        "/api/projects",
        &[
            ("Cookie", &owner_cookie),
            ("Content-Type", "application/json"),
        ],
        &serde_json::to_vec(&json!({"action":"share","id":"default","shared":"edit"})).unwrap(),
    );
    assert_eq!(share.status, 200, "{}", share.text());
    assert_eq!(
        client
            .request("GET", "/api/tree", &[("Cookie", &writer_cookie)], b"")
            .json()["files"][0]["path"],
        "shared.md"
    );

    assert_eq!(
        client
            .request(
                "POST",
                "/api/auth/logout",
                &[("Cookie", &owner_cookie)],
                b""
            )
            .status,
        200
    );
    client
        .request("GET", "/api/tree", &[("Cookie", &owner_cookie)], b"")
        .error(401);
}

#[test]
fn authenticated_session_survives_restart_and_logout_remains_revoked() {
    let workspace = Workspace::new();
    let users = UserStore::new(workspace.base.join("users.json"));
    users
        .initialize_admin("owner", "correct horse battery staple")
        .unwrap();
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let mut server = start_with_users(&workspace.root, port, users.clone()).unwrap();
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
    let raw_token = cookie.split_once('=').unwrap().1;
    let sessions = fs::read_dir(&workspace.base)
        .unwrap()
        .find_map(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("sessions-"))
                .then_some(path)
        })
        .unwrap();
    assert!(!fs::read_to_string(&sessions).unwrap().contains(raw_token));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&sessions).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    server.stop().unwrap();

    let mut server = start_with_users(&workspace.root, port, users.clone()).unwrap();
    let client = Client::new(&server);
    let refreshed = client.request("GET", "/api/auth/status", &[("Cookie", &cookie)], b"");
    assert_eq!(refreshed.status, 200, "{}", refreshed.text());
    assert_eq!(refreshed.json()["authenticated"], true);
    let logout = client.request("POST", "/api/auth/logout", &[("Cookie", &cookie)], b"");
    assert_eq!(logout.status, 200, "{}", logout.text());
    server.stop().unwrap();

    let server = start_with_users(&workspace.root, port, users).unwrap();
    let client = Client::new(&server);
    let revoked = client.request("GET", "/api/auth/status", &[("Cookie", &cookie)], b"");
    assert_eq!(revoked.status, 200, "{}", revoked.text());
    assert_eq!(revoked.json()["authenticated"], false);
}
