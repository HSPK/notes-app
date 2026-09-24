use std::{
    fs,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use flate2::{Compression, read::ZlibDecoder, write::ZlibEncoder};
use rusqlite::{Connection, OpenFlags};

use super::ApiError;

#[path = "state_store/collaboration.rs"]
mod collaboration;
#[path = "state_store/relocate.rs"]
mod relocate;
#[path = "state_store/revisions.rs"]
mod revisions;
#[path = "state_store/search.rs"]
pub(super) mod search;
#[path = "state_store/visitors.rs"]
mod visitors;
#[path = "state_store/workspaces.rs"]
pub(super) mod workspaces;
pub(super) use collaboration::StoredRoom;
pub(super) use revisions::{Revision, RevisionContent, TrashEntry};
#[path = "state_store/resources.rs"]
pub(super) mod resources;

#[cfg(test)]
#[path = "state_store/read_tests.rs"]
mod read_tests;

pub(super) const RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;
const MAX_STORED_BYTES: usize = 32 * 1024 * 1024;

pub(super) struct Store {
    // Close the reader first so the writer can checkpoint WAL on its final close.
    reader: Option<Mutex<Connection>>,
    connection: Mutex<Connection>,
    directory: std::path::PathBuf,
}

#[derive(Clone)]
pub(super) struct ProjectStore {
    pub(super) store: Arc<Store>,
    pub(super) project: String,
}

impl Store {
    pub(super) fn open(path: &Path) -> Result<Arc<Self>, ApiError> {
        let parent = path
            .parent()
            .ok_or_else(|| ApiError::internal("Workspace storage has no parent."))?;
        let mut directory = fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory
            .create(parent)
            .map_err(|error| ApiError::io("Could not create workspace storage", error))?;
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(db_error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600))
                .map_err(|error| ApiError::io("Could not protect workspace storage", error))?;
        }
        Self::initialize(connection, parent, Some(path))
    }

    pub(super) fn temporary() -> Result<Arc<Self>, ApiError> {
        Self::initialize(
            Connection::open_in_memory().map_err(db_error)?,
            Path::new(""),
            None,
        )
    }

    fn initialize(
        mut connection: Connection,
        parent: &Path,
        reader_path: Option<&Path>,
    ) -> Result<Arc<Self>, ApiError> {
        connection
            .busy_timeout(Duration::from_secs(3))
            .map_err(db_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
            PRAGMA trusted_schema=OFF;
            CREATE TABLE IF NOT EXISTS revisions (
                id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, path TEXT NOT NULL,
                version TEXT NOT NULL, content BLOB NOT NULL, size INTEGER NOT NULL,
                actor TEXT NOT NULL, kind TEXT NOT NULL, created INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS revision_path ON revisions(project,path,id DESC);
            CREATE TABLE IF NOT EXISTS trash (
                id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, path TEXT NOT NULL,
                content BLOB NOT NULL, size INTEGER NOT NULL, version TEXT NOT NULL,
                kind TEXT NOT NULL, actor TEXT NOT NULL, deleted INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS trash_project ON trash(project,deleted DESC);
            CREATE TABLE IF NOT EXISTS rooms (
                project TEXT NOT NULL, path TEXT NOT NULL, room_id TEXT NOT NULL,
                state BLOB NOT NULL, saved BLOB NOT NULL, version TEXT NOT NULL,
                actor TEXT NOT NULL, PRIMARY KEY(project,path)
            );
            CREATE TABLE IF NOT EXISTS room_updates (
                id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, path TEXT NOT NULL,
                data BLOB NOT NULL, actor TEXT NOT NULL, created INTEGER NOT NULL,
                FOREIGN KEY(project,path) REFERENCES rooms(project,path) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS updates_path ON room_updates(project,path,id);
            CREATE TABLE IF NOT EXISTS user_workspaces (
                user_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS user_keys (user_id TEXT PRIMARY KEY, secret BLOB NOT NULL);
            CREATE TABLE IF NOT EXISTS resources (
                id TEXT PRIMARY KEY, project TEXT NOT NULL, path TEXT NOT NULL,
                kind TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE UNIQUE INDEX IF NOT EXISTS resource_location ON resources(project,path) WHERE deleted=0;
            CREATE INDEX IF NOT EXISTS resource_project ON resources(project,id);
            CREATE TABLE IF NOT EXISTS resource_epochs (project TEXT PRIMARY KEY,revision INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS public_sessions (
                digest TEXT PRIMARY KEY, project TEXT NOT NULL, link TEXT NOT NULL, password TEXT NOT NULL,
                created INTEGER NOT NULL, expires INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS public_session_project ON public_sessions(project,expires);
            CREATE INDEX IF NOT EXISTS public_session_expiration ON public_sessions(expires);
            CREATE TABLE IF NOT EXISTS document_index (
                id INTEGER PRIMARY KEY, project TEXT NOT NULL, path TEXT NOT NULL, version TEXT NOT NULL,
                stamp TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, body TEXT NOT NULL,
                metadata TEXT NOT NULL, tags TEXT NOT NULL, warning TEXT, UNIQUE(project,path)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS document_fts USING fts5(
                title,body,metadata,path,tags,content='document_index',content_rowid='id',tokenize='trigram'
            );",
            )
            .map_err(db_error)?;
        resources::migrate(&mut connection)?;
        let journal: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(db_error)?;
        let reader = if let Some(path) = reader_path.filter(|_| journal.eq_ignore_ascii_case("wal"))
        {
            let reader = Connection::open_with_flags(
                path,
                OpenFlags::SQLITE_OPEN_READ_ONLY
                    | OpenFlags::SQLITE_OPEN_NO_MUTEX
                    | OpenFlags::SQLITE_OPEN_NOFOLLOW,
            )
            .map_err(db_error)?;
            reader
                .busy_timeout(Duration::from_secs(3))
                .map_err(db_error)?;
            reader
                .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
                .map_err(db_error)?;
            Some(Mutex::new(reader))
        } else {
            if reader_path.is_some() {
                eprintln!("SQLite WAL is unavailable; workspace reads will remain serialized.");
            }
            None
        };
        let store = Arc::new(Self {
            reader,
            connection: Mutex::new(connection),
            directory: parent.into(),
        });
        store.prune()?;
        Ok(store)
    }

    pub(super) fn project(self: &Arc<Self>, project: &str) -> ProjectStore {
        ProjectStore {
            store: self.clone(),
            project: project.into(),
        }
    }

    pub(super) fn with<T>(
        &self,
        action: impl FnOnce(&mut Connection) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| ApiError::internal("Workspace storage is unavailable."))?;
        action(&mut connection)
    }

    fn with_read<T>(
        &self,
        action: impl FnOnce(&Connection) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        match &self.reader {
            Some(reader) => {
                let connection = reader
                    .lock()
                    .map_err(|_| ApiError::internal("Workspace reading is unavailable."))?;
                action(&connection)
            }
            None => self.with(|connection| action(connection)),
        }
    }

    fn prune(&self) -> Result<(), ApiError> {
        let cutoff = now()? - RETENTION_MS;
        self.with(|connection| {
            connection
                .execute("DELETE FROM revisions WHERE created < ?1", [cutoff])
                .map_err(db_error)?;
            connection
                .execute("DELETE FROM trash WHERE deleted < ?1", [cutoff])
                .map_err(db_error)?;
            Ok(())
        })
    }
}

pub(super) fn now() -> Result<i64, ApiError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|value| i64::try_from(value.as_millis()).ok())
        .ok_or_else(|| ApiError::internal("The system clock is unavailable."))
}

pub(super) fn compress(bytes: &[u8]) -> Result<Vec<u8>, ApiError> {
    if bytes.len() > MAX_STORED_BYTES {
        return Err(ApiError::too_large("The workspace record is too large."));
    }
    let mut encoder = ZlibEncoder::new(Vec::new(), Compression::fast());
    encoder
        .write_all(bytes)
        .map_err(|error| ApiError::io("Could not encode workspace state", error))?;
    encoder
        .finish()
        .map_err(|error| ApiError::io("Could not finish workspace state", error))
}

pub(super) fn decompress(bytes: &[u8]) -> Result<Vec<u8>, ApiError> {
    let mut result = Vec::new();
    ZlibDecoder::new(bytes)
        .take((MAX_STORED_BYTES + 1) as u64)
        .read_to_end(&mut result)
        .map_err(|error| ApiError::io("Could not decode workspace state", error))?;
    if result.len() > MAX_STORED_BYTES {
        return Err(ApiError::too_large("The workspace record is too large."));
    }
    Ok(result)
}

pub(super) fn db_error(error: rusqlite::Error) -> ApiError {
    ApiError::internal(format!("Workspace storage failed: {error}"))
}
