use super::projects::resource_id;
use super::*;

#[test]
fn participation_does_not_keep_room_leases_alive_after_server_shutdown() {
    use super::projects::{login, request, users};
    let workspace = Workspace::new();
    workspace.write("note.md", "# Shared\n");
    let store = users(&workspace);
    let open_room = |server: &RunningServer| {
        let client = Client::new(server);
        let alice = login(&client, "alice");
        let bob = login(&client, "bob");
        let document = resource_id(&client, &alice, "default", "note.md", "document");
        let post = |user: &str, endpoint: &str, body: Value| {
            request(&client, user, "default", "POST", endpoint, Some(body))
        };
        assert_eq!(
            post(
                &alice,
                "/api/projects",
                json!({"action":"share","id":"default","shared":"edit"})
            )
            .status,
            200
        );
        let a = post(
            &alice,
            "/api/collaboration/presence",
            json!({"document":document}),
        )
        .json();
        let b = post(
            &bob,
            "/api/collaboration/presence",
            json!({"document":document}),
        )
        .json();
        for (user, participant) in [(&alice, &a["participant"]), (&bob, &b["participant"])] {
            assert_eq!(
                post(
                    user,
                    "/api/collaboration/presence",
                    json!({"document":document,"participant":participant,"ready":true})
                )
                .status,
                200
            );
        }
        let joined = post(
            &alice,
            "/api/collaboration/join",
            json!({"document":document,"participant":a["participant"]}),
        );
        assert_eq!(joined.status, 200, "{}", joined.text());
        joined.json()["roomId"].as_str().unwrap().to_owned()
    };
    let first = start_with_users(&workspace.root, 0, store.clone()).unwrap();
    let room = open_room(&first);
    drop(first);
    let second = start_with_users(&workspace.root, 0, store).unwrap();
    assert_eq!(open_room(&second), room);
}

#[test]
fn collaboration_tickets_require_authentication_and_document_identities() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let users = UserStore::new(workspace.base.join("users.json"));
    users
        .initialize_admin("owner", "owner test password long enough")
        .unwrap();
    let server = start_with_users(&workspace.root, 0, users).unwrap();
    let client = Client::new(&server);
    let missing = "01961e0b-9831-7000-8000-000000000002";
    let body = serde_json::to_vec(&json!({"document":missing,"roomId":null})).unwrap();
    client
        .request(
            "POST",
            "/api/collaboration/join",
            &[("Content-Type", "application/json")],
            &body,
        )
        .error(401);
    let logged = client.request(
        "POST",
        "/api/auth/login",
        &[("Content-Type", "application/json")],
        &serde_json::to_vec(
            &json!({"username":"owner","password":"owner test password long enough"}),
        )
        .unwrap(),
    );
    let cookie = logged.headers["set-cookie"].split(';').next().unwrap();
    let document = resource_id(&client, cookie, "default", "note.md", "document");
    client
        .request(
            "POST",
            "/api/collaboration/join",
            &[
                ("Content-Type", "application/json"),
                ("Cookie", cookie),
                ("Origin", "http://example.invalid"),
            ],
            &body,
        )
        .error(403);
    let join = |document: &str, room: Option<&str>| {
        client.request(
            "POST",
            "/api/collaboration/join",
            &[("Content-Type", "application/json"), ("Cookie", cookie)],
            &serde_json::to_vec(&json!({"document":document,"roomId":room})).unwrap(),
        )
    };
    join("../outside/secret.md", None).error(400);
    join(missing, None).error(404);
    join(&document, None).error(403);
    join(&document, Some("a different room")).error(403);
}

