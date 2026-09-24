use super::{
    ApiError, AppState, Work, files,
    routes::{blocking, json_error},
    state_store::resources::{Resource, ResourceKind},
};
use axum::{
    Json,
    extract::{
        Extension, Query,
        rejection::{JsonRejection, QueryRejection},
    },
    http::{HeaderValue, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Deserialize)]
pub(super) struct QueryId {
    pub id: String,
}

#[derive(Deserialize)]
pub(super) struct AssetQuery {
    id: String,
    document: Option<String>,
}

pub(super) async fn asset(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    query: Result<Query<AssetQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(|error| {
        ApiError::bad_request(format!("Invalid asset query: {}", error.body_text()))
    })?;
    let asset = blocking(state, work, move |state, _| {
        let path = state.resource_path(&query.id, ResourceKind::Asset, false)?;
        let document = query
            .document
            .as_deref()
            .map(|id| state.document_path(id))
            .transpose()?;
        if let Some(access) = &state.access {
            access.asset(&path, document.as_deref())?;
        }
        state.root.asset(&path)
    })
    .await?;
    let mut response = ([(header::CONTENT_TYPE, asset.mime)], asset.bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static(if asset.download {
            "attachment"
        } else {
            "inline"
        }),
    );
    Ok(response)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Resolve {
    path: String,
    kind: ResourceKind,
    document: Option<String>,
}

#[derive(Serialize)]
pub(super) struct Resolved {
    #[serde(flatten)]
    resource: Resource,
}

impl AppState {
    pub(super) fn resource_path(
        &self,
        id: &str,
        kind: ResourceKind,
        deleted: bool,
    ) -> Result<String, ApiError> {
        let resource = self.root.resource_store()?.resource(id, deleted)?;
        if resource.kind != kind {
            return Err(ApiError::bad_request(
                "The resource ID has a different type.",
            ));
        }
        Ok(resource.path)
    }

    pub(super) fn document_path(&self, id: &str) -> Result<String, ApiError> {
        self.resource_path(id, ResourceKind::Document, false)
    }

    fn resource_access(&self, resource: &Resource, document: Option<&str>) -> Result<(), ApiError> {
        match resource.kind {
            ResourceKind::Document | ResourceKind::Directory => {
                self.authorize(Some(&resource.path), false)
            }
            ResourceKind::Asset => match &self.access {
                Some(access) => {
                    let document = document.map(|id| self.document_path(id)).transpose()?;
                    access.asset(&resource.path, document.as_deref())
                }
                None => self.authorize(None, false),
            },
        }
    }
}

pub(super) async fn get(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(query): Query<QueryId>,
) -> Result<Json<Resolved>, ApiError> {
    blocking(state, work, move |state, _| {
        let resource = state.root.resource_store()?.resource(&query.id, false)?;
        state.resource_access(&resource, None)?;
        Ok(Resolved { resource })
    })
    .await
    .map(Json)
}

pub(super) async fn resolve(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Resolve>, JsonRejection>,
) -> Result<Json<Resolved>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, _| {
        files::validate_relative(&body.path)?;
        if body.kind == ResourceKind::Asset && files::is_markdown(&body.path) {
            return Err(ApiError::bad_request(
                "Markdown files must use document identities.",
            ));
        }
        if body.kind == ResourceKind::Document {
            files::validate_document_path(&body.path)?;
        }
        let resource = Resource {
            id: String::new(),
            project: state.root.resource_store()?.project.clone(),
            path: body.path,
            kind: body.kind,
            deleted: false,
        };
        state.resource_access(&resource, body.document.as_deref())?;
        let path = if body.kind == ResourceKind::Directory {
            let tree = state.root.tree()?;
            tree.directories
                .iter()
                .find(|entry| entry.path == resource.path)
                .map(|entry| entry.path.clone())
                .ok_or_else(|| {
                    ApiError::new(
                        axum::http::StatusCode::NOT_FOUND,
                        "This folder does not exist.",
                    )
                })?
        } else {
            state.root.canonical_file_path(&resource.path)?
        };
        Ok(Resolved {
            resource: state.root.resource_store()?.identify(&path, body.kind)?,
        })
    })
    .await
    .map(Json)
}
