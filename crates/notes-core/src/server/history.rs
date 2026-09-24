use std::sync::Arc;

use axum::{
    Json,
    extract::{Extension, Query, rejection::JsonRejection},
};
use serde::Deserialize;

use super::{
    ApiError, AppState, Library, Work, files,
    routes::{blocking, json_error},
    state_store::{ProjectStore, Revision, RevisionContent, TrashEntry},
};

impl Library {
    pub(super) fn save_recorded(
        &self,
        path: &str,
        content: &str,
        version: &str,
        actor: &str,
        kind: &str,
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<files::Document, ApiError> {
        if let Some(store) = &self.store {
            let original = self.root.document(path)?;
            if original.version != version {
                return Err(ApiError::conflict(
                    "The document changed before saving. Reload its current version.",
                ));
            }
            store.record(&original, "Disk", "baseline")?;
        }
        let saved = if kind == "restore" {
            self.root.restore(path, content, version, check)?
        } else {
            self.root.save(path, content, version, check)?
        };
        Ok(self.record_saved(saved, actor, kind))
    }

    pub(super) fn record_saved(
        &self,
        mut document: files::Document,
        actor: &str,
        kind: &str,
    ) -> files::Document {
        if let Some(store) = &self.store {
            if let Err(error) = store.record(&document, actor, kind) {
                eprintln!("Could not record document history: {}", error.message);
                document.warning = Some("The document was saved, but history could not be updated. Contact the project owner.".into());
            }
            if let Err(error) = store.invalidate_index(&document.path, &document.version) {
                eprintln!("Could not invalidate the search index: {}", error.message);
                document.warning =
                    Some("The document was saved, but search indexing needs to be retried.".into());
            }
            self.index_dirty
                .store(true, std::sync::atomic::Ordering::Release);
        }
        document
    }

    pub(super) fn history_store(&self) -> Result<&ProjectStore, ApiError> {
        self.store
            .as_ref()
            .ok_or_else(|| ApiError::forbidden("History requires a user project."))
    }
}

impl AppState {
    pub(super) fn actor(&self) -> &str {
        self.access
            .as_ref()
            .map(|access| access.actor())
            .unwrap_or("Local service")
    }
}

#[derive(Deserialize)]
pub(super) struct HistoryQuery {
    document: String,
    revision: Option<i64>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct HistoryList {
    revisions: Vec<Revision>,
    current_version: Option<String>,
}

pub(super) async fn list(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<HistoryList>, ApiError> {
    blocking(state, work, move |state, _| {
        state.owner()?;
        let resource = state
            .root
            .resource_store()?
            .resource(&query.document, true)?;
        let path = resource.path;
        let store = state.history_store()?;
        let current_version = if resource.deleted {
            None
        } else {
            match state.root.document(&path) {
                Ok(doc) => {
                    if doc.id.as_deref() != Some(&query.document) {
                        return Err(ApiError::conflict(
                            "The current file has a different document identity.",
                        ));
                    }
                    store.record(&doc, "Disk", "baseline")?;
                    Some(doc.version)
                }
                Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => None,
                Err(error) => return Err(error),
            }
        };
        if !resource.deleted {
            super::collaboration::archive_pending(store, &path)?;
        }
        Ok(HistoryList {
            revisions: store.revisions_for_resource(&query.document)?,
            current_version,
        })
    })
    .await
    .map(Json)
}

pub(super) async fn content(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<RevisionContent>, ApiError> {
    blocking(state, work, move |state, _| {
        state.owner()?;
        state.history_store()?.revision_for_resource(
            &query.document,
            query
                .revision
                .ok_or_else(|| ApiError::bad_request("Choose a history version."))?,
        )
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Restore {
    document: String,
    revision: i64,
    version: String,
}

pub(super) async fn restore(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Restore>, JsonRejection>,
) -> Result<Json<files::Document>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        state.owner()?;
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let path = state.document_path(&body.document)?;
        let previous = state
            .history_store()?
            .revision_for_resource(&body.document, body.revision)?;
        state.collaboration.replace_document(&path, |active| {
            let _lease = if active {
                None
            } else {
                Some(state.history_store()?.room_lease(&path)?)
            };
            if !active {
                super::collaboration::archive_pending(state.history_store()?, &path)?;
            }
            let saved = state.save_recorded(
                &path,
                &previous.content,
                &body.version,
                state.actor(),
                "restore",
                || work.check(),
            )?;
            state.history_store()?.clear_room(&path)?;
            Ok(saved)
        })
    })
    .await
    .map(Json)
}

pub(super) async fn trash_list(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
) -> Result<Json<Vec<TrashEntry>>, ApiError> {
    blocking(state, work, move |state, _| {
        state.owner()?;
        state.history_store()?.trash_list()
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Delete {
    id: String,
    version: String,
}

pub(super) async fn trash_document(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Delete>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        state.owner()?;
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let path = state.document_path(&body.id)?;
        state.collaboration.replace_document(&path, |active| {
            let store = state.history_store()?;
            let _lease = if active {
                None
            } else {
                Some(store.room_lease(&path)?)
            };
            if !active {
                super::collaboration::archive_pending(store, &path)?;
            }
            let document = state.root.document(&path)?;
            if document.version != body.version {
                return Err(ApiError::conflict(
                    "The document changed before deletion. Refresh before trying again.",
                ));
            }
            store.record(&document, state.actor(), "delete")?;
            let id = store.trash(
                &path,
                document.raw_content().as_bytes(),
                &body.version,
                state.actor(),
                "note",
            )?;
            if let Some(access) = &state.access {
                access.make_private(&path)?;
            }
            state
                .root
                .remove_document(&path, &body.version, || work.check())?;
            state.root.resource_store()?.retire_resource(&path)?;
            store.clear_room(&path)?;
            Ok(serde_json::json!({"id":id,"path":path,"document":body.id}))
        })
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RestoreTrash {
    id: i64,
}

pub(super) async fn restore_trash(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<RestoreTrash>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        state.owner()?;
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let store = state.history_store()?;
        let (path, kind, bytes, resource) = store.trashed(body.id)?;
        let identity = state.root.resource_store()?.resource(&resource, true)?;
        if !identity.deleted && identity.path != path {
            return Err(ApiError::conflict(
                "The recycled identity is already in use elsewhere.",
            ));
        }
        let _lease = store.resource_lease(&resource)?;
        if kind == "note" {
            let content = std::str::from_utf8(&bytes)
                .map_err(|_| ApiError::internal("The recycled Markdown is invalid."))?;
            let document = state
                .root
                .create_restored(&path, content, &resource, || work.check())?;
            store.record(&document, state.actor(), "restore")?;
        } else {
            state.root.restore_asset(&path, &bytes, || work.check())?;
            state
                .root
                .resource_store()?
                .restore_resource(&resource, &path)?;
        }
        store.remove_trash(body.id)?;
        Ok(serde_json::json!({"id":resource,"path":path}))
    })
    .await
    .map(Json)
}
