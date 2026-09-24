use super::projects::{login, request, resource_id, users};
use super::public_sharing::public;
use super::*;

#[test]
#[ignore = "performance benchmark"]
fn benchmark_public_session_with_many_unexpired_visitors() {
    let workspace = Workspace::new();
    workspace.write("shared.md", "# Published\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document = resource_id(&client, &alice, "default", "shared.md", "document");
    let result = request(&client, &alice, "default", "POST", "/api/projects",
        Some(json!({"action":"document","id":"default","document":document,"permission":"publicRead"}))).json();
    let token = result["publicLinks"]["shared.md"]["token"]
        .as_str()
        .unwrap();
    assert_eq!(
        public(
            &client,
            token,
            "GET",
            &format!("/api/public/document?id={document}"),
            None
        )
        .status,
        200
    );
    let directory = fs::read_dir(workspace.base.join("config"))
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            entry.file_type().unwrap().is_dir()
                && entry.file_name().to_string_lossy().starts_with("projects-")
        })
        .unwrap();
    let mut database =
        rusqlite::Connection::open(directory.path().join(".state/workspace.sqlite")).unwrap();
    for rows in [0, 65_536] {
        if rows > 0 {
            let expires = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
                + 12 * 60 * 60 * 1000;
            let transaction = database.transaction().unwrap();
            {
                let mut insert = transaction.prepare(
                    "INSERT INTO public_sessions(digest,project,link,password,created,expires) VALUES (?1,?2,'fixture','',0,?3)"
                ).unwrap();
                for index in 0..rows {
                    insert
                        .execute(rusqlite::params![
                            format!("fixture-{index:048x}"),
                            format!("fixture-project-{}", index / 2048),
                            expires
                        ])
                        .unwrap();
                }
            }
            transaction.commit().unwrap();
        }
        let mut timings = Vec::new();
        for _ in 0..80 {
            let started = Instant::now();
            let response = public(&client, token, "POST", "/api/public/session", None);
            assert_eq!(response.status, 200, "{}", response.text());
            timings.push(started.elapsed().as_secs_f64() * 1000.0);
        }
        timings.sort_by(f64::total_cmp);
        let plan: Vec<String> = database
            .prepare("EXPLAIN QUERY PLAN DELETE FROM public_sessions WHERE expires<=?1")
            .unwrap()
            .query_map([0_i64], |row| row.get(3))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        println!(
            "{}",
            json!({"seededVisitors":rows,"runs":timings.len(),"medianMs":timings[40],
            "p95Ms":timings[75],"cleanupPlan":plan})
        );
    }
}

