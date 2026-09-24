use super::*;

fn login(client: &Client, username: &str, password: &str) -> String {
    let response = client.request(
        "POST",
        "/api/auth/login",
        &[("Content-Type", "application/json")],
        &serde_json::to_vec(&json!({ "username": username, "password": password })).unwrap(),
    );
    assert_eq!(response.status, 200, "{}", response.text());
    response.headers["set-cookie"]
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

fn assert_logged_out(client: &Client, cookie: &str) {
    let response = client.request("GET", "/api/auth/status", &[("Cookie", cookie)], b"");
    assert_eq!(response.status, 200, "{}", response.text());
    assert_eq!(response.json()["authenticated"], false);
    client
        .request("GET", "/api/tree", &[("Cookie", cookie)], b"")
        .error(401);
}

#[test]
fn restored_sessions_reject_changed_credentials_and_other_roots() {
    let workspace = Workspace::new();
    let users = UserStore::new(workspace.base.join("users.json"));
    users
        .initialize_admin("owner", "owner test password long enough")
        .unwrap();
    users
        .add("writer", "writer test password long enough", Role::User)
        .unwrap();
    let mut server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let cookie = login(
        &Client::new(&server),
        "writer",
        "writer test password long enough",
    );
    server.stop().unwrap();

    let mut other = start_with_users(&workspace.outside, 0, users.clone()).unwrap();
    assert_logged_out(&Client::new(&other), &cookie);
    other.stop().unwrap();

    users
        .set_password("writer", "changed test password long enough")
        .unwrap();
    let mut server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let client = Client::new(&server);
    assert_logged_out(&client, &cookie);
    let next = login(&client, "writer", "changed test password long enough");
    server.stop().unwrap();

    users.remove("writer").unwrap();
    let server = start_with_users(&workspace.root, 0, users).unwrap();
    assert_logged_out(&Client::new(&server), &next);
}

#[test]
fn expired_persistent_sessions_are_rejected_and_corrupt_files_are_preserved() {
    let workspace = Workspace::new();
    let users = UserStore::new(workspace.base.join("users.json"));
    users
        .initialize_admin("owner", "owner test password long enough")
        .unwrap();
    let mut server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    let cookie = login(
        &Client::new(&server),
        "owner",
        "owner test password long enough",
    );
    server.stop().unwrap();
    let path = fs::read_dir(&workspace.base)
        .unwrap()
        .find_map(|entry| {
            let path = entry.unwrap().path();
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("sessions-")
                .then_some(path)
        })
        .unwrap();
    let mut stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for session in stored["sessions"].as_object_mut().unwrap().values_mut() {
        session["expires_at"] = json!(1);
    }
    fs::write(&path, serde_json::to_vec(&stored).unwrap()).unwrap();
    let mut server = start_with_users(&workspace.root, 0, users.clone()).unwrap();
    assert_logged_out(&Client::new(&server), &cookie);
    server.stop().unwrap();
    fs::write(&path, "invalid sessions").unwrap();
    assert!(start_with_users(&workspace.root, 0, users).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "invalid sessions");
}
