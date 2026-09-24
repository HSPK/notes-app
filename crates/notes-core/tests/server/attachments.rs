use super::projects::{login, png, request, resource_id, users};
use super::*;

#[test]
fn attachment_recycling_checks_references_and_preserves_bytes_in_the_recycle_bin() {
    let workspace = Workspace::new();
    workspace.write("note.md", "![Used](used.png)\n");
    workspace.write("used.png", png());
    workspace.write("unused.png", png());
    workspace.write("settings.json", b"{\"keep\":true}");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let bob = login(&client, "bob");
    request(&client, &bob, "default", "GET", "/api/attachments", None).error(403);
    let scan = request(&client, &alice, "default", "GET", "/api/attachments", None).json();
    assert_eq!(scan["files"].as_array().unwrap().len(), 2);
    let unused = scan["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "unused.png")
        .unwrap();
    let selection = json!({"files":[{"id":unused["id"],"stamp":unused["stamp"]}]});
    workspace.write(
        "note.md",
        "![Used](used.png)\n![New reference](unused.png)\n",
    );
    request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/attachments",
        Some(selection.clone()),
    )
    .error(409);
    workspace.write("note.md", "![Used](used.png)\n");
    let recycled = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/attachments",
        Some(selection),
    );
    assert_eq!(recycled.status, 200, "{}", recycled.text());
    assert!(!workspace.root.join("unused.png").exists());
    assert!(workspace.root.join("used.png").exists());
    assert!(workspace.root.join("settings.json").exists());
    let trash = request(&client, &alice, "default", "GET", "/api/trash", None).json();
    assert_eq!(trash[0]["kind"], "asset");
    let restored = request(
        &client,
        &alice,
        "default",
        "POST",
        "/api/trash/restore",
        Some(json!({"id":trash[0]["id"]})),
    );
    assert_eq!(restored.status, 200, "{}", restored.text());
    assert_eq!(fs::read(workspace.root.join("unused.png")).unwrap(), png());
}

#[test]
fn image_processing_resizes_exactly_and_composites_jpeg_transparency_on_white() {
    let workspace = Workspace::new();
    workspace.write("note.md", "# Note\n");
    let server = start_with_users(&workspace.root, 0, users(&workspace)).unwrap();
    let client = Client::new(&server);
    let alice = login(&client, "alice");
    let document = resource_id(&client, &alice, "default", "note.md", "document");
    let mut preferences =
        request(&client, &alice, "default", "GET", "/api/preferences", None).json();
    preferences["web"]["imageCompression"] = json!("jpeg");
    preferences["web"]["imageMaxEdge"] = json!(256);
    preferences["web"]["imageQuality"] = json!(85);
    assert_eq!(
        request(
            &client,
            &alice,
            "default",
            "PUT",
            "/api/preferences",
            Some(preferences)
        )
        .status,
        200
    );
    let mut output = std::io::Cursor::new(Vec::new());
    image::RgbaImage::from_pixel(512, 256, image::Rgba([255, 0, 0, 128]))
        .write_to(&mut output, image::ImageFormat::Png)
        .unwrap();
    let uploaded = client.request(
        "POST",
        &format!("/api/images?document={document}"),
        &[("Cookie", &alice), ("Content-Type", "image/png")],
        &output.into_inner(),
    );
    assert_eq!(uploaded.status, 200, "{}", uploaded.text());
    let path = uploaded.json()["path"].as_str().unwrap().to_owned();
    assert!(path.ends_with(".jpg"));
    let image = image::open(workspace.root.join(path)).unwrap().into_rgb8();
    assert_eq!(image.dimensions(), (256, 128));
    let pixel = image.get_pixel(100, 50);
    assert!(pixel[0] >= 245 && pixel[1].abs_diff(127) <= 10 && pixel[2].abs_diff(127) <= 10);
}