#[test]
fn visitor_expiry_cleanup_uses_an_index_and_preserves_unexpired_sessions() {
    let workspace = Workspace::new();
    workspace.write("shared.md", "# Shared\n");
    let user_store = users(&workspace);
    let server = start_with_users(&workspace.root, 0, user_store.clone()).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document = resource_id(&client, &alice, "default", "shared.md", "document");
    let shared = request(&client, &alice, "default", "POST", "/api/projects",
        Some(json!({"action":"document","id":"default","document":document,"permission":"publicRead"}))).json();
    let token = shared["publicLinks"]["shared.md"]["token"]
        .as_str()
        .unwrap();
    assert_eq!(
        public(&client, token, "POST", "/api/public/session", None).status,
        200
    );
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
    for (digest, project, expires) in [
        ("fixture-expired", "default", 0_i64),
        ("fixture-other-expired", "other", 0),
        ("fixture-live", "other", i64::MAX),
    ] {
        database.execute(
            "INSERT INTO public_sessions(digest,project,link,password,created,expires) VALUES (?1,?2,'fixture','',0,?3)",
            rusqlite::params![digest,project,expires],
        ).unwrap();
    }
    let plan: Vec<String> = database
        .prepare("EXPLAIN QUERY PLAN DELETE FROM public_sessions WHERE expires<=?1")
        .unwrap()
        .query_map([0_i64], |row| row.get(3))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(
        plan.iter()
            .any(|line| line.contains("public_session_expiration")),
        "{plan:?}"
    );
    assert_eq!(
        public(&client, token, "POST", "/api/public/session", None).status,
        200
    );
    let remaining: Vec<String> = database
        .prepare("SELECT digest FROM public_sessions WHERE digest LIKE 'fixture-%'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(remaining, ["fixture-live"]);
    database
        .execute("DROP INDEX public_session_expiration", [])
        .unwrap();
    drop(database);
    drop(server);
    let restarted = start_with_users(&workspace.root, 0, user_store).unwrap();
    let client = Client::new(&restarted);
    assert_eq!(
        public(&client, token, "POST", "/api/public/session", None).status,
        200
    );
    let database =
        rusqlite::Connection::open(directory.path().join(".state/workspace.sqlite")).unwrap();
    let indexed: i64 = database.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='public_session_expiration'",
        [], |row| row.get(0),
    ).unwrap();
    assert_eq!(indexed, 1);
    let retained: i64 = database
        .query_row(
            "SELECT COUNT(*) FROM public_sessions WHERE digest='fixture-live'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 1);
}

#[test]
fn public_passwords_are_atomic_hashed_and_invalidate_old_visitor_cookies() {
    let workspace = Workspace::new();
    workspace.write("shared.md", "# Protected\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document = resource_id(&client, &alice, "default", "shared.md", "document");
    let result = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"document","id":"default","document":document,"permission":"publicEdit",
            "publicOptions":{"expiresAt":null,"password":"private share password"}
        })),
    );
    assert_eq!(result.status, 200, "{}", result.text());
    assert!(!result.text().contains("argon2") && !result.text().contains("private share password"));
    let link = result.json()["publicLinks"]["shared.md"].clone();
    let token = link["token"].as_str().unwrap();
    assert_eq!(link["passwordRequired"], true);
    let challenge = public(&client, token, "POST", "/api/public/session", None).json();
    assert_eq!(challenge["passwordRequired"], true);
    assert!(challenge.get("path").is_none());
    public(
        &client,
        token,
        "GET",
        &format!("/api/public/document?id={document}"),
        None,
    )
    .error(401);
    public(
        &client,
        token,
        "POST",
        "/api/public/session",
        Some(json!({"password":"wrong"})),
    )
    .error(401);
    let unlocked = public(
        &client,
        token,
        "POST",
        "/api/public/session",
        Some(json!({"password":"private share password"})),
    );
    assert_eq!(unlocked.status, 200, "{}", unlocked.text());
    let cookie = unlocked.headers["set-cookie"].split(';').next().unwrap();
    assert!(unlocked.headers["set-cookie"].contains("HttpOnly"));
    assert_eq!(
        client
            .request(
                "GET",
                &format!("/api/public/document?id={document}"),
                &[("X-Notes-Share", token), ("Cookie", cookie)],
                b""
            )
            .status,
        200
    );
    let updated = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"publicOptions","id":"default","document":document,"expiresAt":null,"password":"replacement password"
        })),
    );
    assert_eq!(updated.status, 200, "{}", updated.text());
    client
        .request(
            "GET",
            &format!("/api/public/document?id={document}"),
            &[("X-Notes-Share", token), ("Cookie", cookie)],
            b"",
        )
        .error(401);
    assert_eq!(
        request(&client, &bob, "default", "GET", "/api/shares", None).json(),
        json!([])
    );
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/projects",
        Some(json!({
            "action":"document","id":"default","document":document,"permission":"publicRead",
            "publicOptions":{"expiresAt":null,"password":"short"}
        })),
    )
    .error(400);
    let current = request(&client, &alice, "default", "GET", "/api/shares", None).json();
    assert_eq!(current[0]["access"], "edit");
    assert_eq!(current[0]["passwordRequired"], true);
}
