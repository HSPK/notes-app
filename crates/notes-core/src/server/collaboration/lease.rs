use super::{Hub, room::Room};
use crate::server::{ApiError, state_store::ProjectStore};
use std::{
    fs::File,
    sync::{Arc, Mutex},
};

pub(in crate::server) struct Lease {
    room: Option<Arc<Mutex<Room>>>,
    file: Option<File>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Some(room) = &self.room {
            match room.lock() {
                Ok(mut room) if !room.stopped && room.lease.is_none() => {
                    room.lease = self.file.take()
                }
                Ok(_) => {}
                Err(_) => eprintln!("Could not return the document lease: room lock poisoned."),
            }
        }
    }
}

impl Hub {
    pub(in crate::server) fn lease(
        &self,
        path: &str,
        store: Option<&ProjectStore>,
    ) -> Result<Lease, ApiError> {
        let rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        if let Some(room) = rooms.get(path) {
            let file = {
                let mut current = room
                    .lock()
                    .map_err(|_| ApiError::internal("The collaborative room is unavailable."))?;
                if current.dirty || !current.peers.is_empty() {
                    return Err(ApiError::conflict(
                        "Close the collaborative sessions for affected notes before changing references.",
                    ));
                }
                current.lease.take()
            };
            Ok(Lease {
                room: Some(room.clone()),
                file,
            })
        } else {
            Ok(Lease {
                room: None,
                file: store.map(|store| store.room_lease(path)).transpose()?,
            })
        }
    }

    pub(in crate::server) fn forget(&self, path: &str) -> Result<(), ApiError> {
        self.participation
            .lock()
            .map_err(|_| ApiError::internal("Document presence is unavailable."))?
            .forget(path);
        let mut rooms = self
            .rooms
            .lock()
            .map_err(|_| ApiError::internal("Collaboration is unavailable."))?;
        let paths = rooms
            .keys()
            .filter(|name| *name == path || name.starts_with(&format!("{path}/")))
            .cloned()
            .collect::<Vec<_>>();
        for path in paths {
            if let Some(room) = rooms.remove(&path) {
                let mut room = room
                    .lock()
                    .map_err(|_| ApiError::internal("The collaborative room is unavailable."))?;
                room.stopped = true;
                room.lease = None;
            }
        }
        Ok(())
    }
}
