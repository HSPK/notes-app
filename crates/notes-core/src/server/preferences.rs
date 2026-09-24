use std::sync::Arc;

use axum::{
    Json,
    extract::{Extension, State, rejection::JsonRejection},
};
use serde::{Deserialize, Serialize};

use crate::{appearance::Appearance, settings::WebPreferences};

use super::{
    ApiError, AppState, Work,
    routes::{blocking, json_error},
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Preferences {
    appearance: Appearance,
    web: WebPreferences,
}

pub(super) async fn get(State(state): State<Arc<AppState>>) -> Result<Json<Preferences>, ApiError> {
    let appearance = state
        .appearance
        .read()
        .map_err(|_| ApiError::internal("The appearance settings are unavailable."))?
        .clone();
    let web = state
        .web_preferences
        .read()
        .map_err(|_| ApiError::internal("The Web settings are unavailable."))?
        .clone();
    Ok(Json(Preferences { appearance, web }))
}

pub(super) async fn put(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Preferences>, JsonRejection>,
) -> Result<Json<Preferences>, ApiError> {
    let Json(preferences) = body.map_err(json_error)?;
    preferences
        .appearance
        .validate()
        .map_err(ApiError::bad_request)?;
    preferences.web.validate().map_err(ApiError::bad_request)?;
    let saved = preferences.clone();
    blocking(state, work, move |state, _| {
        let _update = state
            .settings_update
            .lock()
            .map_err(|_| ApiError::internal("The settings update lock is unavailable."))?;
        if let Some(store) = &state.settings_store {
            let mut settings = store
                .load()
                .map_err(ApiError::internal)?
                .unwrap_or_default();
            settings.appearance = saved.appearance.clone();
            settings.web = saved.web.clone();
            store.save(&settings).map_err(ApiError::internal)?;
        }
        *state
            .appearance
            .write()
            .map_err(|_| ApiError::internal("The appearance settings are unavailable."))? =
            saved.appearance.clone();
        *state
            .web_preferences
            .write()
            .map_err(|_| ApiError::internal("The Web settings are unavailable."))? =
            saved.web.clone();
        Ok(saved)
    })
    .await
    .map(Json)
}
