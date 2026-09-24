use super::*;
use crate::server::markdown;
use std::time::Duration;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let mut random = [0; 8];
        getrandom::fill(&mut random).unwrap();
        let path = PathBuf::from("target")
            .join("server-unit-tests")
            .join(hex(&random));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!("Could not clean backend unit-test fixture: {error}");
        }
    }
}

#[test]
fn unsafe_paths_and_encoded_variants_are_rejected() {
    for path in [
        "../secret.md",
        "notes/../../secret.md",
        "/secret.md",
        "C:/secret.md",
        "C:\\secret.md",
        "\\\\server\\share\\secret.md",
        "notes.md:secret",
        "notes\\..\\secret.md",
        "a//b.md",
        "a/./b.md",
        "nul.md",
        "COM1.md",
        "a./note.md",
        "a /note.md",
        ".git/config.md",
        "NODE_MODULES/note.md",
        "%2e%2e/secret.md",
        "%252e%252e%255csecret.md",
        "bad\0.md",
    ] {
        assert!(validate_relative(path).is_err(), "accepted {path:?}");
    }
    for path in ["目录/中文 笔记.md", "notes/100%.md", "notes/a-b_1.MARKDOWN"] {
        validate_document_path(path).unwrap();
    }
}

#[test]
fn formatting_preserves_bom_and_existing_uniform_newlines() {
    let original = b"\xef\xbb\xbf# title\r\nold\r\n";
    assert_eq!(
        preserve_format(original, "# 标题\nnew\n").unwrap(),
        "\u{feff}# 标题\r\nnew\r\n".as_bytes()
    );
    assert_eq!(preserve_format(b"a\n", "b\r\n").unwrap(), b"b\r\n");
    assert_eq!(preserve_format(b"a\r\nb\n", "x\ny\n").unwrap(), b"x\ny\n");
    assert_eq!(preserve_format(b"a\r", "b\n").unwrap(), b"b\r");
}

#[test]
fn binary_and_oversized_markdown_are_rejected() {
    assert!(validate_content(b"\xff").is_err());
    assert!(validate_content(b"abc\0xyz").is_err());
    assert!(validate_content(&vec![b'a'; MAX_DOCUMENT_BYTES + 1]).is_err());
    assert!(validate_content("Unicode 📝\r\n\t".as_bytes()).is_ok());
}

#[test]
fn traversal_reference_normalization_is_separate_from_api_paths() {
    assert!(validate_relative("guides/../readme.md").is_err());
    assert!(
        markdown::render("guides/page.md", "[readme](../readme.md)")
            .contains("href=\"/readme.md\"")
    );
}

#[test]
fn reading_saving_and_creating_preserve_content_and_versions() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("notes")).unwrap();
    fs::write(
        fixture.0.join("notes").join("原稿.md"),
        "\u{feff}# 原稿\r\nbefore\r\n",
    )
    .unwrap();
    let root = Root::open(&fixture.0).unwrap();
    let original = root.document("notes/原稿.md").unwrap();
    assert_eq!(original.content, "# 原稿\r\nbefore\r\n");
    let saved = root
        .save(
            "notes/原稿.md",
            "# Changed\nafter\n",
            &original.version,
            || Ok(()),
        )
        .unwrap();
    let expected = "\u{feff}# Changed\r\nafter\r\n".as_bytes();
    assert_eq!(saved.version, version(expected));
    assert_eq!(saved.content, "# Changed\r\nafter\r\n");
    assert_eq!(
        fs::read(fixture.0.join("notes").join("原稿.md")).unwrap(),
        expected
    );
    let created = root
        .create("notes/new.markdown", "# New\n📝\n", || Ok(()))
        .unwrap();
    assert_eq!(created.content, "# New\n📝\n");
    assert_eq!(
        root.document("notes/new.markdown").unwrap().version,
        created.version
    );
    assert_eq!(fs::read_dir(fixture.0.join("notes")).unwrap().count(), 2);
}

#[test]
fn tree_limits_report_truncation_and_sort_results() {
    let fixture = Fixture::new();
    let path = &fixture.0;
    fs::create_dir_all(path.join("nested")).unwrap();
    fs::write(path.join("z.md"), "z").unwrap();
    fs::write(path.join("a.md"), "a").unwrap();
    fs::write(path.join("nested").join("b.md"), "b").unwrap();
    {
        let root = Root::open(&path).unwrap();
        let tree = root
            .tree_with_limits(TreeLimits {
                files: 1,
                ..TreeLimits::default()
            })
            .unwrap();
        assert_eq!(tree.files.len(), 1);
        assert!(tree.truncated);
        let tree = root.tree().unwrap();
        assert_eq!(
            tree.files
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            ["a.md", "nested/b.md", "z.md"]
        );
        assert!(!tree.truncated);
        let tree = root
            .tree_with_limits(TreeLimits {
                entries: 1,
                ..TreeLimits::default()
            })
            .unwrap();
        assert!(tree.truncated);
        let tree = root
            .tree_with_limits(TreeLimits {
                depth: 0,
                ..TreeLimits::default()
            })
            .unwrap();
        assert!(tree.truncated);
    }
}

