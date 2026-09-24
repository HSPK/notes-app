use super::{ApiError, AppState, Work, blocking, json_error, random_id};
use crate::server::{
    permissions::DocumentPermissions,
    projects::{Access, watch_access::WatchAccess},
};
use axum::{
    Json,
    extract::{Extension, rejection::JsonRejection},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};

const LEASE: Duration = Duration::from_secs(15);
const MAX_PARTICIPANTS: usize = 128;

#[cfg(test)]
mod tests {
    use super::super::{Hub, Ticket, room::Room};
    use crate::server::files::Document;
    use std::{
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };

    #[test]
    fn expired_tickets_release_rooms_before_capacity_is_checked() {
        let hub = Hub::default();
        let room = Arc::new(Mutex::new(
            Room::new(Document {
                id: None,
                project: None,
                references: Vec::new(),
                warning: None,
                bom: false,
                path: "note.md".into(),
                content: "# Note\n".into(),
                html: String::new(),
                version: "0".repeat(64),
                title: None,
            })
            .unwrap(),
        ));
        hub.rooms
            .lock()
            .unwrap()
            .insert("note.md".into(), room.clone());
        hub.tickets.lock().unwrap().insert(
            "expired".into(),
            Ticket {
                room,
                name: "User".into(),
                credential: None,
                principal: String::new(),
                expires: Instant::now() - Duration::from_secs(1),
            },
        );
        hub.expire_tickets().unwrap();
        assert!(hub.tickets.lock().unwrap().is_empty());
        assert_eq!(Arc::strong_count(&hub.rooms.lock().unwrap()["note.md"]), 1);
    }
}

impl super::Hub {
    fn active_room(&self, path: &str) -> Result<bool, ApiError> {
        let rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        let Some(room) = rooms.get(path) else {
            return Ok(false);
        };
        let room = room
            .lock()
            .map_err(|_| ApiError::internal("The room is unavailable."))?;
        Ok(!room.stopped && (!room.peers.is_empty() || room.dirty))
    }

    pub(super) fn verify_resume(
        &self,
        state: &AppState,
        path: &str,
        expected: &str,
    ) -> Result<(), ApiError> {
        let rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        let matches = if let Some(room) = rooms.get(path) {
            room.lock()
                .map_err(|_| ApiError::internal("The room is unavailable."))?
                .id
                == expected
        } else {
            state
                .store
                .as_ref()
                .map(|store| store.load_room(path))
                .transpose()?
                .flatten()
                .is_some_and(|room| room.id == expected)
        };
        if !matches {
            return Err(ApiError::conflict(
                "The collaborative session no longer exists. Your local edits are kept.",
            ));
        }
        Ok(())
    }
}

struct Participant {
    access: WatchAccess,
    ready: bool,
    expires: Instant,
}

#[derive(Default)]
struct Document {
    participants: HashMap<String, Participant>,
    active: bool,
}

#[derive(Default)]
pub(super) struct Participation {
    documents: HashMap<String, Document>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::server) struct Request {
    document: String,
    participant: Option<String>,
    #[serde(default)]
    ready: bool,
    #[serde(default)]
    leave: bool,
}

#[derive(Serialize)]
pub(in crate::server) struct Status {
    participant: Option<String>,
    phase: &'static str,
    permissions: DocumentPermissions,
}

impl Participation {
    pub(super) fn forget(&mut self, path: &str) {
        self.documents
            .retain(|name, _| name != path && !name.starts_with(&format!("{path}/")));
    }

    fn prune(&mut self) -> Result<(), ApiError> {
        let now = Instant::now();
        for (path, document) in &mut self.documents {
            let mut remove = Vec::new();
            for (id, peer) in &document.participants {
                let allowed = match peer.access.document_permissions(path) {
                    Ok(permission) => permission.collaborative,
                    Err(error) if matches!(error.status.as_u16(), 401 | 403 | 404) => false,
                    Err(error) => return Err(error),
                };
                if peer.expires <= now || !allowed {
                    remove.push(id.clone());
                }
            }
            for id in remove {
                document.participants.remove(&id);
            }
        }
        self.documents
            .retain(|_, document| !document.participants.is_empty());
        Ok(())
    }

