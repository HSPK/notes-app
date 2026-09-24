use super::projects::request;
use super::*;

pub(super) fn resource_id(
    client: &Client,
    cookie: &str,
    project: &str,
    path: &str,
    kind: &str,
) -> String {
    let response = request(
        client,
        cookie,
        project,
        "POST",
        "/api/resources/resolve",
        Some(json!({"path":path,"kind":kind})),
    );
    assert_eq!(response.status, 200, "{}", response.text());
    response.json()["id"].as_str().unwrap().into()
}