#[test]
fn title_cache_reuses_unchanged_metadata_and_invalidates_on_file_changes() {
    let fixture = Fixture::new();
    let path = fixture.0.join("note.md");
    let body = "# Body\n".repeat(20_000);
    fs::write(&path, format!("---\ntitle: First\n---\n{body}")).unwrap();
    let root = Root::open(&fixture.0).unwrap();
    assert_eq!(
        root.tree().unwrap().files[0].title.as_deref(),
        Some("First")
    );
    assert_eq!(root.title_cache.read().unwrap().len(), 1);
    assert_eq!(
        root.tree().unwrap().files[0].title.as_deref(),
        Some("First")
    );
    fs::write(&path, format!("---\ntitle: Updated title\n---\n{body}")).unwrap();
    assert_eq!(
        root.tree().unwrap().files[0].title.as_deref(),
        Some("Updated title")
    );
}

#[test]
#[ignore = "performance benchmark"]
fn benchmark_cached_tree_scan() {
    const FILES: usize = 1000;
    let fixture = Fixture::new();
    for group in 0..20 {
        fs::create_dir(fixture.0.join(format!("group-{group:02}"))).unwrap();
    }
    for index in 0..FILES {
        fs::write(
            fixture
                .0
                .join(format!("group-{:02}", index % 20))
                .join(format!("note-{index:04}.md")),
            format!("---\ntitle: Note {index}\n---\n# Body\n"),
        )
        .unwrap();
    }
    let root = Root::open(&fixture.0).unwrap();
    assert_eq!(root.tree().unwrap().files.len(), FILES);
    let mut runs = Vec::new();
    for _ in 0..8 {
        let started = std::time::Instant::now();
        assert_eq!(
            std::hint::black_box(root.tree().unwrap()).files.len(),
            FILES
        );
        runs.push(started.elapsed().as_secs_f64() * 1000.0);
    }
    runs.sort_by(f64::total_cmp);
    println!(
        "{{\"files\":{FILES},\"medianMs\":{:.2},\"p95Ms\":{:.2}}}",
        (runs[3] + runs[4]) / 2.0,
        runs[7]
    );
}

#[test]
fn tree_entry_and_time_budgets_bound_non_document_scanning() {
    let fixture = Fixture::new();
    for index in 0..64 {
        fs::write(fixture.0.join(format!("{index}.txt")), "not Markdown").unwrap();
    }
    for directory in [".private", "node_modules", "target", "build"] {
        fs::create_dir(fixture.0.join(directory)).unwrap();
        fs::write(fixture.0.join(directory).join("hidden.md"), "hidden").unwrap();
    }
    let root = Root::open(&fixture.0).unwrap();
    let tree = root
        .tree_with_limits(TreeLimits {
            entries: 3,
            ..TreeLimits::default()
        })
        .unwrap();
    assert!(tree.truncated);
    assert!(tree.files.is_empty());
    let tree = root
        .tree_with_limits(TreeLimits {
            duration: Duration::ZERO,
            ..TreeLimits::default()
        })
        .unwrap();
    assert!(tree.truncated);
    assert!(tree.files.is_empty());
    let tree = root.tree().unwrap();
    assert!(!tree.truncated);
    assert!(tree.files.is_empty());
}

