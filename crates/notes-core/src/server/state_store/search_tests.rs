use super::*;
use std::{cell::Cell, fs, path::PathBuf, sync::Arc};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let mut random = [0; 12];
        getrandom::fill(&mut random).unwrap();
        Self(
            std::env::current_dir()
                .unwrap()
                .join("target/search-tests")
                .join(crate::server::hex(&random)),
        )
    }
    fn store(&self) -> Arc<Store> {
        Store::open(&self.0.join("workspace.sqlite")).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            eprintln!(
                "Could not remove search fixture {}: {error}",
                self.0.display()
            );
        }
    }
}

fn document(path: &str, content: &str, version: char) -> files::Document {
    files::Document {
        id: None,
        project: None,
        references: Vec::new(),
        path: path.into(),
        content: content.into(),
        title: None,
        warning: None,
        bom: false,
        html: String::new(),
        version: version.to_string().repeat(64),
    }
}

#[test]
fn cancelled_index_write_rolls_back_both_metadata_and_full_text_rows() {
    let fixture = Fixture::new();
    let store = fixture.store();
    let project = store.project("project");
    let old = document("note.md", "# Before\n", '1');
    project.index_document(&old, "old", || Ok(())).unwrap();
    let replacement = document("note.md", "# After\n", '2');
    let calls = Cell::new(0);
    let result = project.index_document(&replacement, "new", || {
        calls.set(calls.get() + 1);
        if calls.get() == 2 {
            Err(ApiError::internal("Cancelled fixture"))
        } else {
            Ok(())
        }
    });
    assert!(result.is_err());
    assert_eq!(
        project.indexed_stamp("note.md").unwrap().as_deref(),
        Some("old")
    );
    for (query, count) in [("Before", 1), ("After", 0)] {
        let found = store
            .search(&["project".into()], query, Field::All, &[], |_, _, _| {
                Ok(true)
            })
            .unwrap();
        assert_eq!(found.results.len(), count);
    }
    project
        .index_document(&replacement, "new", || Ok(()))
        .unwrap();
    let found = store
        .search(&["project".into()], "After", Field::All, &[], |_, _, _| {
            Ok(true)
        })
        .unwrap();
    assert_eq!(found.results.len(), 1);
}
