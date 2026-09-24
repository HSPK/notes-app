use super::{ApiError, AppState, Work, files, links};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Moved {
    #[serde(flatten)]
    entry: files::MovedEntry,
    references_updated: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

struct Edit {
    original: files::Document,
    content: String,
    saved: Option<files::Document>,
}

pub(super) fn move_entry(
    state: &AppState,
    work: &Work,
    path: &str,
    destination: &str,
    update_links: bool,
) -> Result<Moved, ApiError> {
    let kind = state.root.check_move(path, destination)?;
    let tree = state.root.tree()?;
    if update_links && tree.truncated {
        return Err(ApiError::conflict(
            "The library scan is incomplete. Narrow this project before automatically updating links.",
        ));
    }
    let mut affected = BTreeSet::new();
    let mut edits = Vec::<Edit>::new();
    let mut total = 0;
    for file in tree.files {
        work.check()?;
        let moving = file.path == path || file.path.starts_with(&format!("{path}/"));
        if moving {
            affected.insert(file.path.clone());
        }
        if !update_links {
            continue;
        }
        let document = state.root.source_document(&file.path)?;
        let new_path = if moving {
            format!("{destination}{}", &file.path[path.len()..])
        } else {
            file.path.clone()
        };
        let next = links::rewrite(
            &document.raw_content(),
            &file.path,
            &new_path,
            path,
            destination,
        )?;
        if next != document.raw_content() {
            state.authorize(Some(&file.path), true)?;
            total += next.len() + document.content.len();
            if total > 16 * 1024 * 1024 || edits.len() >= 200 {
                return Err(ApiError::too_large(
                    "Too many notes need reference updates in one operation.",
                ));
            }
            affected.insert(file.path);
            edits.push(Edit {
                original: document,
                content: next,
                saved: None,
            });
        }
    }
    if kind == "file" {
        affected.insert(path.into());
    }
    let mut leases = Vec::new();
    for document in &affected {
        state.collaboration.ensure_inactive(document)?;
        leases.push(state.collaboration.lease(document, state.store.as_ref())?);
        if let Some(store) = &state.store {
            if super::collaboration::has_pending(store, document)? {
                return Err(ApiError::conflict(
                    "Recover and save pending collaborative drafts before updating references.",
                ));
            }
        }
    }
    let result = (|| {
        for edit in &mut edits {
            work.check()?;
            edit.saved = Some(state.save_recorded(
                &edit.original.path,
                &edit.content,
                &edit.original.version,
                state.actor(),
                "rename links",
                || work.check(),
            )?);
        }
        let entry = state.root.move_entry(path, destination)?;
        if let Some(access) = &state.access {
            if let Err(error) = access.relocate_permissions(path, destination) {
                if let Err(rollback) = state.root.move_entry(destination, path) {
                    return Err(ApiError::internal(format!(
                        "The move's permissions could not be stored or rolled back: {} / {}. Repair storage before editing this resource.",
                        error.message, rollback.message
                    )));
                }
                return Err(error);
            }
        }
        Ok(entry)
    })();
    let entry = match result {
        Ok(entry) => entry,
        Err(error) => {
            let mut rollback_failed = false;
            for edit in edits.iter().rev() {
                if let Some(saved) = &edit.saved {
                    if let Err(rollback) = state.save_recorded(
                        &edit.original.path,
                        &edit.original.raw_content(),
                        &saved.version,
                        state.actor(),
                        "restore",
                        || Ok(()),
                    ) {
                        rollback_failed = true;
                        eprintln!(
                            "Reference rollback failed for {}: {}",
                            edit.original.path, rollback.message
                        );
                    }
                }
            }
            if rollback_failed {
                return Err(ApiError::internal(
                    "The rename failed and some reference updates need recovery from History. No conflicting content was overwritten.",
                ));
            }
            return Err(error);
        }
    };
    let mut warning = None;
    for document in &affected {
        state.collaboration.forget(document)?;
        if let Some(store) = &state.store {
            if let Err(error) = store.clear_room(document) {
                eprintln!(
                    "Could not clear moved collaboration state: {}",
                    error.message
                );
                warning=Some("The entry moved, but collaboration metadata could not be refreshed. Reopen after fixing workspace storage.".into());
            }
        }
    }
    if let Some(store) = &state.store {
        if let Err(error) = store.relocate(path, destination) {
            eprintln!("Could not relocate workspace metadata: {}", error.message);
            warning = Some(
                "The entry moved, but history or tab metadata needs recovery from its old path."
                    .into(),
            );
        }
    }
    state
        .index_dirty
        .store(true, std::sync::atomic::Ordering::Release);
    drop(leases);
    Ok(Moved {
        entry,
        references_updated: edits.len(),
        warning,
    })
}
