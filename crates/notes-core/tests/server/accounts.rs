use super::*;

fn request(
    client: &Client,
    cookie: &str,
    method: &str,
    endpoint: &str,
    body: Option<Value>,
) -> Reply {
    client.request(
        method,
        endpoint,
        &[("Cookie", cookie), ("Content-Type", "application/json")],
        &body
            .map(|body| serde_json::to_vec(&body).unwrap())
            .unwrap_or_default(),
    )
}
fn cookie(reply: &Reply) -> String {
    assert_eq!(reply.status, 200, "{}", reply.text());
    reply.headers["set-cookie"]
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

#[test]
fn invitation_signup_is_single_use_and_admin_actions_revoke_sessions() {
    let workspace = Workspace::new();
    let store = UserStore::new(workspace.base.join("users.json"));
    store
        .initialize_admin("owner", "owner test password long enough")
        .unwrap();
    let server = start_with_users(&workspace.root, 0, store.clone()).unwrap();
    let client = Client::new(&server);
    let owner = cookie(&request(
        &client,
        "",
        "POST",
        "/api/auth/login",
        Some(json!({
            "username": "owner", "password": "owner test password long enough"
        })),
    ));
    request(&client, "", "GET", "/api/admin/accounts", None).error(401);
    let invitation = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({
            "action": "invite", "hours": 24
        })),
    );
    assert_eq!(invitation.status, 200, "{}", invitation.text());
    let code = invitation.json()["code"].as_str().unwrap().to_owned();
    let stored = fs::read_to_string(store.path()).unwrap();
    assert!(!stored.contains(&code));
    assert!(!stored.contains(code.split_once('.').unwrap().1));
    let guest = cookie(&request(
        &client,
        "",
        "POST",
        "/api/auth/register",
        Some(json!({
            "username": "guest", "password": "guest test password long enough", "invitation": code
        })),
    ));
    request(&client, "", "POST", "/api/auth/register", Some(json!({
        "username": "another", "password": "another test password long enough", "invitation": code
    }))).error(400);
    request(&client, &guest, "GET", "/api/admin/accounts", None).error(403);
    request(
        &client,
        &guest,
        "POST",
        "/api/admin/accounts",
        Some(json!({"action":"invite","hours":24})),
    )
    .error(403);
    let list = request(&client, &owner, "GET", "/api/admin/accounts", None);
    assert_eq!(list.json()["users"].as_array().unwrap().len(), 2);
    assert_eq!(list.json()["invitations"][0]["usedBy"], "guest");
    assert!(!list.text().contains(code.split_once('.').unwrap().1));
    for action in [
        json!({"action":"delete","username":"owner"}),
        json!({"action":"role","username":"owner","role":"user"}),
    ] {
        request(&client, &owner, "POST", "/api/admin/accounts", Some(action)).error(400);
    }
    let reset = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({
            "action":"password","username":"guest","password":"replacement test password long enough"
        })),
    );
    assert_eq!(reset.status, 200, "{}", reset.text());
    request(&client, &guest, "GET", "/api/tree", None).error(401);
    let promoted = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({
            "action":"role","username":"guest","role":"admin"
        })),
    );
    assert_eq!(promoted.status, 200, "{}", promoted.text());
    let deleted = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({
            "action":"delete","username":"guest"
        })),
    );
    assert_eq!(deleted.status, 200, "{}", deleted.text());
    assert_eq!(store.list().unwrap().len(), 1);
}

#[test]
fn racing_registrations_consume_one_invitation_once_and_revoked_keys_fail() {
    let workspace = Workspace::new();
    let users = UserStore::new(workspace.base.join("users.json"));
    users
        .initialize_admin("owner", "owner test password long enough")
        .unwrap();
    let first = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let second = start_with_users(&workspace.outside, 0, users).unwrap();
    let client = Client::new(&first);
    let owner = cookie(&request(
        &client,
        "",
        "POST",
        "/api/auth/login",
        Some(json!({
            "username":"owner", "password":"owner test password long enough"
        })),
    ));
    let created = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({"action":"invite","hours":1})),
    )
    .json();
    let code = created["code"].as_str().unwrap().to_owned();
    let barrier = Arc::new(Barrier::new(3));
    let handles = [client.clone(), Client::new(&second)].into_iter().enumerate().map(|(index, client)| {
        let barrier = barrier.clone();
        let code = code.clone();
        thread::spawn(move || {
            barrier.wait();
            request(&client, "", "POST", "/api/auth/register", Some(json!({
                "username": format!("guest{index}"), "password":"guest test password long enough", "invitation":code
            }))).status
        })
    }).collect::<Vec<_>>();
    barrier.wait();
    let statuses = handles
        .into_iter()
        .map(|handle| handle.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(statuses.iter().filter(|status| **status == 200).count(), 1);
    assert_eq!(statuses.iter().filter(|status| **status == 400).count(), 1);
    let created = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({"action":"invite","hours":24})),
    )
    .json();
    let code = created["code"].as_str().unwrap();
    let revoked = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({
            "action":"revokeInvite","id":code.split_once('.').unwrap().0
        })),
    );
    assert_eq!(revoked.status, 200);
    request(
        &client,
        "",
        "POST",
        "/api/auth/register",
        Some(json!({
            "username":"rejected","password":"guest test password long enough","invitation":code
        })),
    )
    .error(400);
}

#[test]
fn expired_invitation_cannot_create_an_account() {
    let workspace = Workspace::new();
    let users = UserStore::new(workspace.base.join("users.json"));
    users
        .initialize_admin("owner", "owner test password long enough")
        .unwrap();
    let server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let client = Client::new(&server);
    let owner = cookie(&request(
        &client,
        "",
        "POST",
        "/api/auth/login",
        Some(json!({
            "username": "owner", "password": "owner test password long enough"
        })),
    ));
    let created = request(
        &client,
        &owner,
        "POST",
        "/api/admin/accounts",
        Some(json!({
            "action": "invite", "hours": 1
        })),
    )
    .json();
    let code = created["code"].as_str().unwrap();
    let id = code.split_once('.').unwrap().0;
    let mut database: Value = serde_json::from_slice(&fs::read(users.path()).unwrap()).unwrap();
    database["invitations"][id]["created_at"] = json!(0);
    database["invitations"][id]["expires_at"] = json!(1);
    fs::write(users.path(), serde_json::to_vec(&database).unwrap()).unwrap();
    request(
        &client,
        "",
        "POST",
        "/api/auth/register",
        Some(json!({
            "username": "expired", "password": "guest test password long enough", "invitation": code
        })),
    )
    .error(400);
    assert_eq!(users.list().unwrap().len(), 1);
}
