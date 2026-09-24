use super::{
    ApiError, AppState, Work, files, hex, markdown,
    routes::{blocking, json_error},
};
use axum::{
    Json,
    extract::{Extension, rejection::JsonRejection},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, sync::Arc};

#[derive(Serialize)]
pub(super) struct Asset {
    id: String,
    kind: super::state_store::resources::ResourceKind,
    #[serde(flatten)]
    file: files::Attachment,
    referenced: bool,
}
#[derive(Serialize)]
pub(super) struct Overview {
    files: Vec<Asset>,
    truncated: bool,
}

fn references(state: &AppState, work: &Work) -> Result<(BTreeSet<String>, bool), ApiError> {
    let tree = state.root.tree()?;
    let mut used = BTreeSet::new();
    for file in tree.files {
        work.check()?;
        let document = state.root.source_document(&file.path)?;
        used.extend(markdown::referenced_assets(&file.path, &document.content));
    }
    Ok((used, tree.truncated))
}

pub(super) async fn list(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
) -> Result<Json<Overview>, ApiError> {
    blocking(state, work, |state, work| {
        state.owner()?;
        let (used, truncated) = references(state, work)?;
        let scan = state.root.attachments()?;
        let identities = state.root.resource_store()?.identify_many(
            &scan
                .files
                .iter()
                .map(|file| {
                    (
                        file.path.clone(),
                        super::state_store::resources::ResourceKind::Asset,
                    )
                })
                .collect::<Vec<_>>(),
        )?;
        Ok(Overview {
            truncated: truncated || scan.truncated,
            files: scan
                .files
                .into_iter()
                .zip(identities)
                .map(|(file, identity)| Asset {
                    id: identity.id,
                    kind: identity.kind,
                    referenced: used.contains(&file.path),
                    file,
                })
                .collect(),
        })
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Item {
    id: String,
    stamp: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Recycle {
    files: Vec<Item>,
}

pub(super) async fn recycle(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Recycle>, JsonRejection>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    if body.files.is_empty() || body.files.len() > 100 {
        return Err(ApiError::bad_request(
            "Choose between 1 and 100 attachments.",
        ));
    }
    blocking(state,work,move|state,work| {
        state.owner()?;
        let _save=state.saves.lock().map_err(|_|ApiError::internal("The save lock is unavailable."))?;
        state.collaboration.ensure_inactive("")?;
        let store=state.history_store()?;
        for path in store.room_paths()? {
            work.check()?;
            if super::collaboration::has_pending(store,&path)? {return Err(ApiError::conflict("Save or recover collaborative drafts before cleaning attachments."));}
        }
        let (used,truncated)=references(state,work)?;
        if truncated {return Err(ApiError::conflict("The document scan is incomplete. No attachments were recycled."));}
        let items = body.files.into_iter().map(|item| {
            let path = state.resource_path(&item.id, super::state_store::resources::ResourceKind::Asset, false)?;
            Ok((path, item.stamp))
        }).collect::<Result<Vec<_>, ApiError>>()?;
        let mut selected=BTreeSet::new();
        for (path,stamp) in &items {
            if !files::media_file(path)||!selected.insert(path.clone()) {
                return Err(ApiError::bad_request("Choose distinct image or PDF attachments."));
            }
            if used.contains(path) {return Err(ApiError::conflict("An attachment is now referenced by a note. Refresh the list."));}
            if state.root.attachment_stamp(path)?!=*stamp {return Err(ApiError::conflict("An attachment changed after scanning. Refresh the list."));}
        }
        let mut recycled=Vec::new();
        for (path, _) in items {
            let result=(|| {
                work.check()?;
                let asset=state.root.asset(&path)?;
                let version=hex(&Sha256::digest(&asset.bytes));
                store.trash(&path,&asset.bytes,&version,state.actor(),"asset")?;
                state.root.remove_checked(&path,&version,||work.check())?;
                Ok(())
            })();
            if let Err(error)=result {
                if recycled.is_empty() {return Err(error);}
                return Err(ApiError::internal(format!("{} attachments were recycled before an error: {} Check the recycle bin before retrying.",recycled.len(),error.message)));
            }
            recycled.push(path);
        }
        Ok(serde_json::json!({"recycled":recycled}))
    }).await.map(Json)
}
