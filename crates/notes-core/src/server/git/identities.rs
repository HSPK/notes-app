use super::{Action, ApiError, AppState, FileStatus, Status, files};
use crate::server::state_store::resources::ResourceKind;

pub(super) fn file_status(
    path: &str,
    original_path: Option<&str>,
    index_status: &str,
    worktree_status: &str,
) -> Result<FileStatus, ApiError> {
    files::validate_relative(path)?;
    if let Some(original) = original_path {
        files::validate_relative(original)?;
    }
    Ok(FileStatus {
        id: None,
        kind: if files::is_markdown(path) {
            ResourceKind::Document
        } else {
            ResourceKind::Asset
        },
        path: path.into(),
        original_path: original_path.map(str::to_owned),
        index_status: index_status.into(),
        worktree_status: worktree_status.into(),
    })
}

pub(super) fn identified_status(state: &AppState, mut status: Status) -> Result<Status, ApiError> {
    let store = state.root.resource_store()?;
    for file in &mut status.files {
        let resource = match store.resource_at_path(&file.path, true)? {
            Some(resource) => resource,
            None => store.identify(&file.path, file.kind)?,
        };
        file.id = Some(resource.id);
        file.kind = resource.kind;
    }
    Ok(status)
}

pub(super) fn resolve_action(state: &AppState, action: &mut Action) -> Result<(), ApiError> {
    match action {
        Action::Stage { paths } | Action::Unstage { paths } => {
            for id in paths.iter_mut() {
                *id = state.root.resource_store()?.resource(id, true)?.path;
            }
        }
        _ => {}
    }
    Ok(())
}
