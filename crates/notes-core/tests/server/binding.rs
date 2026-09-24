use super::projects::users;
use super::*;
use notes_core::server::{start_on, start_with_users_on, start_with_users_on_hosts};
use std::net::Ipv4Addr;

#[test]
fn wildcard_binding_allows_ip_hosts_but_keeps_authentication_and_origin_checks() {
    let workspace = Workspace::new();
    let server =
        start_with_users_on(&workspace.root, Ipv4Addr::UNSPECIFIED, 0, users(&workspace)).unwrap();
    assert_eq!(server.host(), Ipv4Addr::UNSPECIFIED);
    assert!(server.url().starts_with("http://127.0.0.1:"));
    let client = Client::new(&server);
    let host = format!("192.0.2.10:{}", server.port());
    let origin = format!("http://{host}");
    let headers = [("Host", host.as_str()), ("Origin", origin.as_str())];
    let status = client.request("GET", "/api/auth/status", &headers, b"");
    assert_eq!(status.status, 200, "{}", status.text());
    assert_eq!(status.json()["authenticated"], false);
    client.request("GET", "/api/tree", &headers, b"").error(401);
    let other_port = if server.port() == 65535 {
        49151
    } else {
        server.port() + 1
    };
    for bad in [
        format!("http://192.0.2.11:{}", server.port()),
        format!("http://192.0.2.10:{other_port}"),
        "http://evil.example".into(),
        "null".into(),
    ] {
        client
            .request(
                "POST",
                "/api/auth/login",
                &[
                    ("Host", &host),
                    ("Origin", &bad),
                    ("Content-Type", "application/json"),
                ],
                b"{}",
            )
            .error(403);
    }
    for bad in [
        "evil.example",
        "192.0.2.10:invalid",
        "192.0.2.10:",
        "user@192.0.2.10",
    ] {
        let response = client.request("GET", "/", &[("Host", bad)], b"");
        assert_eq!(response.status, 403, "Accepted unexpected Host: {bad}");
    }
    let logged = client.request(
        "POST",
        "/api/auth/login",
        &[
            ("Host", &host),
            ("Origin", &origin),
            ("Content-Type", "application/json"),
        ],
        &serde_json::to_vec(
            &json!({"username":"alice","password":"project test password long enough"}),
        )
        .unwrap(),
    );
    assert_eq!(logged.status, 200, "{}", logged.text());
    let cookie = logged.headers["set-cookie"].split(';').next().unwrap();
    assert_eq!(
        client
            .request(
                "GET",
                "/api/tree",
                &[("Host", &host), ("Origin", &origin), ("Cookie", cookie)],
                b""
            )
            .status,
        200
    );
}

#[test]
fn loopback_defaults_and_diagnostic_mode_do_not_expand_network_access() {
    let workspace = Workspace::new();
    let server = start(&workspace.root, 0).unwrap();
    assert_eq!(server.host(), Ipv4Addr::LOCALHOST);
    Client::new(&server)
        .request("GET", "/", &[("Host", "192.0.2.10")], b"")
        .error(403);
    assert!(start_on(&workspace.root, Ipv4Addr::UNSPECIFIED, 0).is_err());
}

#[test]
fn configured_dns_hosts_keep_exact_host_origin_and_authentication_boundaries() {
    let workspace = Workspace::new();
    let server = start_with_users_on_hosts(
        &workspace.root,
        Ipv4Addr::UNSPECIFIED,
        0,
        users(&workspace),
        &[
            "notes.example".parse().unwrap(),
            "other.example".parse().unwrap(),
        ],
    )
    .unwrap();
    let client = Client::new(&server);
    for host in [
        "notes.example:8123",
        "NOTES.EXAMPLE:8123",
        "other.example:8123",
    ] {
        let origin = format!("http://{}", host.to_ascii_lowercase());
        let headers = [("Host", host), ("Origin", origin.as_str())];
        assert_eq!(
            client
                .request("GET", "/api/auth/status", &headers, b"")
                .status,
            200
        );
        client.request("GET", "/api/tree", &headers, b"").error(401);
    }
    assert_eq!(
        client
            .request(
                "GET",
                "/",
                &[
                    ("Host", "notes.example"),
                    ("Origin", "http://notes.example:80")
                ],
                b""
            )
            .status,
        200
    );
    for host in [
        "evil.example",
        "sub.notes.example",
        "notes.example.evil.example",
        "notes.example:invalid",
        "notes.example:",
        "notes.example:65536",
        "user@notes.example",
        "notes.example.",
    ] {
        client
            .request("GET", "/", &[("Host", host)], b"")
            .error(403);
    }
    client
        .request(
            "GET",
            "/",
            &[("Host", "notes.example"), ("Host", "other.example")],
            b"",
        )
        .error(403);
    for origin in [
        "http://other.example:8123",
        "http://notes.example:8124",
        "https://notes.example:8123",
        "http://notes.example:8123/",
        "http://notes.example:invalid",
        "http://notes.example:",
        "http://127.0.0.1:8123",
        "http://notes.example.evil.example:8123",
        "null",
    ] {
        client
            .request(
                "POST",
                "/api/auth/login",
                &[
                    ("Host", "notes.example:8123"),
                    ("Origin", origin),
                    ("Content-Type", "application/json"),
                ],
                b"{}",
            )
            .error(403);
    }
    let headers = [
        ("Host", "notes.example:8123"),
        ("Origin", "http://notes.example:8123"),
        ("Content-Type", "application/json"),
    ];
    let logged = client.request(
        "POST",
        "/api/auth/login",
        &headers,
        &serde_json::to_vec(
            &json!({"username": "alice", "password": "project test password long enough"}),
        )
        .unwrap(),
    );
    assert_eq!(logged.status, 200, "{}", logged.text());
    let cookie = logged.headers["set-cookie"].split(';').next().unwrap();
    assert_eq!(
        client
            .request(
                "GET",
                "/api/tree",
                &[headers[0], headers[1], ("Cookie", cookie)],
                b""
            )
            .status,
        200
    );
}
