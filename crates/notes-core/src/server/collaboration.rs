use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use axum::{
    Json,
    extract::{
        Extension, Query, WebSocketUpgrade,
        rejection::JsonRejection,
        ws::{Message, WebSocket},
    },
    http::HeaderMap,
    response::Response,
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use yrs::{StickyIndex, updates::decoder::Decode};

use super::{
    ApiError, AppState, Work, files, hex,
    routes::{blocking, json_error},
    security,
};

#[path = "collaboration/format.rs"]
mod format;
#[path = "collaboration/lease.rs"]
mod lease;
#[path = "collaboration/participation.rs"]
pub(super) mod participation;
#[path = "collaboration/recovery.rs"]
mod recovery;
#[path = "collaboration/room.rs"]
mod room;
pub(super) use recovery::archive_pending;
pub(super) use recovery::has_pending;
use room::{Cursor, Event, MAX_PEERS, MAX_STATE, Peer, Room};

const MAX_ROOMS: usize = 16;
const MAX_TICKETS: usize = 128;

#[derive(Default)]
pub(super) struct Hub {
    rooms: Mutex<HashMap<String, Arc<Mutex<Room>>>>,
    tickets: Mutex<HashMap<String, Ticket>>,
    participation: Mutex<participation::Participation>,
}

#[derive(Clone)]
struct Ticket {
    room: Arc<Mutex<Room>>,
    name: String,
    credential: Option<String>,
    expires: Instant,
    principal: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Join {
    document: String,
    room_id: Option<String>,
    participant: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Joined {
    ticket: String,
    room_id: String,
}

#[derive(Deserialize)]
pub(super) struct SocketQuery {
    ticket: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum Incoming {
    Cursor { cursor: Option<Cursor> },
    Save,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Outgoing {
    Welcome {
        me: Peer,
        room: String,
        users: Vec<Peer>,
        saved: files::Document,
        blocked: bool,
        writable: bool,
    },
    Presence {
        users: Vec<Peer>,
    },
    Ack {
        sequence: u32,
    },
    Saved {
        document: files::Document,
    },
    Error {
        message: String,
    },
    Reset {
        message: String,
    },
}

fn random_id() -> Result<String, ApiError> {
    let mut bytes = [0; 24];
    getrandom::fill(&mut bytes).map_err(|error| ApiError::internal(error.to_string()))?;
    Ok(hex(&bytes))
}

impl Hub {
    fn expire_tickets(&self) -> Result<(), ApiError> {
        let mut tickets = self
            .tickets
            .lock()
            .map_err(|_| ApiError::internal("Collaboration tickets are unavailable."))?;
        tickets.retain(|_, ticket| ticket.expires > Instant::now());
        if tickets.len() >= MAX_TICKETS {
            return Err(ApiError::conflict(
                "Too many pending collaboration connections.",
            ));
        }
        Ok(())
    }

    pub(super) fn ensure_solo(&self, path: &str) -> Result<(), ApiError> {
        self.participation
            .lock()
            .map_err(|_| ApiError::internal("Document presence is unavailable."))?
            .ensure_solo(path)
    }

    fn room(&self, state: &AppState, path: &str) -> Result<Arc<Mutex<Room>>, ApiError> {
        files::validate_document_path(path)?;
        let mut rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        if let Some(room) = rooms.get(path) {
            let mut current = room
                .lock()
                .map_err(|_| ApiError::internal("The room is unavailable."))?;
            let saved = state.root.document(path)?;
            if saved.version != current.saved.version || saved.id != current.saved.id {
                if Arc::strong_count(room) == 1 && current.peers.is_empty() && !current.dirty {
                    current.saved = saved.clone();
                    current.doc = room::document();
                    {
                        use yrs::{Text, Transact};
                        current.doc.get_or_insert_text("markdown").insert(
                            &mut current.doc.transact_mut(),
                            0,
                            &room::normalize(&saved.content),
                        );
                    }
                    current.id = random_id()?;
                    current.checkpoint()?;
                } else {
                    return Err(ApiError::conflict(
                        "This note changed on disk outside collaboration. Close the shared session before reopening; copy unsaved text first.",
                    ));
                }
            }
            drop(current);
            return Ok(room.clone());
        }
        if rooms.len() >= MAX_ROOMS {
            let mut remove = None;
            for (path, room) in rooms.iter() {
                if Arc::strong_count(room) != 1 {
                    continue;
                }
                let room = room
                    .lock()
                    .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
                if room.peers.is_empty() && !room.dirty {
                    remove = Some(path.clone());
                    break;
                }
            }
            if let Some(path) = remove {
                rooms.remove(&path);
            }
        }
        if rooms.len() >= MAX_ROOMS {
            return Err(ApiError::conflict(
                "Too many collaborative documents are open. Close a saved document first.",
            ));
        }
        let room = Arc::new(Mutex::new(Room::open(
            state.root.document(path)?,
            state.store.clone(),
        )?));
        rooms.insert(path.into(), room.clone());
        Ok(room)
    }

    pub(super) fn ensure_inactive(&self, path: &str) -> Result<(), ApiError> {
        let rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        for (name, room) in rooms.iter() {
            if path.is_empty() || name == path || name.starts_with(&format!("{path}/")) {
                let room = room
                    .lock()
                    .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
                if !room.peers.is_empty() || room.dirty {
                    return Err(ApiError::conflict(
                        "This note is in a collaborative session. Use collaborative save; close the session before moving it.",
                    ));
                }
            }
        }
        Ok(())
    }

    pub(super) fn replace_document<T>(
        &self,
        path: &str,
        operation: impl FnOnce(bool) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let mut rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        let room = rooms.get(path).cloned();
        let mut current = room
            .as_ref()
            .map(|room| {
                room.lock()
                    .map_err(|_| ApiError::internal("The room is unavailable."))
            })
            .transpose()?;
        if current.as_ref().is_some_and(|room| room.dirty) {
            return Err(ApiError::conflict(
                "Wait until all shared changes are saved before restoring or deleting this document.",
            ));
        }
        let result = operation(current.is_some())?;
        if let Some(room) = &mut current {
            room.stopped = true;
            room.lease = None;
            let _ = room.events.send(Event::Reset("The owner restored or removed this document. Reopen it to continue; unsynced local text is kept.".into()));
        }
        rooms.remove(path);
        Ok(result)
    }
}

pub(super) async fn join(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    headers: HeaderMap,
    body: Result<Json<Join>, JsonRejection>,
) -> Result<Json<Joined>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    let (name, credential) = if state
        .access
        .as_ref()
        .is_some_and(|access| access.is_public())
    {
        (
            state
                .access
                .as_ref()
                .and_then(|access| access.visitor_name())
                .map(str::to_owned)
                .unwrap_or(format!("Guest {}", &random_id()?[..6])),
            None,
        )
    } else if state.user_auth.is_some() {
        let user = security::authenticated_user(&headers, &state)
            .ok_or_else(|| ApiError::forbidden("Log in before joining a collaborative note."))?;
        (
            user.username,
            security::cookie_value(&headers, &state.user_cookie_name).map(str::to_owned),
        )
    } else {
        ("Local user".into(), None)
    };
    let principal = state
        .access
        .as_ref()
        .map(|access| access.connection_identity().to_owned())
        .unwrap_or_default();
    blocking(state, work, move |state, _| {
        let _saves = state.saves.lock().map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        let path = state.document_path(&body.document)?;
        state.authorize_collaboration(&path)?;
        let path = state.root.canonical_document_path(&path)?;
        if state.access.is_some() && body.room_id.is_none() {
            state.collaboration.participation.lock().map_err(|_| ApiError::internal("Document presence is unavailable."))?
                .authorize_join(&path, &principal, body.participant.as_deref())?;
        }
        if let Some(expected) = body.room_id.as_deref() {
            state.collaboration.verify_resume(state, &path, expected)?;
        }
        state.collaboration.expire_tickets()?;
        let room = state.collaboration.room(state, &path)?;
        let room_id = room.lock().map_err(|_| ApiError::internal("The room is unavailable."))?.id.clone();
        if body.room_id.is_some_and(|expected| expected != room_id) {
            return Err(ApiError::conflict("The collaborative session restarted. Your local edits are kept; copy them before reopening the note."));
        }
        let ticket = random_id()?;
        let mut tickets = state.collaboration.tickets.lock().map_err(|_| ApiError::internal("Collaboration tickets are unavailable."))?;
        tickets.insert(ticket.clone(), Ticket { room, name, credential, principal, expires: Instant::now() + Duration::from_secs(30) });
        Ok(Joined { ticket, room_id })
    }).await.map(Json)
}

pub(super) async fn socket(
    Extension(state): Extension<Arc<AppState>>,
    axum::extract::ConnectInfo(connection): axum::extract::ConnectInfo<super::net::ConnectionInfo>,
    Query(query): Query<SocketQuery>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    if !headers.contains_key("origin") {
        return Err(ApiError::forbidden("A same-origin WebSocket is required."));
    }
    let ticket = state
        .collaboration
        .tickets
        .lock()
        .map_err(|_| ApiError::internal("Collaboration tickets are unavailable."))?
        .remove(&query.ticket)
        .filter(|ticket| ticket.expires > Instant::now())
        .ok_or_else(|| ApiError::forbidden("The collaboration ticket is invalid or expired."))?;
    connection.websocket();
    Ok(upgrade
        .max_message_size(MAX_STATE + 4)
        .max_frame_size(MAX_STATE + 4)
        .on_upgrade(move |socket| connected(socket, state, ticket)))
}

async fn json(socket: &mut WebSocket, value: &Outgoing) -> Result<(), String> {
    let text = serde_json::to_string(value).map_err(|error| error.to_string())?;
    socket
        .send(Message::Text(text.into()))
        .await
        .map_err(|error| error.to_string())
}

fn packet(update: &[u8]) -> Message {
    let mut bytes = Vec::with_capacity(update.len() + 4);
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(update);
    Message::Binary(bytes.into())
}

fn session_valid(state: &AppState, ticket: &Ticket) -> bool {
    if state
        .access
        .as_ref()
        .map(|access| access.connection_identity())
        .unwrap_or("")
        != ticket.principal
    {
        return false;
    }
    if let Some(access) = &state.access {
        if access.is_public() {
            return ticket.credential.is_none() && access.public_valid();
        }
    }
    match (&state.user_auth, &ticket.credential) {
        (Some(auth), Some(token)) => auth.authenticate(token).is_some(),
        (None, None) => true,
        _ => false,
    }
}

fn authorize_socket(state: &AppState, ticket: &Ticket, path: &str) -> Result<(), String> {
    if !session_valid(state, ticket) {
        return Err("Your login or public link expired. Your local edits are kept.".into());
    }
    state
        .authorize_collaboration(path)
        .map_err(|error| error.message)
}

async fn connected(mut socket: WebSocket, state: Arc<AppState>, ticket: Ticket) {
    let id = match random_id() {
        Ok(id) => id,
        Err(error) => {
            let _ = json(
                &mut socket,
                &Outgoing::Error {
                    message: error.message,
                },
            )
            .await;
            return;
        }
    };
    let result = run_socket(&mut socket, &state, &ticket, &id).await;
    if let Err(message) = result {
        let _ = json(&mut socket, &Outgoing::Error { message }).await;
    }
    let flush = match ticket.room.lock() {
        Ok(mut room) => {
            let joined = room.peers.remove(&id).is_some();
            room.publish_presence();
            joined && room.peers.is_empty() && room.dirty && !room.failed && !room.stopped
        }
        Err(_) => {
            eprintln!("Could not remove disconnected collaborator: room lock poisoned.");
            false
        }
    };
    if flush {
        if let Err(error) = room::save(state, ticket.room.clone(), false).await {
            eprintln!(
                "Could not save the last collaborator's changes: {}",
                error.message
            );
        }
    }
    let _ = socket.send(Message::Close(None)).await;
}

async fn run_socket(
    socket: &mut WebSocket,
    state: &Arc<AppState>,
    ticket: &Ticket,
    id: &str,
) -> Result<(), String> {
    if !session_valid(state, ticket) {
        return Err("Your login expired. Log in again; your local edits are kept.".into());
    }
    if state
        .access
        .as_ref()
        .is_some_and(|access| !access.is_public() && !access.is_user(&ticket.name))
    {
        return Err("This collaboration ticket belongs to a different account.".into());
    }
    let (welcome, snapshot, mut events) = {
        let state = state.clone();
        let ticket = ticket.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<_, String> {
            let _save = state
                .saves
                .lock()
                .map_err(|_| "The save lock is unavailable.")?;
            if !session_valid(&state, &ticket) {
                return Err("The login or public link changed before joining.".into());
            }
            let mut room = ticket.room.lock().map_err(|_| "The room is unavailable.")?;
            if room.stopped {
                return Err(
                    "This document session changed. Reopen the note before joining.".into(),
                );
            }
            state
                .authorize_collaboration(&room.path)
                .map_err(|error| error.message)?;
            if room.peers.len() >= MAX_PEERS {
                return Err("This document already has 12 connected editors.".into());
            }
            let color = (0..MAX_PEERS)
                .find(|color| room.peers.values().all(|peer| peer.color != *color))
                .unwrap_or(0);
            let peer = Peer {
                id: id.clone(),
                name: ticket.name.clone(),
                color,
                cursor: None,
            };
            room.peers.insert(id, peer.clone());
            let events = room.events.subscribe();
            room.publish_presence();
            let writable = state.authorize(Some(&room.path), true).is_ok();
            Ok((
                Outgoing::Welcome {
                    me: peer,
                    room: room.id.clone(),
                    users: room.presence(),
                    saved: room.saved.clone(),
                    blocked: room.failed,
                    writable,
                },
                room.snapshot(),
                events,
            ))
        })
        .await
        .map_err(|error| error.to_string())??
    };
    json(socket, &welcome).await?;
    socket
        .send(packet(&snapshot))
        .await
        .map_err(|error| error.to_string())?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    let mut last_seen = Instant::now();
    let mut window = Instant::now();
    let mut count = 0;
    loop {
        tokio::select! {
            received = socket.recv() => {
                let Some(received) = received else { break; };
                let message = received.map_err(|error| error.to_string())?;
                let path = ticket.room.lock().map_err(|_| "The room is unavailable.")?.path.clone();
                authorize_socket(state, ticket, &path)?;
                last_seen = Instant::now();
                if window.elapsed() > Duration::from_secs(1) { count = 0; window = Instant::now(); }
                count += 1;
                if count > 120 { return Err("Collaboration is receiving updates too quickly. Your local edits are kept.".into()); }
                match message {
                    Message::Binary(bytes) => {
                        state.authorize(Some(&path), true).map_err(|error| error.message)?;
                        if bytes.len() < 5 { return Err("Invalid collaboration packet.".into()); }
                        let sequence = u32::from_le_bytes(bytes[..4].try_into().map_err(|_| "Invalid packet.")?);
                        let room = ticket.room.clone();
                        let actor = ticket.name.clone();
                        let update = bytes.slice(4..);
                        tokio::task::spawn_blocking(move || {
                            room.lock().map_err(|_| "The room is unavailable.".to_owned())?
                                .apply(&update, &actor).map_err(|error| error.message)
                        }).await.map_err(|error| error.to_string())??;
                        json(socket, &Outgoing::Ack { sequence }).await?;
                    }
                    Message::Text(text) => {
                        if text.len() > 4096 { return Err("Collaboration control message is too large.".into()); }
                        match serde_json::from_str::<Incoming>(&text).map_err(|error| error.to_string())? {
                            Incoming::Cursor { cursor } => {
                                if cursor.as_ref().is_some_and(|cursor| cursor.anchor.len() > 256 || cursor.head.len() > 256
                                    || StickyIndex::decode_v1(&cursor.anchor).is_err()
                                    || StickyIndex::decode_v1(&cursor.head).is_err()
                                    || !["rich", "editor", "split", "preview"].contains(&cursor.mode.as_str())) {
                                    return Err("Invalid collaborator cursor.".into());
                                }
                                let mut room = ticket.room.lock().map_err(|_| "The room is unavailable.")?;
                                if let Some(peer) = room.peers.get_mut(id) { peer.cursor = cursor; }
                                room.publish_presence();
                            }
                            Incoming::Save => {
                                state.authorize(Some(&path), true).map_err(|error| error.message)?;
                                match room::save(state.clone(), ticket.room.clone(), false).await {
                                    Ok(document) => json(socket, &Outgoing::Saved { document }).await?,
                                    Err(error) => json(socket, &Outgoing::Error { message: error.message }).await?,
                                }
                            }
                        }
                    }
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                }
            }
            event = events.recv() => {
                let path = ticket.room.lock().map_err(|_| "The room is unavailable.")?.path.clone();
                authorize_socket(state, ticket, &path)?;
                match event {
                    Ok(Event::Update(update)) => socket.send(packet(&update)).await.map_err(|error| error.to_string())?,
                    Ok(Event::Presence(users)) => json(socket, &Outgoing::Presence { users }).await?,
                    Ok(Event::Saved(document)) => json(socket, &Outgoing::Saved { document }).await?,
                    Ok(Event::Error(message)) => json(socket, &Outgoing::Error { message }).await?,
                    Ok(Event::Reset(message)) => { json(socket, &Outgoing::Reset { message }).await?; break; }
                    Err(broadcast::error::RecvError::Lagged(_)) => return Err("Collaboration updates were missed. Reconnect to resynchronize.".into()),
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = heartbeat.tick() => {
                let path = ticket.room.lock().map_err(|_| "The room is unavailable.")?.path.clone();
                authorize_socket(state, ticket, &path)?;
                if last_seen.elapsed() > Duration::from_secs(30) { return Err("The collaboration connection timed out.".into()); }
                if state.health.stopping.load(std::sync::atomic::Ordering::Acquire) { break; }
                socket.send(Message::Ping(Vec::new().into())).await.map_err(|error| error.to_string())?;
                if let Err(error) = room::save(state.clone(), ticket.room.clone(), true).await {
                    eprintln!("Collaborative save: {}", error.message);
                }
            }
        }
    }
    Ok(())
}
