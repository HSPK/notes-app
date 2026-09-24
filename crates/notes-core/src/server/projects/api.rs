use axum::{
    Json,
    extract::{Extension, State, rejection::JsonRejection},
};
use serde::Deserialize;
use std::{fs, path::PathBuf, sync::Arc};
use zeroize::Zeroize;

use super::{Project, Registry, Sharing, Summary, private_directory, validate_name};
use crate::{
    auth::{AuthenticatedUser, Role},
    server::{
        ApiError, AppState, Work, files, git, hex,
        routes::{blocking, json_error},
    },
};

pub(in crate::server) async fn scope(
    state: Arc<AppState>,
    uri: axum::http::Uri,
    headers: axum::http::HeaderMap,
    user: Option<AuthenticatedUser>,
) -> Result<Arc<AppState>, ApiError> {
    if super::public::endpoint(uri.path()) {
        return super::public::scope(state, uri, headers).await;
    }
    let scoped = matches!(
        uri.path(),
        "/api/session"
            | "/api/tree"
            | "/api/document"
            | "/api/entry"
            | "/api/directory"
            | "/api/preview"
            | "/api/git"
            | "/api/git/diff"
            | "/api/git/sync"
            | "/assets"
            | "/api/images"
            | "/api/history"
            | "/api/backlinks"
            | "/api/attachments"
            | "/api/history/content"
            | "/api/history/restore"
            | "/api/trash"
            | "/api/trash/restore"
            | "/api/collaboration/join"
            | "/api/collaboration/presence"
            | "/api/collaboration/socket"
            | "/api/resource"
            | "/api/resources/resolve"
    );
    if !scoped || state.projects.is_none() {
        return Ok(state);
    }
    let user = user.ok_or_else(|| ApiError::forbidden("Log in to access projects."))?;
    #[derive(Deserialize)]
    struct Query {
        project: Option<String>,
        id: Option<String>,
        document: Option<String>,
    }
    let query = axum::extract::Query::<Query>::try_from_uri(&uri)
        .map_err(|_| ApiError::bad_request("Invalid project query."))?;
    if headers.get_all("x-notes-project").iter().count() > 1 {
        return Err(ApiError::bad_request("Choose one project."));
    }
    let selected = headers
        .get("x-notes-project")
        .map(|value| value.to_str())
        .transpose()
        .map_err(|_| ApiError::bad_request("Invalid project header."))?
        .map(str::to_owned)
        .or(query.project.clone());
    let resource_id = match uri.path() {
        "/api/resource" | "/api/document" | "/api/entry" | "/assets" | "/api/git/diff" => {
            query.id.clone()
        }
        "/api/history" | "/api/history/content" | "/api/backlinks" | "/api/images" => {
            query.document.clone()
        }
        _ => None,
    };
    let historical_resource = matches!(
        uri.path(),
        "/api/history" | "/api/history/content" | "/api/git/diff"
    );
    tokio::task::spawn_blocking(move || {
        let mut scoped = (*state).clone();
        let registry = state
            .projects
            .as_ref()
            .ok_or_else(|| ApiError::internal("Projects are unavailable."))?;
        let id = if let Some(resource) = resource_id {
            let project = registry
                .storage()?
                .resource(&resource, historical_resource)?
                .project;
            if selected
                .as_ref()
                .is_some_and(|selected| selected != &project)
            {
                return Err(ApiError::forbidden(
                    "The resource and selected project do not match.",
                ));
            }
            project
        } else {
            selected.unwrap_or_else(|| "default".into())
        };
        let access = registry.resolve(&id, &user)?;
        scoped.library = access.library.clone();
        scoped.access = Some(access);
        Ok(Arc::new(scoped))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Project lookup failed: {error}")))?
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(in crate::server) enum Action {
    Create {
        name: String,
        kind: String,
        source: Option<String>,
        token: Option<String>,
    },
    Share {
        id: String,
        name: Option<String>,
        document: Option<String>,
        shared: Sharing,
        image_directory: Option<String>,
    },
    Credential {
        id: String,
        token: String,
    },
    Document {
        id: String,
        document: String,
        permission: super::public::DocumentPermission,
        #[serde(default)]
        reset_link: bool,
        public_options: Option<super::shares::PublicOptions>,
    },
    PublicOptions {
        id: String,
        document: String,
        expires_at: Option<i64>,
        password: Option<String>,
        #[serde(default)]
        clear_password: bool,
    },
    RevokePublic {
        id: String,
        document: String,
    },
}

pub(in crate::server) async fn list(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
) -> Result<Json<Vec<Summary>>, ApiError> {
    let Extension(user) =
        user.ok_or_else(|| ApiError::forbidden("Projects require user accounts."))?;
    blocking(state, work, move |state, _| registry(state)?.list(&user))
        .await
        .map(Json)
}

pub(in crate::server) async fn manage(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
    body: Result<Json<Action>, JsonRejection>,
) -> Result<Json<Summary>, ApiError> {
    let Json(action) = body.map_err(json_error)?;
    let Extension(user) =
        user.ok_or_else(|| ApiError::forbidden("Projects require user accounts."))?;
    blocking(state, work, move |state, work| {
        let registry = registry(state)?;
        match action {
            Action::RevokePublic { id, document } => {
                registry.revoke_public(&id, &user.username, &document)
            }
            Action::PublicOptions {
                id,
                document,
                expires_at,
                password,
                clear_password,
            } => registry.public_options(
                &id,
                &user.username,
                &document,
                expires_at,
                password,
                clear_password,
            ),
            Action::Document {
                id,
                document,
                permission,
                reset_link,
                public_options,
            } => registry.document_permission(
                &id,
                &user.username,
                document,
                permission,
                reset_link,
                public_options,
            ),
            Action::Create {
                name,
                kind,
                source,
                token,
            } => create(registry, &user, name, &kind, source, token, work),
            Action::Share {
                id,
                name,
                document,
                shared,
                image_directory,
            } => {
                let path = document
                    .as_deref()
                    .map(|document| registry.permission_path(&id, document))
                    .transpose()?;
                registry.manage(&id, &user.username, name, path, shared, image_directory)
            }
            Action::Credential { id, mut token } => {
                let identity = registry
                    .users
                    .account_id(&user.username)
                    .map_err(ApiError::internal)?;
                let result = registry.mutate(|catalog| {
                    let project = catalog
                        .projects
                        .get_mut(&id)
                        .filter(|p| p.owned(&identity))
                        .ok_or_else(|| {
                            ApiError::forbidden(
                                "Only the project owner can change its GitHub token.",
                            )
                        })?;
                    if project.repository.is_none() {
                        return Err(ApiError::bad_request("This is not a GitHub project."));
                    }
                    validate_token(Some(&token))?;
                    project.token = (!token.is_empty()).then(|| token.clone());
                    registry.summarize(project, &id, &identity)
                });
                token.zeroize();
                result
            }
        }
    })
    .await
    .map(Json)
}

fn registry(state: &AppState) -> Result<&Registry, ApiError> {
    state
        .projects
        .as_deref()
        .ok_or_else(|| ApiError::forbidden("Projects require user accounts."))
}

fn github_url(source: &str) -> Result<String, ApiError> {
    let source = source
        .strip_prefix("https://github.com/")
        .unwrap_or(source)
        .trim_end_matches('/');
    let source = source.strip_suffix(".git").unwrap_or(source);
    let parts = source.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || *part == "."
                || *part == ".."
                || part.len() > 100
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
    {
        return Err(ApiError::bad_request(
            "Use https://github.com/owner/repository or owner/repository.",
        ));
    }
    Ok(format!("https://github.com/{source}.git"))
}

fn create(
    registry: &Registry,
    user: &AuthenticatedUser,
    name: String,
    kind: &str,
    source: Option<String>,
    mut token: Option<String>,
    work: &Work,
) -> Result<Summary, ApiError> {
    let name = validate_name(name)?;
    validate_token(token.as_deref())?;
    token = token.filter(|value| !value.is_empty());
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|error| ApiError::internal(error.to_string()))?;
    let id = hex(&bytes);
    let mut created = None;
    let result = (|| {
        let (root, repository) = match kind {
            "folder" => {
                if user.role != Role::Admin {
                    return Err(ApiError::forbidden(
                        "Only administrators can attach existing server folders.",
                    ));
                }
                let path = PathBuf::from(source.as_deref().unwrap_or(""));
                if !path.is_absolute() {
                    return Err(ApiError::bad_request(
                        "Choose an absolute server directory path.",
                    ));
                }
                let root = files::Root::open(&path)?.path().to_owned();
                if registry.protected.starts_with(&root) || root.starts_with(&registry.protected) {
                    return Err(ApiError::forbidden(
                        "The Notes account and project storage cannot be attached.",
                    ));
                }
                (root, None)
            }
            "new" | "github" => {
                if !registry.managed.exists() {
                    private_directory(&registry.managed)?;
                }
                let root = registry.managed.join(&id);
                private_directory(&root)?;
                created = Some(root.clone());
                let repository = if kind == "github" {
                    let url = github_url(source.as_deref().unwrap_or(""))?;
                    git::clone_repository(
                        &root,
                        &git::Remote {
                            url: url.clone(),
                            token: token.clone(),
                        },
                        &user.username,
                    )?;
                    Some(url)
                } else {
                    None
                };
                (root, repository)
            }
            _ => {
                return Err(ApiError::bad_request(
                    "Choose new, folder, or github as the project source.",
                ));
            }
        };
        work.check()?;
        let root = files::Root::open(&root)?.path().to_owned();
        registry.insert(
            user,
            id,
            Project {
                name,
                owner: Some(user.username.clone()),
                owner_id: Some(
                    registry
                        .users
                        .account_id(&user.username)
                        .map_err(ApiError::internal)?,
                ),
                root,
                token: repository.as_ref().and(token.clone()),
                repository,
                shared: Sharing::Private,
                pages: Default::default(),
                attachments: Default::default(),
                image_directory: super::default_image_directory(),
                public_links: Default::default(),
                git_sync: Default::default(),
            },
        )
    })();
    if let Some(token) = &mut token {
        token.zeroize();
    }
    if result.is_err() {
        if let Some(path) = created {
            if let Err(error) = fs::remove_dir_all(&path) {
                eprintln!(
                    "Could not clean up failed project {}: {error}",
                    path.display()
                );
            }
        }
    }
    result
}

fn validate_token(token: Option<&str>) -> Result<(), ApiError> {
    if token.is_some_and(|token| {
        token.len() > 512
            || !token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    }) {
        return Err(ApiError::bad_request("The GitHub token format is invalid."));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_sources_are_not_arbitrary_remote_commands_or_credentials() {
        assert_eq!(
            github_url("owner/repo").unwrap(),
            "https://github.com/owner/repo.git"
        );
        assert_eq!(
            github_url("https://github.com/owner/repo.git").unwrap(),
            "https://github.com/owner/repo.git"
        );
        for value in [
            "file:///tmp/repo",
            "https://other/repo",
            "https://token@github.com/o/r",
            "o/r/extra",
            "o/..",
            "o/r?token=secret",
            "ext::command",
        ] {
            assert!(github_url(value).is_err(), "{value}");
        }
    }
}
