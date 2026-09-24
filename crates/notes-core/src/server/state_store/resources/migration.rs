use super::{ApiError, ResourceKind, db_error, ensure_resource, now};
use crate::server::state_store::workspaces::Workspace;
use rusqlite::{Connection, params};
use std::collections::BTreeSet;

pub(in crate::server::state_store) fn migrate(connection: &mut Connection) -> Result<(), ApiError> {
    for table in ["revisions", "trash", "rooms"] {
        let mut fields = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(db_error)?;
        let present = fields
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?
            .iter()
            .any(|name| name == "resource_id");
        drop(fields);
        if !present {
            connection
                .execute_batch(&format!("ALTER TABLE {table} ADD COLUMN resource_id TEXT"))
                .map_err(db_error)?;
        }
    }
    let transaction = connection.transaction().map_err(db_error)?;
    let mut touched = BTreeSet::new();
    for table in ["revisions", "trash", "rooms"] {
        let kind = if table != "trash" { "'note'" } else { "kind" };
        let mut query = transaction
            .prepare(&format!(
                "SELECT DISTINCT project,path,{kind} FROM {table} WHERE resource_id IS NULL"
            ))
            .map_err(db_error)?;
        let locations = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        drop(query);
        for (project, path, kind) in locations {
            let kind = if kind == "note" {
                ResourceKind::Document
            } else {
                ResourceKind::Asset
            };
            let (resource, inserted) = ensure_resource(&transaction, &project, &path, kind)?;
            transaction.execute(&format!("UPDATE {table} SET resource_id=?3 WHERE project=?1 AND path=?2 AND resource_id IS NULL"),
                params![project,path,resource.id]).map_err(db_error)?;
            if inserted {
                touched.insert(project);
            }
        }
    }
    let mut query = transaction
        .prepare("SELECT user_id,data FROM user_workspaces")
        .map_err(db_error)?;
    let workspaces = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    drop(query);
    for (user, data) in workspaces {
        let mut workspace: Workspace =
            serde_json::from_str(&data).map_err(|error| ApiError::internal(error.to_string()))?;
        let mut changed = false;
        for note in workspace
            .tabs
            .iter_mut()
            .map(|tab| &mut tab.note)
            .chain(workspace.favorites.iter_mut())
            .chain(workspace.recent.iter_mut())
        {
            if note.id.is_some() {
                continue;
            }
            let (resource, inserted) = ensure_resource(
                &transaction,
                &note.project,
                &note.path,
                ResourceKind::Document,
            )?;
            note.id = Some(resource.id);
            changed = true;
            if inserted {
                touched.insert(note.project.clone());
            }
        }
        if changed {
            transaction.execute("UPDATE user_workspaces SET data=?2,revision=MAX(revision+1,?3) WHERE user_id=?1",
                params![user,serde_json::to_string(&workspace).map_err(|error| ApiError::internal(error.to_string()))?,now()?]).map_err(db_error)?;
        }
    }
    for project in touched {
        transaction
            .execute(
                "INSERT INTO resource_epochs(project,revision) VALUES (?1,1)
            ON CONFLICT(project) DO UPDATE SET revision=revision+1",
                [project],
            )
            .map_err(db_error)?;
    }
    transaction.execute_batch("CREATE INDEX IF NOT EXISTS revision_resource ON revisions(project,resource_id,id DESC);
        CREATE INDEX IF NOT EXISTS trash_resource ON trash(project,resource_id,id);").map_err(db_error)?;
    transaction.commit().map_err(db_error)
}
