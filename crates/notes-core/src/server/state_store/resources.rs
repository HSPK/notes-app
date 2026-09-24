use super::{ApiError, ProjectStore, Store, db_error, now};
use crate::server::files;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
#[path = "resources/migration.rs"]
mod migration;
pub(super) use migration::migrate;
#[cfg(test)]
#[path = "resources/tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::server) enum ResourceKind {
    Document,
    Directory,
    Asset,
}

impl ResourceKind {
    fn name(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Directory => "directory",
            Self::Asset => "asset",
        }
    }

    fn parse(value: &str) -> Result<Self, ApiError> {
        match value {
            "document" => Ok(Self::Document),
            "directory" => Ok(Self::Directory),
            "asset" => Ok(Self::Asset),
            _ => Err(ApiError::internal("The stored resource type is invalid.")),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub(in crate::server) struct Resource {
    pub id: String,
    pub project: String,
    pub path: String,
    pub kind: ResourceKind,
    pub deleted: bool,
}

pub(in crate::server) fn validate_id(value: &str) -> Result<(), ApiError> {
    let id =
        Uuid::try_parse(value).map_err(|_| ApiError::bad_request("Use a UUID v7 resource ID."))?;
    if id.get_version_num() != 7
        || id.get_variant() != uuid::Variant::RFC4122
        || id.to_string() != value
    {
        return Err(ApiError::bad_request(
            "Use a canonical UUID v7 resource ID.",
        ));
    }
    Ok(())
}

fn new_id() -> Result<String, ApiError> {
    let mut random = [0; 10];
    getrandom::fill(&mut random).map_err(|error| ApiError::internal(error.to_string()))?;
    let timestamp =
        u64::try_from(now()?).map_err(|_| ApiError::internal("The resource clock is invalid."))?;
    Ok(
        uuid::Builder::from_unix_timestamp_millis(timestamp, &random)
            .into_uuid()
            .to_string(),
    )
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String, String, bool)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn resource(row: (String, String, String, String, bool)) -> Result<Resource, ApiError> {
    validate_id(&row.0).map_err(|_| ApiError::internal("The stored resource ID is invalid."))?;
    Ok(Resource {
        id: row.0,
        project: row.1,
        path: row.2,
        kind: ResourceKind::parse(&row.3)?,
        deleted: row.4,
    })
}

fn ensure_resource(
    connection: &rusqlite::Connection,
    project: &str,
    path: &str,
    kind: ResourceKind,
) -> Result<(Resource, bool), ApiError> {
    if kind == ResourceKind::Document {
        files::validate_document_path(path)?;
    } else {
        files::validate_relative(path)?;
        if kind == ResourceKind::Asset && files::is_markdown(path) {
            return Err(ApiError::bad_request(
                "Markdown files cannot use attachment identities.",
            ));
        }
    }
    let existing = connection.prepare_cached(
        "SELECT id,project,path,kind,deleted FROM resources WHERE project=?1 AND path=?2 AND deleted=0"
    ).map_err(db_error)?.query_row(params![project,path], from_row).optional().map_err(db_error)?;
    if let Some(existing) = existing {
        let existing = resource(existing)?;
        if existing.kind != kind {
            return Err(ApiError::conflict(
                "This path changed resource type outside Notes. Its old identity cannot be reused.",
            ));
        }
        return Ok((existing, false));
    }
    let id = new_id()?;
    connection
        .prepare_cached(
            "INSERT INTO resources(id,project,path,kind,deleted) VALUES (?1,?2,?3,?4,0)",
        )
        .map_err(db_error)?
        .execute(params![id, project, path, kind.name()])
        .map_err(db_error)?;
    Ok((
        Resource {
            id,
            project: project.into(),
            path: path.into(),
            kind,
            deleted: false,
        },
        true,
    ))
}

impl Store {
    pub(in crate::server) fn resource(
        &self,
        id: &str,
        include_deleted: bool,
    ) -> Result<Resource, ApiError> {
        validate_id(id)?;
        self.with_read(|connection| {
            let row = connection.query_row(
                "SELECT id,project,path,kind,deleted FROM resources WHERE id=?1 AND (?2 OR deleted=0)",
                params![id,include_deleted], from_row,
            ).optional().map_err(db_error)?
                .ok_or_else(|| ApiError::new(axum::http::StatusCode::NOT_FOUND, "This resource no longer exists."))?;
            resource(row)
        })
    }
}

impl ProjectStore {
    pub(in crate::server) fn resource_at_path(
        &self,
        path: &str,
        include_deleted: bool,
    ) -> Result<Option<Resource>, ApiError> {
        self.store.with_read(|connection| {
            connection.query_row(
                "SELECT id,project,path,kind,deleted FROM resources
                 WHERE project=?1 AND path=?2 AND (?3 OR deleted=0) ORDER BY deleted,rowid DESC LIMIT 1",
                params![self.project,path,include_deleted], from_row,
            ).optional().map_err(db_error)?.map(resource).transpose()
        })
    }

    pub(in crate::server) fn resource(
        &self,
        id: &str,
        include_deleted: bool,
    ) -> Result<Resource, ApiError> {
        let resource = self.store.resource(id, include_deleted)?;
        if resource.project != self.project {
            return Err(ApiError::forbidden(
                "This resource belongs to another project.",
            ));
        }
        Ok(resource)
    }

    pub(in crate::server) fn identify(
        &self,
        path: &str,
        kind: ResourceKind,
    ) -> Result<Resource, ApiError> {
        let mut results = self.identify_many(&[(path.to_owned(), kind)])?;
        results
            .pop()
            .ok_or_else(|| ApiError::internal("Resource registration did not return an identity."))
    }

    pub(in crate::server) fn identify_many(
        &self,
        entries: &[(String, ResourceKind)],
    ) -> Result<Vec<Resource>, ApiError> {
        self.store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            let mut result = Vec::with_capacity(entries.len());
            let mut changed = false;
            for (path, kind) in entries {
                let (resource, inserted) =
                    ensure_resource(&transaction, &self.project, path, *kind)?;
                result.push(resource);
                changed |= inserted;
            }
            if changed {
                transaction
                    .execute(
                        "INSERT INTO resource_epochs(project,revision) VALUES (?1,1)
                    ON CONFLICT(project) DO UPDATE SET revision=revision+1",
                        [&self.project],
                    )
                    .map_err(db_error)?;
            }
            transaction.commit().map_err(db_error)?;
            Ok(result)
        })
    }

    pub(in crate::server) fn identity_revision(&self) -> Result<u64, ApiError> {
        self.store.with_read(|connection| {
            connection
                .query_row(
                    "SELECT revision FROM resource_epochs WHERE project=?1",
                    [&self.project],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)
                .map(|revision| revision.unwrap_or(0))
        })
    }

    pub(in crate::server) fn retire_resource(&self, path: &str) -> Result<(), ApiError> {
        self.store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            let changed = transaction
                .execute(
                    "UPDATE resources SET deleted=1 WHERE project=?1 AND path=?2 AND deleted=0",
                    params![self.project, path],
                )
                .map_err(db_error)?;
            if changed > 0 {
                transaction
                    .execute(
                        "INSERT INTO resource_epochs(project,revision) VALUES (?1,1)
                    ON CONFLICT(project) DO UPDATE SET revision=revision+1",
                        [&self.project],
                    )
                    .map_err(db_error)?;
            }
            transaction.commit().map_err(db_error)
        })
    }

    pub(in crate::server) fn restore_resource(&self, id: &str, path: &str) -> Result<(), ApiError> {
        let resource = self.resource(id, true)?;
        if !resource.deleted && resource.path != path {
            return Err(ApiError::conflict(
                "This resource identity is already active at another location.",
            ));
        }
        files::validate_relative(path)?;
        self.store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction.execute("UPDATE resources SET deleted=1 WHERE project=?1 AND path=?2 AND id!=?3 AND deleted=0",
                params![self.project,path,id]).map_err(db_error)?;
            transaction.execute("UPDATE resources SET path=?3,deleted=0 WHERE project=?1 AND id=?2",
                params![self.project,id,path]).map_err(db_error)?;
            transaction.execute("INSERT INTO resource_epochs(project,revision) VALUES (?1,1)
                ON CONFLICT(project) DO UPDATE SET revision=revision+1", [&self.project]).map_err(db_error)?;
            transaction.commit().map_err(db_error)
        })
    }

    pub(in crate::server) fn move_resources(
        &self,
        old: &str,
        new: &str,
        move_file: impl FnOnce() -> Result<(), ApiError>,
        undo_file: impl FnOnce() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        self.store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            transaction.execute("UPDATE resources SET deleted=1 WHERE project=?1 AND deleted=0
                AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')",
                params![self.project,new]).map_err(db_error)?;
            transaction.execute("UPDATE resources SET path=?3||substr(path,length(?2)+1)
                WHERE project=?1 AND deleted=0 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')",
                params![self.project,old,new]).map_err(db_error)?;
            transaction.execute("INSERT INTO resource_epochs(project,revision) VALUES (?1,1)
                ON CONFLICT(project) DO UPDATE SET revision=revision+1", [&self.project]).map_err(db_error)?;
            move_file()?;
            if let Err(error) = transaction.commit().map_err(db_error) {
                if let Err(rollback) = undo_file() {
                    return Err(ApiError::internal(format!("Identity storage failed and the move could not be rolled back: {} / {}. Do not edit either location until storage is repaired.", error.message, rollback.message)));
                }
                return Err(error);
            }
            Ok(())
        })
    }
}
