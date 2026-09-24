use axum::{
    Json,
    extract::{Extension, State, rejection::JsonRejection},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};

use super::{
    ApiError, AppState, Library, Work,
    routes::{blocking, json_error},
    state_store::search::{Field, Found},
};
use crate::auth::AuthenticatedUser;

#[derive(Default)]
pub(super) struct IndexState {
    paths: Vec<String>,
    cursor: usize,
    scanning: bool,
    finished: Option<Instant>,
    failures: Vec<(String, String)>,
    truncated: bool,
}

impl Library {
    fn index_batch(&self, work: &Work, force: bool) -> Result<bool, ApiError> {
        let store = self.history_store()?;
        let mut scan = self
            .index_state
            .lock()
            .map_err(|_| ApiError::internal("The search index is unavailable."))?;
        if !scan.scanning {
            let dirty = self.index_dirty.swap(false, Ordering::AcqRel);
            if !force
                && !dirty
                && scan
                    .finished
                    .is_some_and(|time| time.elapsed() < Duration::from_secs(30))
            {
                return Ok(false);
            }
            let tree = self.root.tree()?;
            scan.paths = tree.files.into_iter().map(|file| file.path).collect();
            scan.cursor = 0;
            scan.scanning = true;
            scan.truncated = tree.truncated;
            scan.failures.clear();
        }
        let started = Instant::now();
        while scan.cursor < scan.paths.len() {
            work.check()?;
            let path = scan.paths[scan.cursor].clone();
            let result: Result<_, ApiError> = (|| {
                let stamp = self.root.document_stamp(&path)?;
                if store.indexed_stamp(&path)?.as_deref() == Some(&stamp) {
                    return Ok(None);
                }
                let document = self.root.source_document(&path)?;
                if self.root.document_stamp(&path)? != stamp {
                    self.index_dirty.store(true, Ordering::Release);
                    return Ok(None);
                }
                Ok(Some((document, stamp)))
            })();
            match result {
                Ok(Some((document, stamp))) => {
                    store.index_document(&document, &stamp, || work.check())?
                }
                Ok(None) => {}
                Err(error) => {
                    if error.status != axum::http::StatusCode::NOT_FOUND {
                        eprintln!("Could not index {path}: {}", error.message);
                        if scan.failures.len() < 20 {
                            scan.failures.push((path, error.message));
                        }
                    }
                }
            }
            scan.cursor += 1;
            if started.elapsed() > Duration::from_millis(150) {
                break;
            }
        }
        if scan.cursor >= scan.paths.len() {
            scan.paths.clear();
            scan.cursor = 0;
            scan.scanning = false;
            scan.finished = Some(Instant::now());
        }
        Ok(scan.scanning)
    }
}

#[derive(Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Search {
    query: String,
    project: Option<String>,
    field: Field,
    tags: Vec<String>,
    cursor: usize,
    refresh: bool,
}
impl Default for Search {
    fn default() -> Self {
        Self {
            query: String::new(),
            project: None,
            field: Field::All,
            tags: Vec::new(),
            cursor: 0,
            refresh: false,
        }
    }
}

#[derive(Serialize)]
pub(super) struct Results {
    #[serde(flatten)]
    found: Found,
    indexing: bool,
    cursor: usize,
    projects: Vec<ProjectLabel>,
}
#[derive(Serialize)]
struct ProjectLabel {
    id: String,
    name: String,
}

fn hidden_patterns(patterns: &[String]) -> Result<Vec<regex::Regex>, ApiError> {
    patterns
        .iter()
        .map(|pattern| {
            let pattern = pattern.replace('\\', "/");
            let base = pattern
                .strip_suffix("/**")
                .or_else(|| pattern.strip_suffix('/'))
                .unwrap_or(&pattern);
            let parts = base.split('/').collect::<Vec<_>>();
            let expression = parts
                .iter()
                .enumerate()
                .map(|(index, part)| {
                    let last = index + 1 == parts.len();
                    if *part == "**" {
                        return if last {
                            ".*".into()
                        } else {
                            "(?:[^/]+/)*".into()
                        };
                    }
                    regex::escape(part)
                        .replace(r"\*", "[^/]*")
                        .replace(r"\?", "[^/]")
                        + if last { "" } else { "/" }
                })
                .collect::<String>();
            regex::RegexBuilder::new(&format!(
                "{}{}(?:/.*)?$",
                if base.contains('/') { "^" } else { "(?:^|/)" },
                expression
            ))
            .case_insensitive(true)
            .build()
            .map_err(|error| ApiError::bad_request(format!("Invalid hide pattern: {error}")))
        })
        .collect()
}

