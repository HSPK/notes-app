use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Instant,
};

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use yrs::updates::decoder::Decode;
use yrs::{Doc, GetString, OffsetKind, Options, ReadTxn, StateVector, Text, Transact, Update};

use super::super::{ApiError, AppState, files};

pub(super) const MAX_STATE: usize = 16 * 1024 * 1024;
pub(super) const MAX_PEERS: usize = 12;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Cursor {
    pub anchor: Vec<u8>,
    pub head: Vec<u8>,
    pub mode: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Peer {
    pub id: String,
    pub name: String,
    pub color: usize,
    pub cursor: Option<Cursor>,
}

#[derive(Clone)]
pub(super) enum Event {
    Update(Arc<[u8]>),
    Presence(Vec<Peer>),
    Saved(files::Document),
    Error(String),
    Reset(String),
}

pub(super) struct Room {
    pub id: String,
    pub path: String,
    pub doc: Doc,
    pub saved: files::Document,
    pub peers: BTreeMap<String, Peer>,
    pub events: broadcast::Sender<Event>,
    pub dirty: bool,
    pub changed_at: Instant,
    pub failed: bool,
    pub stopped: bool,
    pub(super) store: Option<super::super::state_store::ProjectStore>,
    pub(super) actors: BTreeSet<String>,
    pub(super) pending_bytes: usize,
    pub(super) pending_updates: usize,
    pub(super) lease: Option<std::fs::File>,
    traffic_window: Instant,
    traffic_bytes: usize,
}

pub(super) fn document() -> Doc {
    Doc::with_options(Options {
        offset_kind: OffsetKind::Utf16,
        ..Options::default()
    })
}

impl Room {
    pub fn new(saved: files::Document) -> Result<Self, ApiError> {
        let doc = document();
        let text = doc.get_or_insert_text("markdown");
        text.insert(&mut doc.transact_mut(), 0, &normalize(&saved.content));
        Ok(Self {
            id: super::random_id()?,
            path: saved.path.clone(),
            doc,
            saved,
            peers: BTreeMap::new(),
            events: broadcast::channel(8).0,
            dirty: false,
            changed_at: Instant::now(),
            failed: false,
            stopped: false,
            store: None,
            actors: BTreeSet::new(),
            pending_bytes: 0,
            pending_updates: 0,
            lease: None,
            traffic_window: Instant::now(),
            traffic_bytes: 0,
        })
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default())
    }

    pub fn apply(&mut self, bytes: &[u8], actor: &str) -> Result<(), ApiError> {
        if self.stopped {
            return Err(ApiError::conflict(
                "This document was restored or removed. Reopen it; keep your local draft first.",
            ));
        }
        if bytes.len() > MAX_STATE {
            return Err(ApiError::too_large(
                "The collaboration update is too large.",
            ));
        }
        if self.pending_bytes.saturating_add(bytes.len()) > 2 * MAX_STATE
            || self.pending_updates >= 4096
        {
            self.checkpoint()?;
        }
        if self.traffic_window.elapsed().as_secs() >= 1 {
            self.traffic_window = Instant::now();
            self.traffic_bytes = 0;
        }
        self.traffic_bytes += bytes.len();
        if self.traffic_bytes > MAX_STATE {
            return Err(ApiError::too_large(
                "This collaborative note is receiving too much data. Reconnect after a pause.",
            ));
        }
        // Validate a candidate first: invalid/oversized updates must never poison a room.
        let candidate = document();
        let text = candidate.get_or_insert_text("markdown");
        {
            let mut txn = candidate.transact_mut();
            txn.apply_update(Update::decode_v1(&self.snapshot()).map_err(|_| {
                ApiError::internal("The collaborative document could not be decoded.")
            })?)
            .map_err(|error| ApiError::internal(error.to_string()))?;
            txn.apply_update(
                Update::decode_v1(bytes)
                    .map_err(|_| ApiError::bad_request("Invalid collaboration update."))?,
            )
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
            if txn.root_refs().any(|(name, _)| name != "markdown") {
                return Err(ApiError::bad_request("Unexpected shared document type."));
            }
            let content = text.get_string(&txn);
            files::validate_content(content.as_bytes())?;
            if self.saved.bom && content.len() + 3 > super::super::MAX_DOCUMENT_BYTES {
                return Err(ApiError::too_large(
                    "The Markdown size limit includes its UTF-8 BOM.",
                ));
            }
        }
        let snapshot = candidate
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        if snapshot.len() > MAX_STATE {
            return Err(ApiError::too_large(
                "The collaboration history limit was reached. Save and reopen this note.",
            ));
        }
        let next = text.get_string(&candidate.transact());
        let changed = next != self.text();
        if let Some(store) = &self.store {
            store.append_update(
                &self.path,
                &self.id,
                bytes,
                if changed { actor } else { "" },
            )?;
        }
        self.doc
            .transact_mut()
            .apply_update(
                Update::decode_v1(bytes)
                    .map_err(|_| ApiError::bad_request("Invalid collaboration update."))?,
            )
            .map_err(|error| ApiError::bad_request(error.to_string()))?;
        self.dirty = next != normalize(&self.saved.content);
        if changed {
            self.actors.insert(actor.into());
            self.changed_at = Instant::now();
        }
        self.pending_bytes += bytes.len();
        self.pending_updates += 1;
        if self.pending_bytes >= 4 * 1024 * 1024 || self.pending_updates >= 2048 {
            if let Err(error) = self.checkpoint() {
                eprintln!("Could not compact durable collaboration: {}", error.message);
            }
        }
        let _ = self.events.send(Event::Update(Arc::from(bytes)));
        Ok(())
    }

    pub fn text(&self) -> String {
        self.doc
            .get_or_insert_text("markdown")
            .get_string(&self.doc.transact())
    }

    pub fn presence(&self) -> Vec<Peer> {
        self.peers.values().cloned().collect()
    }

    pub fn publish_presence(&self) {
        let _ = self.events.send(Event::Presence(self.presence()));
    }
}

