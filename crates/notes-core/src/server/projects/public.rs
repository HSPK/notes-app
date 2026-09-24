use std::sync::Arc;

use axum::{
    Json,
    body::Bytes,
    extract::Extension,
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use super::{Access, ApiError, Project, Registry, Sharing, Summary, files, hex};
use crate::server::{AppState, Work, routes::blocking};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct PublicLink {
    #[serde(default)]
    pub(super) resource: Option<String>,
    pub(super) token: String,
    pub(super) access: Sharing,
    #[serde(default)]
    pub(super) expires_at: Option<i64>,
    #[serde(default)]
    pub(super) password_hash: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PublicLinkInfo {
    document: Option<String>,
    token: String,
    access: Sharing,
    expires_at: Option<i64>,
    password_required: bool,
}

impl PublicLink {
    pub(super) fn info(&self) -> PublicLinkInfo {
        PublicLinkInfo {
            document: self.resource.clone(),
            token: self.token.clone(),
            access: self.access,
            expires_at: self.expires_at,
            password_required: self.password_hash.is_some(),
        }
    }
    pub(super) fn password_signature(&self) -> String {
        self.password_hash
            .as_deref()
            .map(digest)
            .unwrap_or_default()
    }
    pub(super) fn validate(&self) -> Result<(), ApiError> {
        if let Some(id) = &self.resource {
            crate::server::state_store::resources::validate_id(id)
                .map_err(|_| ApiError::internal("Invalid public document identity."))?;
        }
        if !valid_token(&self.token) || self.access == Sharing::Private {
            return Err(ApiError::internal("Invalid public link configuration."));
        }
        if self
            .expires_at
            .is_some_and(|time| time < 0 || time > 8_640_000_000_000_000)
        {
            return Err(ApiError::internal("Invalid public link expiration."));
        }
        if let Some(hash) = &self.password_hash {
            let parsed = argon2::PasswordHash::new(hash)
                .map_err(|_| ApiError::internal("Invalid public password hash."))?;
            if parsed.algorithm.as_str() != "argon2id" {
                return Err(ApiError::internal("Public passwords must use Argon2id."));
            }
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct GuestGrant {
    pub(super) digest: String,
    pub(super) path: String,
    pub(super) credential: Option<String>,
    pub(super) visitor: Option<String>,
    pub(super) principal: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) enum DocumentPermission {
    Inherit,
    Private,
    Read,
    Edit,
    PublicRead,
    PublicEdit,
}

pub(super) fn digest(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}
fn valid_token(token: &str) -> bool {
    token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit())
}
fn invalid_link() -> ApiError {
    ApiError::forbidden("This public link is invalid or has been revoked.")
}

impl Registry {
    fn public_project(&self, fingerprint: &str) -> Result<(String, String, Project), ApiError> {
        let catalog = self.load()?.ok_or_else(invalid_link)?;
        let (id, path) = catalog
            .public_index
            .get(fingerprint)
            .ok_or_else(invalid_link)?;
        let project = catalog.projects.get(id).cloned().ok_or_else(invalid_link)?;
        let link = project.public_links.get(path).ok_or_else(invalid_link)?;
        let resource = self
            .storage()?
            .project(id)
            .resource(link.resource.as_deref().ok_or_else(invalid_link)?, false)?;
        if resource.path != *path
            || resource.kind != crate::server::state_store::resources::ResourceKind::Document
        {
            return Err(invalid_link());
        }
        let time = crate::server::state_store::now()?;
        if project
            .public_links
            .get(path)
            .and_then(|link| link.expires_at)
            .is_some_and(|deadline| deadline <= time)
        {
            return Err(ApiError::forbidden("This public link has expired."));
        }
        Ok((id.clone(), path.clone(), project))
    }

    pub(super) fn guest_project(&self, id: &str, guest: &GuestGrant) -> Result<Project, ApiError> {
        let (current_id, path, project) = self.public_project(&guest.digest)?;
        if current_id != id || path != guest.path {
            return Err(invalid_link());
        }
        let link = project.public_links.get(&path).ok_or_else(invalid_link)?;
        if link.password_hash.is_some()
            && guest
                .credential
                .as_ref()
                .map(|token| {
                    self.storage()?.project(id).visitor(
                        token,
                        &guest.digest,
                        &link.password_signature(),
                    )
                })
                .transpose()?
                .flatten()
                .is_none()
        {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "A share password is required.",
            ));
        }
        Ok(project)
    }

    fn resolve_public(
        self: &Arc<Self>,
        token: &str,
        headers: &HeaderMap,
    ) -> Result<Access, ApiError> {
        if !valid_token(token) {
            return Err(invalid_link());
        }
        let fingerprint = digest(token);
        let (id, path, project) = self.public_project(&fingerprint)?;
        let library = self.library(&id, &project)?;
        let credential =
            crate::server::security::cookie_value(headers, &visitor_cookie(&fingerprint))
                .map(str::to_owned);
        let link = project.public_links.get(&path).ok_or_else(invalid_link)?;
        let visitor = credential
            .as_ref()
            .map(|token| {
                self.storage()?.project(&id).visitor(
                    token,
                    &fingerprint,
                    &link.password_signature(),
                )
            })
            .transpose()?
            .flatten();
        let principal = format!(
            "{fingerprint}:{}",
            if visitor.is_some() {
                credential.as_deref().map(digest).unwrap_or_default()
            } else {
                String::new()
            }
        );
        Ok(Access {
            registry: self.clone(),
            id,
            library,
            username: String::new(),
            identity: String::new(),
            guest: Some(GuestGrant {
                digest: fingerprint,
                path,
                credential,
                visitor,
                principal,
            }),
        })
    }

    pub(super) fn document_permission(
        &self,
        id: &str,
        user: &str,
        document: String,
        permission: DocumentPermission,
        reset_link: bool,
        options: Option<super::shares::PublicOptions>,
    ) -> Result<Summary, ApiError> {
        self.initialize()?;
        let identity = self.users.account_id(user).map_err(ApiError::internal)?;
        if !self.project(id, &identity)?.owned(&identity) {
            return Err(ApiError::forbidden(
                "Only the owner can change document permissions.",
            ));
        }
        let options = options.map(|options| options.prepare()).transpose()?;
        self.mutate(|catalog| {
            let project = catalog
                .projects
                .get_mut(id)
                .filter(|project| project.owned(&identity))
                .ok_or_else(|| {
                    ApiError::forbidden("Only the owner can change document permissions.")
                })?;
            let path = self.permission_path(id, &document)?;
            files::validate_document_path(&path)?;
            let revoking = matches!(
                permission,
                DocumentPermission::Inherit | DocumentPermission::Private
            );
            let (path, content) = if revoking && project.pages.contains_key(&path) {
                (path, None)
            } else {
                let root = files::Root::open(&project.root)?;
                let path = root.canonical_document_path(&path)?;
                let content = if revoking {
                    None
                } else {
                    Some(root.document(&path)?.content)
                };
                (path, content)
            };
            if project.pages.len() >= 5000 && !project.pages.contains_key(&path) {
                return Err(ApiError::conflict(
                    "The document permission limit was reached.",
                ));
            }
            let level = match permission {
                DocumentPermission::Inherit => None,
                DocumentPermission::Private => Some(Sharing::Private),
                DocumentPermission::Read | DocumentPermission::PublicRead => Some(Sharing::Read),
                DocumentPermission::Edit | DocumentPermission::PublicEdit => Some(Sharing::Edit),
            };
            if let Some(level) = level {
                project.pages.insert(path.clone(), level);
                if let Some(content) = content {
                    project.attachments.insert(
                        path.clone(),
                        crate::server::markdown::referenced_assets(&path, &content),
                    );
                }
            } else {
                project.pages.remove(&path);
                project.attachments.remove(&path);
            }
            if matches!(
                permission,
                DocumentPermission::PublicRead | DocumentPermission::PublicEdit
            ) {
                let access =
                    level.ok_or_else(|| ApiError::internal("Missing public permission."))?;
                let token = if !reset_link {
                    project
                        .public_links
                        .get(&path)
                        .map(|link| link.token.clone())
                } else {
                    None
                };
                let token = match token {
                    Some(token) => token,
                    None => {
                        let mut bytes = [0; 32];
                        getrandom::fill(&mut bytes)
                            .map_err(|error| ApiError::internal(error.to_string()))?;
                        hex(&bytes)
                    }
                };
                let previous = project.public_links.get(&path);
                let expires_at = previous.and_then(|link| link.expires_at);
                let password_hash = previous.and_then(|link| link.password_hash.clone());
                let mut link = PublicLink {
                    resource: Some(document.clone()),
                    token,
                    access,
                    expires_at,
                    password_hash,
                };
                if let Some(options) = options {
                    options.apply(&mut link);
                }
                project.public_links.insert(path, link);
            } else {
                project.public_links.remove(&path);
            }
            self.summarize(project, id, &identity)
        })
    }
}

pub(in crate::server) fn endpoint(path: &str) -> bool {
    matches!(
        path,
        "/api/public/session"
            | "/api/public/resource"
            | "/api/public/resources/resolve"
            | "/api/public/document"
            | "/api/public/preview"
            | "/api/public/assets"
            | "/api/public/images"
            | "/api/public/collaboration/join"
            | "/api/public/collaboration/presence"
            | "/api/public/collaboration/socket"
    )
}

pub(in crate::server) async fn scope(
    state: Arc<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Arc<AppState>, ApiError> {
    #[derive(Deserialize)]
    struct Query {
        share: Option<String>,
    }
    let query = axum::extract::Query::<Query>::try_from_uri(&uri).map_err(|_| invalid_link())?;
    if headers.get_all("x-notes-share").iter().count() > 1 {
        return Err(invalid_link());
    }
    let token = headers
        .get("x-notes-share")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .or(query.share.clone())
        .ok_or_else(invalid_link)?;
    tokio::task::spawn_blocking(move || {
        let registry = state.projects.as_ref().ok_or_else(invalid_link)?;
        let access = registry.resolve_public(&token, &headers)?;
        if uri.path() != "/api/public/session" {
            access.check(
                access.guest.as_ref().map(|guest| guest.path.as_str()),
                false,
            )?;
        }
        let mut scoped = (*state).clone();
        scoped.library = access.library.clone();
        scoped.access = Some(access);
        Ok(Arc::new(scoped))
    })
    .await
    .map_err(|error| ApiError::internal(format!("Public link lookup failed: {error}")))?
}

#[derive(Serialize)]
pub(in crate::server) struct Session {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    writable: bool,
    #[serde(rename = "passwordRequired", skip_serializing_if = "is_false")]
    password_required: bool,
}
fn is_false(value: &bool) -> bool {
    !value
}

fn visitor_cookie(fingerprint: &str) -> String {
    format!("notes_share_{}", &fingerprint[..24])
}

pub(in crate::server) async fn session(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Bytes,
) -> Result<Response, ApiError> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Credentials {
        password: String,
    }
    impl Drop for Credentials {
        fn drop(&mut self) {
            self.password.zeroize();
        }
    }
    let mut credentials = if body.is_empty() {
        None
    } else {
        Some(
            serde_json::from_slice::<Credentials>(&body)
                .map_err(|_| ApiError::bad_request("Invalid share password request."))?,
        )
    };
    let (session, cookie) = blocking(state, work, move |state, _| {
        let access = state.access.as_ref().ok_or_else(invalid_link)?;
        let guest = access.guest.as_ref().ok_or_else(invalid_link)?;
        let (id, path, project) = access.registry.public_project(&guest.digest)?;
        let link = project.public_links.get(&path).ok_or_else(invalid_link)?;
        let store = access.registry.storage()?.project(&id);
        let existing = guest
            .credential
            .as_ref()
            .map(|token| store.visitor(token, &guest.digest, &link.password_signature()))
            .transpose()?
            .flatten();
        if link.password_hash.is_some() && existing.is_none() {
            let Some(input) = &mut credentials else {
                return Ok((
                    Session {
                        id: None,
                        project: None,
                        path: None,
                        writable: false,
                        password_required: true,
                    },
                    None,
                ));
            };
            let valid = if input.password.len() <= 1024 {
                crate::auth::verify_password(
                    link.password_hash.as_deref().ok_or_else(invalid_link)?,
                    &input.password,
                )
                .map_err(ApiError::internal)
            } else {
                Ok(false)
            };
            input.password.zeroize();
            if !valid? {
                return Err(ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "The share password is incorrect.",
                ));
            }
        }
        let document = state.root.source_document(&path)?;
        let resource_id = document
            .id
            .ok_or_else(|| ApiError::internal("This document has no resource identity."))?;
        let cookie = if existing.is_none() {
            let (token, expires) =
                store.issue_visitor(&guest.digest, &link.password_signature(), link.expires_at)?;
            Some(format!(
                "{}={token}; Path=/api/public; HttpOnly; SameSite=Strict; Max-Age={}",
                visitor_cookie(&guest.digest),
                (expires - crate::server::state_store::now()?).max(0) / 1000
            ))
        } else {
            None
        };
        Ok((
            Session {
                id: Some(resource_id),
                project: Some(id),
                path: Some(path),
                writable: link.access == Sharing::Edit,
                password_required: false,
            },
            cookie,
        ))
    })
    .await?;
    let mut response = Json(session).into_response();
    if let Some(cookie) = cookie {
        response.headers_mut().insert(
            header::SET_COOKIE,
            HeaderValue::from_str(&cookie)
                .map_err(|_| ApiError::internal("Could not establish the visitor session."))?,
        );
    }
    Ok(response)
}