#[test]
fn shared_editing_requires_distinct_people_and_all_solo_drafts_to_be_ready() {
    use super::projects::{login, request, users};
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    let call = |cookie: &str, endpoint: &str, body: Value| {
        request(&client, cookie, "default", "POST", endpoint, Some(body))
    };
    assert_eq!(
        call(
            &alice,
            "/api/projects",
            json!({"action":"share","id":"default","shared":"edit"})
        )
        .status,
        200
    );
    let watch = |cookie: &str, id: Option<&str>, ready: bool| {
        call(
            cookie,
            "/api/collaboration/presence",
            json!({"document":document,"participant":id,"ready":ready}),
        )
    };
    let a = watch(&alice, None, false).json();
    let aid = a["participant"].as_str().unwrap();
    assert_eq!(a["phase"], "solo");
    let a2 = watch(&alice, None, false).json();
    let a2id = a2["participant"].as_str().unwrap();
    assert_eq!(a2["phase"], "solo");
    call(
        &alice,
        "/api/collaboration/join",
        json!({"document":document,"participant":aid}),
    )
    .error(425);
    call(
        &alice,
        "/api/collaboration/join",
        json!({"document":document,"roomId":"made-up-room"}),
    )
    .error(409);
    let b = watch(&bob, None, false).json();
    let bid = b["participant"].as_str().unwrap();
    assert_eq!(b["phase"], "prepare");
    watch(&alice, Some(bid), true).error(403);
    assert_eq!(watch(&alice, Some(aid), true).json()["phase"], "prepare");
    assert_eq!(watch(&alice, Some(a2id), true).json()["phase"], "prepare");
    let baseline = request(
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
        &bob,
        "default",
        "PUT",
        "/api/document",
        Some(json!({"id":document,"version":baseline["version"],"content":"# Draft flushed\n"})),
    );
    assert_eq!(saved.status, 200, "{}", saved.text());
    assert_eq!(watch(&bob, Some(bid), true).json()["phase"], "join");
    request(&client, &alice, "default", "PUT", "/api/document",
        Some(json!({"id":document,"version":saved.json()["version"],"content":"Must not race activation"}))).error(409);
    let joined = call(
        &alice,
        "/api/collaboration/join",
        json!({"document":document,"participant":aid}),
    );
    assert_eq!(joined.status, 200, "{}", joined.text());
    assert_eq!(joined.json()["ticket"].as_str().unwrap().len(), 48);
    assert_eq!(
        call(
            &alice,
            "/api/collaboration/presence",
            json!({"document":document,"participant":aid,"leave":true})
        )
        .status,
        200
    );
    watch(&alice, Some(aid), true).error(410);
    assert_eq!(
        fs::read_to_string(workspace.root.join("note.md")).unwrap(),
        "# Draft flushed\n"
    );
    assert_eq!(
        call(
            &alice,
            "/api/projects",
            json!({"action":"document","id":"default","document":document,"permission":"private"})
        )
        .status,
        200
    );
    call(
        &alice,
        "/api/collaboration/join",
        json!({"document":document,"roomId":joined.json()["roomId"]}),
    )
    .error(403);
    watch(&bob, Some(bid), true).error(403);
}

#[test]
fn document_capabilities_separate_owner_writes_from_explicit_shared_editing() {
    use super::projects::{login, request, users};
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    let capabilities = |cookie: &str| {
        let reply = request(
            &client,
            cookie,
            "default",
            "GET",
            &format!("/api/document?id={document}"),
            None,
        );
        assert_eq!(reply.status, 200, "{}", reply.text());
        serde_json::from_str::<Value>(&reply.headers["x-notes-document-permissions"]).unwrap()
    };
    assert_eq!(
        capabilities(&alice),
        json!({"writable":true,"collaborative":false,"owner":true})
    );
    for (level, collaborative, bob_write) in [
        ("read", false, false),
        ("edit", true, true),
        ("private", false, false),
    ] {
        let changed = request(
            &client,
            &alice,
            "default",
            "POST",
            "/api/projects",
            Some(
                json!({"action":"document","id":"default","document":document,"permission":level}),
            ),
        );
        assert_eq!(changed.status, 200, "{}", changed.text());
        assert_eq!(
            capabilities(&alice),
            json!({"writable":true,"collaborative":collaborative,"owner":true})
        );
        if level == "private" {
            request(
                &client,
                &bob,
                "default",
                "GET",
                &format!("/api/document?id={document}"),
                None,
            )
            .error(403);
        } else {
            assert_eq!(
                capabilities(&bob),
                json!({"writable":bob_write,"collaborative":collaborative,"owner":false})
            );
        }
    }
}
