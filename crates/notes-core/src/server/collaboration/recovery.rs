use std::collections::BTreeSet;

use yrs::{GetString, ReadTxn, Transact, Update, updates::decoder::Decode};

use super::room::{Room, document, normalize};
use crate::server::{
    ApiError, files,
    state_store::{ProjectStore, StoredRoom},
};

fn decode(stored: &StoredRoom) -> Result<yrs::Doc, ApiError> {
    let restored = document();
    let text = restored.get_or_insert_text("markdown");
    {
        let mut txn = restored.transact_mut();
        for bytes in std::iter::once(stored.state.as_slice())
            .chain(stored.updates.iter().map(|(bytes, _)| bytes.as_slice()))
        {
            txn.apply_update(
                Update::decode_v1(bytes).map_err(|_| {
                    ApiError::internal("The stored collaborative draft is damaged.")
                })?,
            )
            .map_err(|error| {
                ApiError::internal(format!("Could not recover collaboration: {error}"))
            })?;
        }
        if txn.root_refs().any(|(name, _)| name != "markdown") {
            return Err(ApiError::internal(
                "The stored collaborative draft has an invalid shared type.",
            ));
        }
        files::validate_content(text.get_string(&txn).as_bytes())?;
    }
    Ok(restored)
}

pub(in crate::server) fn archive_pending(store: &ProjectStore, path: &str) -> Result<(), ApiError> {
    let Some(stored) = store.load_room(path)? else {
        return Ok(());
    };
    let doc = decode(&stored)?;
    let content = doc
        .get_or_insert_text("markdown")
        .get_string(&doc.transact());
    if content != normalize(&stored.saved) {
        let content = super::format::serialize(&stored.saved, &content);
        let content = if stored.saved.starts_with('\u{feff}') && !content.starts_with('\u{feff}') {
            format!("\u{feff}{content}")
        } else {
            content
        };
        let mut document = files::document_from_bytes(path, content.as_bytes())?;
        document.id = Some(stored.resource.clone());
        store.record(&document, &stored.actor, "recovery")?;
    }
    Ok(())
}

pub(in crate::server) fn has_pending(store: &ProjectStore, path: &str) -> Result<bool, ApiError> {
    let Some(stored) = store.load_room(path)? else {
        return Ok(false);
    };
    let doc = decode(&stored)?;
    Ok(doc
        .get_or_insert_text("markdown")
        .get_string(&doc.transact())
        != normalize(&stored.saved))
}

impl Room {
    pub(super) fn open(
        saved: files::Document,
        store: Option<ProjectStore>,
    ) -> Result<Self, ApiError> {
        let mut room = Room::new(saved)?;
        let Some(store) = store else {
            return Ok(room);
        };
        room.lease = Some(store.room_lease(&room.path)?);
        if let Some(stored) = store.load_room(&room.path)? {
            if room.saved.id.as_deref() != Some(&stored.resource) {
                archive_pending(&store, &room.path)?;
                store.clear_room(&room.path)?;
                room.store = Some(store);
                room.checkpoint()?;
                return Ok(room);
            }
            let restored = decode(&stored)?;
            let text = restored.get_or_insert_text("markdown");
            let content = text.get_string(&restored.transact());
            let changed = content != normalize(&stored.saved);
            if stored.version == room.saved.version || content == normalize(&room.saved.content) {
                room.id = stored.id;
                room.doc = restored;
                room.dirty = content != normalize(&room.saved.content);
                room.actors = stored
                    .updates
                    .iter()
                    .filter(|(_, actor)| !actor.is_empty())
                    .map(|(_, actor)| actor.clone())
                    .collect::<BTreeSet<_>>();
                if room.actors.is_empty() && !stored.actor.is_empty() {
                    room.actors.insert(stored.actor);
                }
            } else if changed {
                let recovered = super::format::serialize(&stored.saved, &content);
                let mut document = files::document_from_bytes(&room.path, recovered.as_bytes())?;
                document.id = Some(stored.resource.clone());
                store.record(&document, &stored.actor, "recovery")?;
                return Err(ApiError::conflict(
                    "A recovered collaborative draft conflicts with the file on disk. The project owner can restore it from History; the disk file was not overwritten.",
                ));
            }
        }
        store.record(&room.saved, "Disk", "baseline")?;
        room.store = Some(store);
        room.checkpoint()?;
        Ok(room)
    }

    pub(super) fn checkpoint(&mut self) -> Result<(), ApiError> {
        if let Some(store) = &self.store {
            store.checkpoint_room(
                &self.path,
                self.saved.id.as_deref().ok_or_else(|| {
                    ApiError::internal("The collaborative document has no resource identity.")
                })?,
                &self.id,
                &self.snapshot(),
                &self.saved.raw_content(),
                &self.saved.version,
                &self.actors.iter().cloned().collect::<Vec<_>>().join(", "),
            )?;
            self.pending_bytes = 0;
            self.pending_updates = 0;
        }
        Ok(())
    }
}