#[test]
fn cancelled_saves_and_failed_replacements_clean_staging_files() {
    use std::cell::Cell;

    let fixture = Fixture::new();
    fs::write(fixture.0.join("note.md"), "original").unwrap();
    let root = Root::open(&fixture.0).unwrap();
    let original = root.document("note.md").unwrap();
    let checks = Cell::new(0);
    let result = root.save("note.md", "changed", &original.version, || {
        checks.set(checks.get() + 1);
        if checks.get() >= 3 {
            Err(ApiError::new(StatusCode::REQUEST_TIMEOUT, "cancelled"))
        } else {
            Ok(())
        }
    });
    assert_eq!(result.unwrap_err().status, StatusCode::REQUEST_TIMEOUT);
    assert_eq!(
        fs::read_to_string(fixture.0.join("note.md")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);

    let checks = Cell::new(0);
    let result = root.create("new.md", "new", || {
        checks.set(checks.get() + 1);
        if checks.get() >= 2 {
            Err(ApiError::new(StatusCode::REQUEST_TIMEOUT, "cancelled"))
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert!(!fixture.0.join("new.md").exists());
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);

    fs::create_dir(fixture.0.join("directory.md")).unwrap();
    let resolved = root.resolve("directory.md").unwrap();
    {
        let mut staged = StagedFile::write(&resolved.parent, b"never published", None).unwrap();
        assert!(staged.commit(&resolved.name, true).is_err());
    }
    assert!(fixture.0.join("directory.md").is_dir());
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 2);
}

#[test]
fn creation_does_not_clobber_a_file_created_during_staging() {
    use std::cell::Cell;

    let fixture = Fixture::new();
    let root = Root::open(&fixture.0).unwrap();
    let checks = Cell::new(0);
    let result = root.create("new.md", "app content", || {
        checks.set(checks.get() + 1);
        if checks.get() == 2 {
            fs::write(fixture.0.join("new.md"), "external content").unwrap();
        }
        Ok(())
    });
    assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(fixture.0.join("new.md")).unwrap(),
        "external content"
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn a_changed_version_after_staging_keeps_external_content_and_cleans_up() {
    use std::cell::Cell;

    let fixture = Fixture::new();
    fs::write(fixture.0.join("note.md"), "original").unwrap();
    let root = Root::open(&fixture.0).unwrap();
    let original = root.document("note.md").unwrap();
    let checks = Cell::new(0);
    let result = root.save("note.md", "app content", &original.version, || {
        checks.set(checks.get() + 1);
        if checks.get() == 2 {
            fs::write(fixture.0.join("replacement.md"), "external content").unwrap();
            fs::rename(fixture.0.join("replacement.md"), fixture.0.join("note.md")).unwrap();
        }
        Ok(())
    });
    assert_eq!(result.unwrap_err().status, StatusCode::CONFLICT);
    assert_eq!(
        fs::read_to_string(fixture.0.join("note.md")).unwrap(),
        "external content"
    );
    assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn symbolic_link_parents_and_final_entries_are_never_followed() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("notes")).unwrap();
    fs::create_dir(fixture.0.join("outside")).unwrap();
    fs::write(fixture.0.join("outside").join("note.md"), "outside").unwrap();
    let outside = fs::canonicalize(fixture.0.join("outside")).unwrap();
    symlink(&outside, fixture.0.join("notes").join("linked")).unwrap();
    symlink(
        outside.join("note.md"),
        fixture.0.join("notes").join("linked.md"),
    )
    .unwrap();
    symlink(
        outside.join("missing.md"),
        fixture.0.join("notes").join("dangling.md"),
    )
    .unwrap();
    let root = Root::open(&fixture.0.join("notes")).unwrap();
    for path in ["linked/note.md", "linked.md", "dangling.md"] {
        assert_eq!(
            root.document(path).unwrap_err().status,
            StatusCode::FORBIDDEN
        );
        assert!(
            root.save(path, "changed", &version(b"outside"), || Ok(()))
                .is_err()
        );
        assert!(root.create(path, "new", || Ok(())).is_err());
    }
    assert!(root.tree().unwrap().files.is_empty());
    assert_eq!(
        fs::read_to_string(outside.join("note.md")).unwrap(),
        "outside"
    );
    assert!(!outside.join("missing.md").exists());
    assert_eq!(fs::read_dir(fixture.0.join("notes")).unwrap().count(), 3);
}

#[cfg(unix)]
#[test]
fn later_requests_keep_the_selected_root_when_its_ancestor_is_swapped() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("container").join("notes")).unwrap();
    fs::create_dir_all(fixture.0.join("outside").join("notes")).unwrap();
    fs::write(
        fixture.0.join("container").join("notes").join("note.md"),
        "inside",
    )
    .unwrap();
    fs::write(
        fixture.0.join("outside").join("notes").join("note.md"),
        "outside",
    )
    .unwrap();
    let root = Root::open(&fixture.0.join("container").join("notes")).unwrap();
    fs::rename(fixture.0.join("container"), fixture.0.join("held")).unwrap();
    symlink(
        fs::canonicalize(fixture.0.join("outside")).unwrap(),
        fixture.0.join("container"),
    )
    .unwrap();
    let original = root.document("note.md").unwrap();
    assert_eq!(original.content, "inside");
    root.save("note.md", "updated", &original.version, || Ok(()))
        .unwrap();
    root.create("new.md", "new inside", || Ok(())).unwrap();
    let tree = root.tree().unwrap();
    assert_eq!(
        tree.files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>(),
        ["new.md", "note.md"]
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("held").join("notes").join("note.md")).unwrap(),
        "updated"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("outside").join("notes").join("note.md")).unwrap(),
        "outside"
    );
    assert!(
        !fixture
            .0
            .join("outside")
            .join("notes")
            .join("new.md")
            .exists()
    );
    assert_eq!(
        fs::read_dir(fixture.0.join("held").join("notes"))
            .unwrap()
            .count(),
        2
    );
}

