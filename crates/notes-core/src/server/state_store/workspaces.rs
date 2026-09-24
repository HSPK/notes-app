use super::{ApiError, Store, db_error, now};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub(in crate::server) struct NoteRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub project: String,
    pub path: String,
    pub title: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(in crate::server) struct Tab {
    pub note: NoteRef,
    pub pinned: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields)]
pub(in crate::server) struct Workspace {
    pub tabs: Vec<Tab>,
    pub favorites: Vec<NoteRef>,
    pub recent: Vec<NoteRef>,
}

#[derive(Serialize)]
pub(in crate::server) struct WorkspaceState {
    pub revision: i64,
    pub workspace: Workspace,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::server) enum WorkspaceAction {
    Visit {
        project: String,
        #[serde(rename = "id")]
        path: String,
    },
    Close {
        project: String,
        #[serde(rename = "id")]
        path: String,
    },
    Favorite {
        project: String,
        #[serde(rename = "id")]
        path: String,
        value: bool,
    },
    Pin {
        project: String,
        #[serde(rename = "id")]
        path: String,
        value: bool,
    },
}

impl WorkspaceAction {
    pub fn with_path(mut self, value: String) -> Self {
        match &mut self {
            Self::Visit { path, .. }
            | Self::Close { path, .. }
            | Self::Favorite { path, .. }
            | Self::Pin { path, .. } => *path = value,
        }
        self
    }

    pub fn target(&self) -> (&str, &str) {
        match self {
            Self::Visit { project, path }
            | Self::Close { project, path }
            | Self::Favorite { project, path, .. }
            | Self::Pin { project, path, .. } => (project, path),
        }
    }
    pub fn needs_access(&self) -> bool {
        !matches!(
            self,
            Self::Close { .. }
                | Self::Favorite { value: false, .. }
                | Self::Pin { value: false, .. }
        )
    }
}

impl Store {
    pub(in crate::server) fn user_key(&self, user: &str) -> Result<String, ApiError> {
        self.with(|connection| {
            let existing: Option<Vec<u8>> = connection
                .query_row(
                    "SELECT secret FROM user_keys WHERE user_id=?1",
                    [user],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            let secret = match existing {
                Some(secret) => secret,
                None => {
                    let mut secret = vec![0; 32];
                    getrandom::fill(&mut secret)
                        .map_err(|error| ApiError::internal(error.to_string()))?;
                    connection
                        .execute(
                            "INSERT OR IGNORE INTO user_keys(user_id,secret) VALUES (?1,?2)",
                            params![user, secret],
                        )
                        .map_err(db_error)?;
                    connection
                        .query_row(
                            "SELECT secret FROM user_keys WHERE user_id=?1",
                            [user],
                            |row| row.get(0),
                        )
                        .map_err(db_error)?
                }
            };
            if secret.len() != 32 {
                return Err(ApiError::internal("The private recovery key is invalid."));
            }
            Ok(crate::server::hex(&secret))
        })
    }

    pub(in crate::server) fn workspace(&self, user: &str) -> Result<WorkspaceState, ApiError> {
        self.with_read(|connection| {
            let row: Option<(i64, String)> = connection
                .query_row(
                    "SELECT revision,data FROM user_workspaces WHERE user_id=?1",
                    [user],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?;
            match row {
                Some((revision, data)) => Ok(WorkspaceState {
                    revision,
                    workspace: serde_json::from_str(&data).map_err(|error| {
                        ApiError::internal(format!("Invalid saved workspace: {error}"))
                    })?,
                }),
                None => Ok(WorkspaceState {
                    revision: 0,
                    workspace: Workspace::default(),
                }),
            }
        })
    }

    pub(in crate::server) fn change_workspace(
        &self,
        user: &str,
        action: WorkspaceAction,
        title: Option<String>,
        resource_id: &str,
    ) -> Result<WorkspaceState, ApiError> {
        self.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            let stored: Option<(i64, String)> = transaction
                .query_row(
                    "SELECT revision,data FROM user_workspaces WHERE user_id=?1",
                    [user],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()
                .map_err(db_error)?;
            let (revision, mut workspace) = match &stored {
                Some((revision, data)) => (
                    *revision,
                    serde_json::from_str::<Workspace>(data)
                        .map_err(|error| ApiError::internal(error.to_string()))?,
                ),
                None => (0, Workspace::default()),
            };
            let (project, path) = action.target();
            let same = |note: &NoteRef| {
                note.project == project
                    && note
                        .id
                        .as_deref()
                        .map_or(note.path == path, |id| id == resource_id)
            };
            let note = NoteRef {
                id: Some(resource_id.into()),
                project: project.into(),
                path: path.into(),
                title: title.unwrap_or_else(|| path.into()),
            };
            match &action {
                WorkspaceAction::Visit { .. } => {
                    workspace.recent.retain(|item| !same(item));
                    for favorite in workspace.favorites.iter_mut().filter(|item| same(item)) {
                        *favorite = note.clone();
                    }
                    workspace.recent.insert(0, note);
                    workspace.recent.truncate(100);
                }
                WorkspaceAction::Close { .. } => workspace.tabs.retain(|tab| !same(&tab.note)),
                WorkspaceAction::Favorite { value, .. } => {
                    workspace.favorites.retain(|item| !same(item));
                    if *value {
                        if workspace.favorites.len() >= 512 {
                            return Err(ApiError::conflict("At most 512 favorites can be saved."));
                        }
                        workspace.favorites.push(note);
                    }
                }
                WorkspaceAction::Pin { value, .. } => {
                    if let Some(tab) = workspace.tabs.iter_mut().find(|tab| same(&tab.note)) {
                        tab.pinned = *value;
                    } else if *value {
                        if workspace.tabs.len() >= 128 {
                            return Err(ApiError::conflict(
                                "Close a tab before opening more than 128 tabs.",
                            ));
                        }
                        workspace.tabs.push(Tab { note, pinned: true });
                    }
                }
            }
            let data = serde_json::to_string(&workspace)
                .map_err(|error| ApiError::internal(error.to_string()))?;
            if stored
                .as_ref()
                .is_some_and(|(_, previous)| previous == &data)
            {
                transaction.commit().map_err(db_error)?;
                return Ok(WorkspaceState {
                    revision,
                    workspace,
                });
            }
            let revision = revision.max(now()?) + 1;
            transaction
                .execute(
                    "INSERT INTO user_workspaces(user_id,revision,data) VALUES (?1,?2,?3)
                ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
                    params![user, revision, data],
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
            Ok(WorkspaceState {
                revision,
                workspace,
            })
        })
    }
}
