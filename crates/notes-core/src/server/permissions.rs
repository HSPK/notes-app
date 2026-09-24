use super::{ApiError, AppState};
use axum::{
    extract::{Extension, Query, rejection::QueryRejection},
    http::{HeaderName, HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Copy, Serialize)]
pub(super) struct DocumentPermissions {
    pub writable: bool,
    pub collaborative: bool,
    pub owner: bool,
}

impl AppState {
    pub(super) fn document_permissions(&self, path: &str) -> Result<DocumentPermissions, ApiError> {
        match &self.access {
            Some(access) => access.document_permissions(path),
            None if self.user_auth.is_none() => Ok(DocumentPermissions {
                writable: true,
                collaborative: true,
                owner: true,
            }),
            None => Err(ApiError::forbidden("Select an accessible project first.")),
        }
    }

    pub(super) fn authorize_collaboration(&self, path: &str) -> Result<(), ApiError> {
        if !self.document_permissions(path)?.collaborative {
            return Err(ApiError::forbidden(
                "Collaborative editing requires explicit shared editing permission.",
            ));
        }
        Ok(())
    }
}

#[derive(serde::Deserialize)]
pub(super) struct DocumentQuery {
    id: String,
}

pub(super) async fn document(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<super::Work>>,
    query: Result<Query<DocumentQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(|error| ApiError::bad_request(error.body_text()))?;
    let (json, permissions) = super::routes::blocking(state, work, move |state, _| {
        let path = state.document_path(&query.id)?;
        let permissions = state.document_permissions(&path)?;
        let path = state.root.canonical_document_path(&path)?;
        let permissions = serde_json::to_string(&permissions)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        let json = state.root.document_json(&path)?;
        if state.document_path(&query.id)? != path {
            return Err(ApiError::conflict(
                "This document moved while it was being read. Retry using the same document ID.",
            ));
        }
        Ok((json, permissions))
    })
    .await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            ),
            (
                HeaderName::from_static("x-notes-document-permissions"),
                HeaderValue::from_str(&permissions)
                    .map_err(|error| ApiError::internal(error.to_string()))?,
            ),
        ],
        json,
    )
        .into_response())
}