pub(super) async fn search(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    user: Option<Extension<AuthenticatedUser>>,
    body: Result<Json<Search>, JsonRejection>,
) -> Result<Json<Results>, ApiError> {
    let Extension(user) =
        user.ok_or_else(|| ApiError::forbidden("Workspace search requires user accounts."))?;
    let Json(query) = body.map_err(json_error)?;
    if query.query.len() > 512
        || query.query.split_whitespace().count() > 16
        || query.tags.len() > 64
        || query
            .tags
            .iter()
            .any(|tag| tag.is_empty() || tag.len() > 320)
    {
        return Err(ApiError::bad_request(
            "The search query or tag selection is too large.",
        ));
    }
    blocking(state, work, move |state, work| {
        let registry = state
            .projects
            .as_ref()
            .ok_or_else(|| ApiError::forbidden("Projects are unavailable."))?;
        let visible = registry.list(&user)?;
        if query
            .project
            .as_ref()
            .is_some_and(|id| !visible.iter().any(|project| project.id == *id))
        {
            return Err(ApiError::forbidden(
                "This project is not available to search.",
            ));
        }
        let projects = visible
            .into_iter()
            .filter(|project| query.project.as_ref().is_none_or(|id| *id == project.id))
            .map(|project| ProjectLabel {
                id: project.id,
                name: project.name,
            })
            .collect::<Vec<_>>();
        let mut scopes = BTreeMap::new();
        let mut warnings = Vec::new();
        for project in &projects {
            work.check()?;
            match registry.resolve(&project.id, &user) {
                Ok(scope) => {
                    scopes.insert(project.id.clone(), scope);
                }
                Err(error) => warnings.push(format!("{}: {}", project.name, error.message)),
            }
        }
        let mut cursor = query.cursor.min(projects.len());
        let started = Instant::now();
        let mut indexing = false;
        while cursor < projects.len() {
            work.check()?;
            if let Some(scope) = scopes.get(&projects[cursor].id) {
                if scope.library.index_batch(work, query.refresh)? {
                    indexing = true;
                    break;
                }
            }
            cursor += 1;
            if started.elapsed() > Duration::from_millis(500) {
                indexing = cursor < projects.len();
                break;
            }
        }
        let patterns = hidden_patterns(
            &state
                .web_preferences
                .read()
                .map_err(|_| ApiError::internal("Settings are unavailable."))?
                .hidden_patterns,
        )?;
        let ids = scopes.keys().cloned().collect::<Vec<_>>();
        let mut found = registry.storage()?.search(
            &ids,
            &query.query,
            query.field,
            &query.tags,
            |project, path, stamp| {
                work.check()?;
                if patterns.iter().any(|pattern| pattern.is_match(path)) {
                    return Ok(false);
                }
                let Some(scope) = scopes.get(project) else {
                    return Ok(false);
                };
                if let Err(error) = scope.check(Some(path), false) {
                    return if error.status == axum::http::StatusCode::FORBIDDEN {
                        Ok(false)
                    } else {
                        Err(error)
                    };
                }
                match scope.library.root.document_stamp(path) {
                    Ok(current) if current == stamp => Ok(true),
                    Ok(_) => {
                        scope.library.index_dirty.store(true, Ordering::Release);
                        indexing = true;
                        Ok(false)
                    }
                    Err(error)
                        if matches!(
                            error.status,
                            axum::http::StatusCode::NOT_FOUND | axum::http::StatusCode::FORBIDDEN
                        ) =>
                    {
                        Ok(false)
                    }
                    Err(error) => Err(error),
                }
            },
        )?;
        for scope in scopes.values() {
            let index = scope
                .library
                .index_state
                .lock()
                .map_err(|_| ApiError::internal("The search index is unavailable."))?;
            found.truncated |= index.truncated;
            for (path, message) in &index.failures {
                match scope.check(Some(path), false) {
                    Ok(()) if warnings.len() < 20 => warnings.push(format!("{path}: {message}")),
                    Ok(()) => {}
                    Err(error) if error.status == axum::http::StatusCode::FORBIDDEN => {}
                    Err(error) => return Err(error),
                }
            }
        }
        found.warnings.extend(warnings);
        for (project, scope) in &scopes {
            let positions = found
                .results
                .iter()
                .enumerate()
                .filter(|(_, result)| result.project == *project)
                .map(|(index, result)| (index, result.path.clone()))
                .collect::<Vec<_>>();
            let resources = scope.library.root.resource_store()?.identify_many(
                &positions
                    .iter()
                    .map(|(_, path)| {
                        (
                            path.clone(),
                            super::state_store::resources::ResourceKind::Document,
                        )
                    })
                    .collect::<Vec<_>>(),
            )?;
            for ((position, _), resource) in positions.into_iter().zip(resources) {
                found.results[position].id = Some(resource.id);
            }
        }
        Ok(Results {
            found,
            indexing,
            cursor: if cursor >= projects.len() { 0 } else { cursor },
            projects,
        })
    })
    .await
    .map(Json)
}
