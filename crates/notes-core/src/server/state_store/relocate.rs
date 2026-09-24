use super::workspaces::Workspace;
use super::{ApiError, ProjectStore, db_error};
use rusqlite::params;
use std::collections::BTreeMap;

impl ProjectStore {
    pub(in crate::server) fn relocate(&self, old: &str, new: &str) -> Result<(), ApiError> {
        self.store.with(|connection| {
            let transaction=connection.transaction().map_err(db_error)?;
            transaction.execute("UPDATE revisions SET path=(SELECT path FROM resources WHERE id=revisions.resource_id)
                WHERE project=?1 AND resource_id IN (SELECT id FROM resources WHERE project=?1 AND deleted=0
                    AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/'))",
                params![self.project,new]).map_err(db_error)?;
            transaction.execute("DELETE FROM rooms WHERE project=?1 AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')",
                params![self.project,old]).map_err(db_error)?;
            transaction.execute("UPDATE document_index SET stamp='' WHERE project=?1",[&self.project]).map_err(db_error)?;
            let mut moved_query=transaction.prepare("SELECT id,path FROM resources WHERE project=?1 AND deleted=0
                AND (path=?2 OR substr(path,1,length(?2)+1)=?2||'/')").map_err(db_error)?;
            let moved=moved_query.query_map(params![self.project,new],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
                .map_err(db_error)?.collect::<Result<BTreeMap<_,_>,_>>().map_err(db_error)?;
            drop(moved_query);
            let mut statement=transaction.prepare("SELECT user_id,data FROM user_workspaces").map_err(db_error)?;
            let workspaces=statement.query_map([],|row|Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?)))
                .map_err(db_error)?.collect::<Result<Vec<_>,_>>().map_err(db_error)?;
            drop(statement);
            for (user,data) in workspaces {
                let mut workspace:Workspace=serde_json::from_str(&data).map_err(|error|ApiError::internal(error.to_string()))?;
                let mut changed=false;
                for note in workspace.tabs.iter_mut().map(|tab|&mut tab.note).chain(workspace.favorites.iter_mut()).chain(workspace.recent.iter_mut()) {
                    if note.project==self.project {
                        if let Some(path)=note.id.as_ref().and_then(|id|moved.get(id)) {
                            changed|=note.path!=*path;
                            note.path=path.clone();
                        }
                    }
                }
                if changed {
                    transaction.execute("UPDATE user_workspaces SET data=?2,revision=MAX(revision+1,?3) WHERE user_id=?1",
                        params![user,serde_json::to_string(&workspace).map_err(|error|ApiError::internal(error.to_string()))?,super::now()?]).map_err(db_error)?;
                }
            }
            transaction.commit().map_err(db_error)
        })
    }
}