pub(super) fn normalize(value: &str) -> String {
    value
        .strip_prefix('\u{feff}')
        .unwrap_or(value)
        .replace("\r\n", "\n")
        .replace('\r', "\n")
}

pub(super) async fn save(
    state: Arc<AppState>,
    room: Arc<std::sync::Mutex<Room>>,
    automatic: bool,
) -> Result<files::Document, ApiError> {
    tokio::task::spawn_blocking(move || {
        let _saving = state.saves.lock().map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let mut room = room.lock().map_err(|_| ApiError::internal("The collaboration room is unavailable."))?;
        if !room.dirty || room.stopped {
            return Ok(room.saved.clone());
        }

        if automatic {
            let delay = state.web_preferences.read().map_err(|_| ApiError::internal("Settings are unavailable."))?.auto_save_delay_ms;
            if room.failed || room.changed_at.elapsed().as_millis() < delay as u128 {
                return Ok(room.saved.clone());
            }
        }
        let text = super::format::serialize(&room.saved.content, &room.text());
        let actor = room.actors.iter().cloned().collect::<Vec<_>>().join(", ");
        let result = state.save_recorded(&room.path, &text, &room.saved.version, &actor, "collaboration", || {
            if state.health.stopping.load(std::sync::atomic::Ordering::Acquire) {
                Err(ApiError::internal("The service is stopping; collaborative changes remain unsaved."))
            } else {
                Ok(())
            }
        });
        match result {
            Ok(saved) => {
                room.saved = saved.clone();
                room.dirty = false;
                room.failed = false;
                if let Err(error) = room.checkpoint() {
                    eprintln!("Could not checkpoint collaboration: {}", error.message);
                    let _ = room.events.send(Event::Error("The Markdown was saved, but collaboration recovery could not be checkpointed.".into()));
                }
                room.actors.clear();
                let _ = room.events.send(Event::Saved(saved.clone()));
                Ok(saved)
            }
            Err(error) => {
                room.failed = true;
                let _ = room.events.send(Event::Error(format!(
                    "Collaborative save failed: {} Your shared edits are kept; copy them before reloading.",
                    error.message
                )));
                Err(error)
            }
        }
    }).await.map_err(|error| ApiError::internal(format!("Collaboration save failed: {error}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn concurrent_updates_converge_and_invalid_updates_do_not_change_the_room() {
        let mut room = Room::new(files::Document {
            id: None,
            project: None,
            references: Vec::new(),
            warning: None,
            bom: false,
            path: "note.md".into(),
            content: "# 中文😀\nAlpha\nBeta\n".into(),
            html: String::new(),
            version: "0".repeat(64),
            title: None,
        })
        .unwrap();
        let alice = document();
        let bob = document();
        for peer in [&alice, &bob] {
            peer.transact_mut()
                .apply_update(Update::decode_v1(&room.snapshot()).unwrap())
                .unwrap();
        }
        let base = room.doc.transact().state_vector();
        alice
            .get_or_insert_text("markdown")
            .insert(&mut alice.transact_mut(), 0, "Alice\n");
        bob.get_or_insert_text("markdown")
            .insert(&mut bob.transact_mut(), 0, "Bob\n");
        room.apply(&alice.transact().encode_state_as_update_v1(&base), "alice")
            .unwrap();
        room.apply(&bob.transact().encode_state_as_update_v1(&base), "bob")
            .unwrap();
        let merged = room.text();
        assert!(
            merged.contains("Alice\n") && merged.contains("Bob\n") && merged.contains("中文😀")
        );
        assert!(room.apply(&[255], "alice").is_err());
        assert_eq!(room.text(), merged);
        let unexpected = document();
        unexpected
            .get_or_insert_text("other")
            .insert(&mut unexpected.transact_mut(), 0, "bad");
        assert!(
            room.apply(
                &unexpected
                    .transact()
                    .encode_state_as_update_v1(&StateVector::default()),
                "alice"
            )
            .is_err()
        );
        assert_eq!(room.text(), merged);
    }
}
