use std::sync::Arc;

use axum::{
    Json,
    extract::{Extension, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use crate::auth::{
    AuthenticatedUser, Role, SESSION_TTL_SECONDS, normalize_username, validate_password,
};

use super::{
    ApiError, AppState, Work,
    routes::{blocking, json_error},
    security::{authenticated_user, cookie_value, has_launch_authorization},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AuthStatus {
    mode: &'static str,
    setup_required: bool,
    authenticated: bool,
    username: Option<String>,
    role: Option<Role>,
    #[serde(flatten)]
    recovery: Option<super::workspaces::RecoveryIdentity>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Credentials {
    username: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Authenticated {
    username: String,
    role: Role,
    #[serde(flatten)]
    recovery: super::workspaces::RecoveryIdentity,
}

#[derive(Serialize)]
struct AuthenticatedResponse {
    user: Authenticated,
}

pub(super) async fn status(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    headers: HeaderMap,
) -> Result<Json<AuthStatus>, ApiError> {
    let Some(auth) = state.user_auth.clone() else {
        return Ok(Json(AuthStatus {
            mode: "launchToken",
            setup_required: false,
            authenticated: has_launch_authorization(&headers, &state),
            username: None,
            role: None,
            recovery: None,
        }));
    };
    let user = authenticated_user(&headers, &state);
    let recovery = if let Some(user) = &user {
        let username = user.username.clone();
        Some(
            blocking(state.clone(), work.clone(), move |state, _| {
                super::workspaces::recovery_identity(state, &username)
            })
            .await?,
        )
    } else {
        None
    };
    let setup_required = if user.is_some() {
        false
    } else {
        blocking(state, work, move |_, _| {
            auth.setup_required().map_err(ApiError::internal)
        })
        .await?
    };
    Ok(Json(AuthStatus {
        mode: "users",
        setup_required,
        authenticated: user.is_some(),
        username: user.as_ref().map(|user| user.username.clone()),
        role: user.map(|user| user.role),
        recovery,
    }))
}

pub(super) async fn setup(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Credentials>, JsonRejection>,
) -> Result<Response, ApiError> {
    let auth = state.user_auth.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "Password authentication is not enabled.",
        )
    })?;
    let Json(body) = body.map_err(json_error)?;
    let username = normalize_username(&body.username).map_err(ApiError::bad_request)?;
    let mut password = body.password;
    if let Err(error) = validate_password(&password) {
        password.zeroize();
        return Err(ApiError::bad_request(error));
    }
    let result = blocking(state.clone(), work, move |_, _| {
        let result = auth.initialize_admin(&username, &password);
        password.zeroize();
        result.map_err(ApiError::internal)
    })
    .await?;
    let Some((user, token)) = result else {
        return Err(ApiError::conflict(
            "The initial administrator has already been configured.",
        ));
    };
    authenticated_response(&state, user, token).await
}

pub(super) async fn login(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Credentials>, JsonRejection>,
) -> Result<Response, ApiError> {
    let auth = state.user_auth.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::NOT_FOUND,
            "Password authentication is not enabled.",
        )
    })?;
    let Json(body) = body.map_err(json_error)?;
    let username = body.username;
    let mut password = body.password;
    if validate_password(&password).is_err() {
        password.zeroize();
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password.",
        ));
    }
    let result = blocking(state.clone(), work, move |_, _| {
        let result = auth.login(&username, &password);
        password.zeroize();
        result.map_err(ApiError::internal)
    })
    .await?;
    let Some((user, token)) = result else {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid username or password.",
        ));
    };
    authenticated_response(&state, user, token).await
}

pub(super) async fn logout(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if let (Some(auth), Some(token)) = (
        state.user_auth.clone(),
        cookie_value(&headers, &state.user_cookie_name).map(str::to_owned),
    ) {
        blocking(state.clone(), work, move |_, _| {
            auth.logout(&token).map_err(ApiError::internal)
        })
        .await?;
    }
    let mut response = Json(serde_json::json!({"ok": true})).into_response();
    let cookie = format!(
        "{}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
        state.user_cookie_name
    );
    if let Ok(cookie) = HeaderValue::from_str(&cookie) {
        response.headers_mut().insert(header::SET_COOKIE, cookie);
    }
    Ok(response)
}

pub(super) async fn authenticated_response(
    state: &Arc<AppState>,
    user: AuthenticatedUser,
    token: String,
) -> Result<Response, ApiError> {
    let scoped = state.clone();
    let username = user.username.clone();
    let permit = state
        .workers
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| ApiError::internal("The account worker is unavailable."))?;
    let recovery = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        super::workspaces::recovery_identity(&scoped, &username)
    })
    .await
    .map_err(|error| ApiError::internal(error.to_string()))??;
    let mut response = Json(AuthenticatedResponse {
        user: Authenticated {
            username: user.username,
            role: user.role,
            recovery,
        },
    })
    .into_response();
    let cookie = format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={SESSION_TTL_SECONDS}",
        state.user_cookie_name
    );
    let cookie = HeaderValue::from_str(&cookie)
        .map_err(|_| ApiError::internal("Could not establish the login session."))?;
    response.headers_mut().insert(header::SET_COOKIE, cookie);
    Ok(response)
}
