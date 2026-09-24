use super::{
    ApiError, AppState, Work, authentication,
    routes::{blocking, json_error},
    security,
};
use crate::auth::{AccountAction, AccountOverview, AccountResult, AuthService, Role};
use axum::{
    Json,
    extract::{Extension, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use serde::Deserialize;
use std::sync::Arc;
use zeroize::Zeroize;

fn admin(state: &AppState, headers: &HeaderMap) -> Result<(Arc<AuthService>, String), ApiError> {
    let auth = state
        .user_auth
        .clone()
        .ok_or_else(|| ApiError::forbidden("User accounts are not enabled."))?;
    let user = security::authenticated_user(headers, state)
        .filter(|user| user.role == Role::Admin)
        .ok_or_else(|| ApiError::forbidden("Administrator access is required."))?;
    Ok((auth, user.username))
}

pub(super) async fn list(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    headers: HeaderMap,
) -> Result<Json<AccountOverview>, ApiError> {
    let (auth, actor) = admin(&state, &headers)?;
    blocking(state, work, move |_, _| {
        auth.accounts(&actor).map_err(ApiError::internal)
    })
    .await
    .map(Json)
}

pub(super) async fn manage(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    headers: HeaderMap,
    body: Result<Json<AccountAction>, JsonRejection>,
) -> Result<Json<AccountResult>, ApiError> {
    let (auth, actor) = admin(&state, &headers)?;
    let Json(action) = body.map_err(json_error)?;
    blocking(state, work, move |_, _| {
        auth.manage_account(&actor, action)
            .map_err(ApiError::bad_request)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Registration {
    username: String,
    password: String,
    invitation: String,
}

pub(super) async fn register(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Registration>, JsonRejection>,
) -> Result<Response, ApiError> {
    let auth = state
        .user_auth
        .clone()
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "User accounts are not enabled."))?;
    let Json(mut registration) = body.map_err(json_error)?;
    let result = blocking(state.clone(), work, move |_, _| {
        let result = auth.register_invited(
            &registration.invitation,
            &registration.username,
            &registration.password,
        );
        registration.password.zeroize();
        registration.invitation.zeroize();
        result.map_err(ApiError::bad_request)
    })
    .await?;
    authentication::authenticated_response(&state, result.0, result.1).await
}
