use axum::{
    Json,
    extract::{Extension, State},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use zeroize::Zeroizing;

use super::{ApiError, Registry, Summary, public::PublicLinkInfo};
use crate::{
    auth::{AuthenticatedUser, hash_password},
    server::{AppState, Work, routes::blocking, state_store::now},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(in crate::server) struct PublicOptions {
    pub expires_at: Option<i64>,
    pub password: Option<String>,
    #[serde(default)]
    pub clear_password: bool,
}

pub(super) struct PreparedOptions {
    expires_at: Option<i64>,
    password: Option<Option<String>>,
}

impl PublicOptions {
    pub(super) fn prepare(self) -> Result<PreparedOptions, ApiError> {
        let password = Zeroizing::new(self.password.unwrap_or_default());
        let time = now()?;
        if self
            .expires_at
            .is_some_and(|deadline| deadline <= time || deadline > 8_640_000_000_000_000)
        {
            return Err(ApiError::bad_request(
                "Choose a valid future expiration time, or leave it empty.",
            ));
        }
        if self.clear_password && !password.is_empty() {
            return Err(ApiError::bad_request(
                "Choose either a new password or Remove password.",
            ));
        }
        if !password.is_empty()
            && (!(8..=1024).contains(&password.len()) || password.chars().any(char::is_control))
        {
            return Err(ApiError::bad_request(
                "Share passwords must contain 8-1024 UTF-8 bytes without control characters.",
            ));
        }
        let password = if self.clear_password {
            Some(None)
        } else if password.is_empty() {
            None
        } else {
            Some(Some(hash_password(&password).map_err(ApiError::internal)?))
        };
        Ok(PreparedOptions {
            expires_at: self.expires_at,
            password,
        })
    }
}

impl PreparedOptions {
    pub(super) fn apply(self, link: &mut super::public::PublicLink) {
        link.expires_at = self.expires_at;
        if let Some(password) = self.password {
            link.password_hash = password;
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct SharedDocument {
    project: String,
    project_name: String,
    path: String,
    #[serde(flatten)]
    link: PublicLinkInfo,
}

impl Registry {
    pub(super) fn revoke_public(
        &self,
        id: &str,
        username: &str,
        document: &str,
    ) -> Result<Summary, ApiError> {
        let identity = self
            .users
            .account_id(username)
            .map_err(ApiError::internal)?;
        self.mutate(|catalog| {
            let project = catalog
                .projects
                .get_mut(id)
                .filter(|project| project.owned(&identity))
                .ok_or_else(|| ApiError::forbidden("Only the owner can revoke public links."))?;
            let path = self.permission_path(id, document)?;
            project.public_links.remove(&path);
            self.summarize(project, id, &identity)
        })
    }

    pub(super) fn public_options(
        &self,
        id: &str,
        username: &str,
        document: &str,
        expires: Option<i64>,
        password: Option<String>,
        clear_password: bool,
    ) -> Result<Summary, ApiError> {
        self.initialize()?;
        let identity = self
            .users
            .account_id(username)
            .map_err(ApiError::internal)?;
        let project = self.project(id, &identity)?;
        if !project.owned(&identity) {
            return Err(ApiError::forbidden(
                "Only the owner can configure public links.",
            ));
        }
        let path = self.permission_path(id, document)?;
        if !project.public_links.contains_key(&path) {
            return Err(ApiError::bad_request(
                "Create a public link before setting its options.",
            ));
        }
        let options = PublicOptions {
            expires_at: expires,
            password,
            clear_password,
        }
        .prepare()?;
        self.mutate(|catalog| {
            let project = catalog
                .projects
                .get_mut(id)
                .filter(|project| project.owned(&identity))
                .ok_or_else(|| ApiError::forbidden("Only the owner can configure public links."))?;
            let link = project
                .public_links
                .get_mut(&self.permission_path(id, document)?)
                .ok_or_else(|| ApiError::bad_request("The public link was removed."))?;
            options.apply(link);
            self.summarize(project, id, &identity)
        })
    }
}

pub(in crate::server) async fn list(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
) -> Result<Json<Vec<SharedDocument>>, ApiError> {
    let Extension(user) =
        user.ok_or_else(|| ApiError::forbidden("Public-link management requires a user account."))?;
    blocking(state, work, move |state, _| {
        let registry = state
            .projects
            .as_ref()
            .ok_or_else(|| ApiError::internal("Projects are unavailable."))?;
        let identity = registry
            .users
            .account_id(&user.username)
            .map_err(ApiError::internal)?;
        registry.list(&user)?;
        let catalog = registry.catalog()?;
        Ok(catalog
            .projects
            .iter()
            .filter(|(_, project)| project.owned(&identity))
            .flat_map(|(id, project)| {
                project
                    .public_links
                    .iter()
                    .map(move |(path, link)| SharedDocument {
                        project: id.clone(),
                        project_name: project.name.clone(),
                        path: path.clone(),
                        link: link.info(),
                    })
            })
            .collect())
    })
    .await
    .map(Json)
}
