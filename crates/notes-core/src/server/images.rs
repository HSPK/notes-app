use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::{Extension, Query},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};

use super::{ApiError, AppState, Work, routes::blocking};

#[path = "images/process.rs"]
mod process;

#[derive(Deserialize)]
pub(super) struct Upload {
    document: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Uploaded {
    id: String,
    kind: super::state_store::resources::ResourceKind,
    path: String,
    document: String,
    document_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    warning: Option<String>,
}

pub(super) async fn upload(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(query): Query<Upload>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<Uploaded>, ApiError> {
    let mime = headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    blocking(state, work, move |state, work| {
        let document = state.document_path(&query.document)?;
        state.authorize(Some(&document), true)?;
        state.root.document(&document)?;
        let settings = state
            .web_preferences
            .read()
            .map_err(|_| ApiError::internal("Settings are unavailable."))?
            .clone();
        let processed = process::process(&bytes, &mime, &settings)?;
        let directory = match &state.access {
            Some(access) => access.image_directory()?,
            None => state
                .web_preferences
                .read()
                .map_err(|_| ApiError::internal("Settings are unavailable."))?
                .image_directory
                .clone(),
        };
        let _saving = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let document = state.document_path(&query.document)?;
        state.authorize(Some(&document), true)?;
        let path =
            state
                .root
                .store_image(&directory, processed.extension, &processed.bytes, || {
                    work.check()
                })?;
        if let Some(access) = &state.access {
            access.allow_uploaded_image(&document, &path)?;
        }
        let resource = state
            .root
            .resource_store()?
            .identify(&path, super::state_store::resources::ResourceKind::Asset)?;
        Ok(Uploaded {
            id: resource.id,
            kind: resource.kind,
            path,
            document: query.document,
            document_path: document,
            warning: processed.warning,
        })
    })
    .await
    .map(Json)
}