    pub(super) fn ensure_solo(&mut self, path: &str) -> Result<(), ApiError> {
        self.prune()?;
        if self
            .documents
            .get(path)
            .is_some_and(|document| document.active)
        {
            return Err(ApiError::conflict(
                "Shared editing is starting. Keep this draft until the collaborative connection is ready.",
            ));
        }
        Ok(())
    }

    pub(super) fn authorize_join(
        &mut self,
        path: &str,
        principal: &str,
        participant: Option<&str>,
    ) -> Result<(), ApiError> {
        self.prune()?;
        let allowed = self.documents.get(path).is_some_and(|document| {
            document.active
                && participant
                    .and_then(|id| document.participants.get(id))
                    .is_some_and(|peer| {
                        peer.ready && peer.access.connection_identity() == principal
                    })
        });
        if !allowed {
            return Err(ApiError::new(
                axum::http::StatusCode::TOO_EARLY,
                "Waiting for another authorized editor and safe draft handoff.",
            ));
        }
        Ok(())
    }

    fn update(
        &mut self,
        path: String,
        request: Request,
        access: Access,
        permissions: DocumentPermissions,
        active_room: bool,
    ) -> Result<Status, ApiError> {
        self.prune()?;
        if let Some(id) = &request.participant {
            if id.len() != 48 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(ApiError::bad_request(
                    "Invalid document participation identifier.",
                ));
            }
            if self
                .documents
                .get(&path)
                .and_then(|doc| doc.participants.get(id))
                .is_some_and(|peer| {
                    peer.access.connection_identity() != access.connection_identity()
                })
            {
                return Err(ApiError::forbidden(
                    "This document participation belongs to another account.",
                ));
            }
        }
        if request.leave || !permissions.collaborative {
            if let Some(document) = self.documents.get_mut(&path) {
                if let Some(id) = request.participant {
                    document.participants.remove(&id);
                }
            }
            self.documents.retain(|_, doc| !doc.participants.is_empty());
            return Ok(Status {
                participant: None,
                phase: "solo",
                permissions,
            });
        }
        let existing = request
            .participant
            .as_ref()
            .filter(|id| {
                self.documents
                    .get(&path)
                    .is_some_and(|doc| doc.participants.contains_key(*id))
            })
            .cloned();
        if request.participant.is_some() && existing.is_none() {
            return Err(ApiError::new(
                axum::http::StatusCode::GONE,
                "Document participation expired. Register again.",
            ));
        }
        if existing.is_none()
            && self
                .documents
                .values()
                .map(|doc| doc.participants.len())
                .sum::<usize>()
                >= MAX_PARTICIPANTS
        {
            return Err(ApiError::conflict(
                "Too many documents are watching for collaborators.",
            ));
        }
        let id = match existing {
            Some(id) => id,
            None => random_id()?,
        };
        let document = self.documents.entry(path).or_default();
        document.active |= active_room;
        let ready = request.ready && document.participants.contains_key(&id);
        document.participants.insert(
            id.clone(),
            Participant {
                access: WatchAccess::new(&access),
                ready,
                expires: Instant::now() + LEASE,
            },
        );
        let people = document
            .participants
            .values()
            .map(|peer| peer.access.connection_identity())
            .collect::<HashSet<_>>()
            .len();
        if !document.active && people < 2 {
            for peer in document.participants.values_mut() {
                peer.ready = false;
            }
        }
        if people >= 2 && document.participants.values().all(|peer| peer.ready) {
            document.active = true;
        }
        let phase = if document.active && ready {
            "join"
        } else if document.active || people >= 2 {
            "prepare"
        } else {
            "solo"
        };
        Ok(Status {
            participant: Some(id),
            phase,
            permissions,
        })
    }
}

pub(in crate::server) async fn presence(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Request>, JsonRejection>,
) -> Result<Json<Status>, ApiError> {
    let Json(request) = body.map_err(json_error)?;
    blocking(state, work, move |state, _| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let path = state.document_path(&request.document)?;
        let permissions = state.document_permissions(&path)?;
        let path = state.root.canonical_document_path(&path)?;
        let access = state
            .access
            .clone()
            .ok_or_else(|| ApiError::forbidden("An account or public document is required."))?;
        let active = state.collaboration.active_room(&path)?;
        state
            .collaboration
            .participation
            .lock()
            .map_err(|_| ApiError::internal("Document presence is unavailable."))?
            .update(path, request, access, permissions, active)
    })
    .await
    .map(Json)
}