#[cfg(unix)]
#[test]
fn concurrent_directory_iterators_have_independent_cursors() {
    let fixture = Fixture::new();
    for index in 0..5 {
        fs::write(fixture.0.join(format!("{index}.md")), "note").unwrap();
    }
    let root = Root::open(&fixture.0).unwrap();
    let mut first = root.directory.entries().unwrap();
    let mut first_names = vec![first.next().unwrap().unwrap()];
    let mut second_names = root
        .directory
        .entries()
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    first_names.extend(first.collect::<Result<Vec<_>, _>>().unwrap());
    first_names.sort();
    second_names.sort();
    assert_eq!(first_names.len(), 5);
    assert_eq!(first_names, second_names);
    assert_eq!(root.tree().unwrap().files.len(), 5);
    assert_eq!(root.tree().unwrap().files.len(), 5);
}

#[cfg(unix)]
#[test]
fn abandoned_staging_is_removed_from_the_pinned_parent_after_a_swap() {
    use std::os::unix::fs::symlink;

    let fixture = Fixture::new();
    fs::create_dir_all(fixture.0.join("notes").join("child")).unwrap();
    fs::create_dir(fixture.0.join("outside")).unwrap();
    fs::write(
        fixture.0.join("notes").join("child").join("note.md"),
        "original",
    )
    .unwrap();
    let root = Root::open(&fixture.0.join("notes")).unwrap();
    let resolved = root.resolve("child/note.md").unwrap();
    let staged = StagedFile::write(&resolved.parent, b"unpublished", None).unwrap();
    let staging_name = staged.name.clone();
    fs::write(fixture.0.join("outside").join(&staging_name), "outside").unwrap();
    fs::rename(
        fixture.0.join("notes").join("child"),
        fixture.0.join("notes").join("held"),
    )
    .unwrap();
    symlink(
        fs::canonicalize(fixture.0.join("outside")).unwrap(),
        fixture.0.join("notes").join("child"),
    )
    .unwrap();
    drop(staged);
    assert!(
        !fixture
            .0
            .join("notes")
            .join("held")
            .join(&staging_name)
            .exists()
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("outside").join(&staging_name)).unwrap(),
        "outside"
    );
    assert_eq!(
        fs::read_to_string(fixture.0.join("notes").join("held").join("note.md")).unwrap(),
        "original"
    );
    assert_eq!(fs::read_dir(fixture.0.join("outside")).unwrap().count(), 1);
}

#[test]
fn a_held_parent_cannot_be_replaced_with_an_escaping_directory() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("notes")).unwrap();
    fs::create_dir(fixture.0.join("outside")).unwrap();
    fs::write(fixture.0.join("outside").join("note.md"), "outside").unwrap();
    fs::create_dir(fixture.0.join("notes").join("child")).unwrap();
    let root = Root::open(&fixture.0.join("notes")).unwrap();
    let resolved = root.resolve("child/note.md").unwrap();
    let moved = fs::rename(
        fixture.0.join("notes").join("child"),
        fixture.0.join("notes").join("held"),
    );
    #[cfg(windows)]
    assert!(
        moved.is_err(),
        "Windows allowed a held ancestor to be substituted"
    );
    #[cfg(unix)]
    {
        moved.unwrap();
        std::os::unix::fs::symlink(
            fs::canonicalize(fixture.0.join("outside")).unwrap(),
            fixture.0.join("notes").join("child"),
        )
        .unwrap();
    }
    let mut staged = StagedFile::write(&resolved.parent, b"inside", None).unwrap();
    staged.commit(&resolved.name, false).unwrap();
    assert_eq!(
        fs::read_to_string(fixture.0.join("outside").join("note.md")).unwrap(),
        "outside"
    );
    #[cfg(windows)]
    assert_eq!(
        fs::read_to_string(fixture.0.join("notes").join("child").join("note.md")).unwrap(),
        "inside"
    );
    #[cfg(unix)]
    assert_eq!(
        fs::read_to_string(fixture.0.join("notes").join("held").join("note.md")).unwrap(),
        "inside"
    );
}
