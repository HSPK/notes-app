use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use super::{ApiError, ProjectStore, RETENTION_MS, compress, db_error, decompress, now};
use crate::server::files;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct Revision {
    pub document: String,
    pub id: i64,
    pub path: String,
    pub version: String,
    pub size: usize,
    pub actor: String,
    pub kind: String,
    pub created: i64,
}

#[derive(Serialize)]
pub(in crate::server) struct RevisionContent {
    pub revision: Revision,
    pub content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct TrashEntry {
    pub resource_id: String,
    pub id: i64,
    pub path: String,
    pub size: usize,
    pub version: String,
    pub kind: String,
    pub actor: String,
    pub deleted: i64,
}

fn revision(row: &rusqlite::Row<'_>) -> rusqlite::Result<Revision> {
    Ok(Revision {
        id: row.get(0)?,
        path: row.get(1)?,
        version: row.get(2)?,
        size: row.get(3)?,
        actor: row.get(4)?,
        kind: row.get(5)?,
        created: row.get(6)?,
        document: row.get(7)?,
    })
}

impl ProjectStore {
    pub(in crate::server) fn record(
        &self,
        document: &files::Document,
        actor: &str,
        kind: &str,
    ) -> Result<(), ApiError> {
        let raw = document.raw_content();
        let bytes = compress(raw.as_bytes())?;
        let created = now()?;
        let identity = match &document.id {
            Some(id) => self.resource(id, true)?.id,
            None => {
                self.identify(&document.path, super::resources::ResourceKind::Document)?
                    .id
            }
        };
        self.store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction.execute("DELETE FROM revisions WHERE project=?1 AND resource_id=?2 AND created<?3",
                params![self.project,identity,created-RETENTION_MS]).map_err(db_error)?;
            let latest: Option<String> = transaction.query_row(
                "SELECT version FROM revisions WHERE project=?1 AND resource_id=?2 ORDER BY id DESC LIMIT 1",
                params![self.project, identity],
                |row| row.get(0)).optional().map_err(db_error)?;
            let duplicate_snapshot = if matches!(kind, "baseline" | "recovery") {
                transaction.query_row("SELECT EXISTS(SELECT 1 FROM revisions WHERE project=?1 AND resource_id=?2 AND version=?3
                    AND ((?4='recovery' AND kind='recovery') OR (?4='baseline' AND kind!='recovery')))",
                    params![self.project, identity, document.version, kind], |row| row.get::<_, bool>(0)).map_err(db_error)?
            } else { false };
            if latest.as_deref() != Some(&document.version) && !duplicate_snapshot {
                transaction.execute("INSERT INTO revisions(project,path,version,content,size,actor,kind,created,resource_id)
                    VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![self.project, document.path, document.version, bytes, raw.len(), actor, kind, created,identity]).map_err(db_error)?;
            }
            transaction.execute("DELETE FROM revisions WHERE project=?1 AND resource_id=?2 AND id NOT IN
                (SELECT id FROM revisions WHERE project=?1 AND resource_id=?2 ORDER BY id DESC LIMIT 100)",
                params![self.project, identity]).map_err(db_error)?;
            transaction.commit().map_err(db_error)
        })
    }

    #[cfg(test)]
    pub(in crate::server) fn revisions(&self, path: &str) -> Result<Vec<Revision>, ApiError> {
        let Some(resource) = self.resource_at_path(path, true)? else {
            return Ok(Vec::new());
        };
        self.revisions_for_resource(&resource.id)
    }

    pub(in crate::server) fn revisions_for_resource(
        &self,
        id: &str,
    ) -> Result<Vec<Revision>, ApiError> {
        self.resource(id, true)?;
        self.store.with(|connection| {
            let mut query = connection
                .prepare(
                    "SELECT id,path,version,size,actor,kind,created,resource_id FROM revisions
                WHERE project=?1 AND resource_id=?2 AND created>=?3 ORDER BY id DESC LIMIT 100",
                )
                .map_err(db_error)?;
            query
                .query_map(params![self.project, id, now()? - RETENTION_MS], revision)
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)
        })
    }

    #[cfg(test)]
    pub(in crate::server) fn revision(
        &self,
        path: &str,
        id: i64,
    ) -> Result<RevisionContent, ApiError> {
        let resource = self
            .resource_at_path(path, true)?
            .ok_or_else(|| ApiError::bad_request("This document identity no longer exists."))?;
        self.revision_for_resource(&resource.id, id)
    }

    pub(in crate::server) fn revision_for_resource(
        &self,
        document: &str,
        id: i64,
    ) -> Result<RevisionContent, ApiError> {
        self.resource(document, true)?;
        let (revision, bytes): (Revision, Vec<u8>) = self.store.with_read(|connection| {
            connection.query_row(
                "SELECT id,path,version,size,actor,kind,created,resource_id,content FROM revisions WHERE project=?1 AND resource_id=?2 AND id=?3 AND created>=?4",
                params![self.project, document, id, now()? - RETENTION_MS], |row| Ok((revision(row)?, row.get(8)?))).optional().map_err(db_error)?
                .ok_or_else(|| ApiError::bad_request("This revision no longer exists."))
        })?;
        let content = String::from_utf8(decompress(&bytes)?)
            .map_err(|_| ApiError::internal("The stored revision is not valid Markdown."))?;
        files::validate_content(content.as_bytes())?;
        Ok(RevisionContent { revision, content })
    }

    pub(in crate::server) fn trash(
        &self,
        path: &str,
        bytes: &[u8],
        version: &str,
        actor: &str,
        kind: &str,
    ) -> Result<i64, ApiError> {
        let content = compress(bytes)?;
        let identity = self.identify(
            path,
            if kind == "note" {
                super::resources::ResourceKind::Document
            } else {
                super::resources::ResourceKind::Asset
            },
        )?;
        self.store.with(|connection| {
            connection.execute("INSERT INTO trash(project,path,content,size,version,kind,actor,deleted,resource_id) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![self.project, path, content, bytes.len(), version, kind, actor, now()?,identity.id]).map_err(db_error)?;
            Ok(connection.last_insert_rowid())
        })
    }

    pub(in crate::server) fn trash_list(&self) -> Result<Vec<TrashEntry>, ApiError> {
        self.store.with(|connection| {
            connection
                .execute(
                    "DELETE FROM trash WHERE project=?1 AND deleted < ?2",
                    params![self.project, now()? - RETENTION_MS],
                )
                .map_err(db_error)?;
            let mut query = connection
                .prepare(
                    "SELECT id,path,size,version,kind,actor,deleted,resource_id FROM trash
                WHERE project=?1 ORDER BY deleted DESC LIMIT 1000",
                )
                .map_err(db_error)?;
            query
                .query_map([&self.project], |row| {
                    Ok(TrashEntry {
                        resource_id: row.get(7)?,
                        id: row.get(0)?,
                        path: row.get(1)?,
                        size: row.get(2)?,
                        version: row.get(3)?,
                        kind: row.get(4)?,
                        actor: row.get(5)?,
                        deleted: row.get(6)?,
                    })
                })
                .map_err(db_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(db_error)
        })
    }

    pub(in crate::server) fn trashed(
        &self,
        id: i64,
    ) -> Result<(String, String, Vec<u8>, String), ApiError> {
        self.store.with(|connection| {
            let (path, kind, bytes, resource): (String, String, Vec<u8>, String) = connection.query_row(
                "SELECT path,kind,content,resource_id FROM trash WHERE project=?1 AND id=?2 AND deleted >= ?3",
                params![self.project, id, now()? - RETENTION_MS], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?,row.get(3)?)))
                .optional().map_err(db_error)?.ok_or_else(|| ApiError::bad_request("This recycled item expired or was removed."))?;
            Ok((path, kind, decompress(&bytes)?,resource))
        })
    }

    pub(in crate::server) fn remove_trash(&self, id: i64) -> Result<(), ApiError> {
        self.store.with(|connection| {
            connection
                .execute(
                    "DELETE FROM trash WHERE project=?1 AND id=?2",
                    params![self.project, id],
                )
                .map_err(db_error)?;
            Ok(())
        })
    }
}
