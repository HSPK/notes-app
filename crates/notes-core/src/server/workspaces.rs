use super::{
    ApiError, AppState, Work, files,
    routes::{blocking, json_error},
    state_store::workspaces::{WorkspaceAction, WorkspaceState},
};
use crate::auth::AuthenticatedUser;
use axum::{
    Json,
    extract::{Extension, State, rejection::JsonRejection},
};
use serde::Serialize;
use std::sync::Arc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryIdentity {
    pub id: String,
    pub scope: String,
    pub draft_key: String,
}

fn account_id(state: &AppState, username: &str) -> Result<String, ApiError> {
    state
        .user_auth
        .as_ref()
        .ok_or_else(|| ApiError::forbidden("A user account is required."))?
        .user_store()
        .account_id(username)
        .map_err(ApiError::internal)
}

pub(super) fn recovery_identity(
    state: &AppState,
    username: &str,
) -> Result<RecoveryIdentity, ApiError> {
    let id = account_id(state, username)?;
    let store = state
        .projects
        .as_ref()
        .ok_or_else(|| ApiError::internal("Projects are unavailable."))?
        .storage()?;
    Ok(RecoveryIdentity {
        draft_key: store.user_key(&id)?,
        id,
        scope: state.user_cookie_name.clone(),
    })
}

pub(super) async fn get(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
) -> Result<Json<WorkspaceState>, ApiError> {
    let Extension(user) = user.ok_or_else(|| ApiError::forbidden("A user account is required."))?;
    blocking(state, work, move |state, _| {
        let id = account_id(state, &user.username)?;
        state
            .projects
            .as_ref()
            .ok_or_else(|| ApiError::internal("Projects are unavailable."))?
            .storage()?
            .workspace(&id)
    })
    .await
    .map(Json)
}

pub(super) async fn change(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
    headers: axum::http::HeaderMap,
    body: Result<Json<WorkspaceAction>, JsonRejection>,
) -> Result<Json<WorkspaceState>, ApiError> {
    let Extension(user) = user.ok_or_else(|| ApiError::forbidden("A user account is required."))?;
    let Json(action) = body.map_err(json_error)?;
    blocking(state, work, move |state, _| {
        let id = account_id(state, &user.username)?;
        if headers
            .get("x-notes-user")
            .and_then(|header| header.to_str().ok())
            .is_some_and(|expected| expected != id)
        {
            return Err(ApiError::forbidden(
                "This workspace request belongs to another signed-in account.",
            ));
        }
        let (project, resource_id) = action.target();
        let registry = state
            .projects
            .as_ref()
            .ok_or_else(|| ApiError::internal("Projects are unavailable."))?;
        let resource = registry
            .storage()?
            .resource(resource_id, !action.needs_access())?;
        if resource.project != project
            || resource.kind != super::state_store::resources::ResourceKind::Document
        {
            return Err(ApiError::forbidden(
                "This workspace resource belongs to a different project or type.",
            ));
        }
        let path = &resource.path;
        files::validate_document_path(path)?;
        let title = if action.needs_access() {
            let access = registry.resolve(project, &user)?;
            access.check(Some(path), false)?;
            let document = access.library.root.source_document(path)?;
            Some(document.title.unwrap_or(document.path))
        } else {
            None
        };
        registry.storage()?.change_workspace(
            &id,
            action.with_path(resource.path),
            title,
            &resource.id,
        )
    })
    .await
    .map(Json)
}
