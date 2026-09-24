use std::{
    ffi::OsStr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    Json,
    extract::{Extension, Query, rejection::JsonRejection},
};
use serde::{Deserialize, Serialize};

#[path = "git/process.rs"]
mod process;
#[path = "git/sync.rs"]
pub(super) mod sync;
use process::{Error as RunError, Output};

use super::{
    ApiError, AppState, Work, files,
    routes::{blocking, json_error},
};

const MAX_PATHS: usize = 5000;

pub(super) struct Service {
    root: PathBuf,
    write_lock: Mutex<()>,
    remote: Mutex<Option<Remote>>,
}

#[derive(Clone)]
pub(super) struct Remote {
    pub(super) url: String,
    pub(super) token: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    available: bool,
    repository: bool,
    branch: Option<String>,
    oid: Option<String>,
    upstream: Option<String>,
    ahead: u32,
    behind: u32,
    clean: bool,
    files: Vec<FileStatus>,
    message: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FileStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    kind: super::state_store::resources::ResourceKind,
    path: String,
    original_path: Option<String>,
    index_status: String,
    worktree_status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Diff {
    path: String,
    staged: bool,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct DiffQuery {
    id: String,
    #[serde(default)]
    staged: bool,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(super) enum Action {
    Stage {
        #[serde(rename = "ids")]
        paths: Vec<String>,
    },
    Unstage {
        #[serde(rename = "ids")]
        paths: Vec<String>,
    },
    Commit {
        message: String,
    },
    Pull {
        confirm: bool,
    },
    Push {
        confirm: bool,
    },
}

impl Service {
    pub(super) fn new(root: PathBuf) -> Self {
        Self {
            root,
            write_lock: Mutex::new(()),
            remote: Mutex::new(None),
        }
    }

    pub(super) fn set_remote(&self, remote: Remote) -> Result<(), ApiError> {
        *self
            .remote
            .lock()
            .map_err(|_| ApiError::internal("Git credentials are unavailable."))? = Some(remote);
        Ok(())
    }

    fn status(&self, show_untracked: bool) -> Result<Status, ApiError> {
        match self.repository_root() {
            Err(RunError::Unavailable) => {
                return Ok(Status::unavailable(
                    "Git is not installed or is not on PATH.",
                ));
            }
            Err(RunError::Failed(_)) => {
                return Ok(Status::not_repository(
                    "The notes folder is not a Git repository.",
                ));
            }
            Err(error) => return Err(self.api_error(error)),
            Ok(root) if root != self.root => {
                return Ok(Status::not_repository(
                    "Git write operations require the notes folder itself to be the repository root.",
                ));
            }
            Ok(_) => {}
        }
        let untracked = if show_untracked { "all" } else { "no" };
        let output = self.checked(
            [
                "status",
                "--porcelain=v2",
                "--branch",
                "-z",
                &format!("--untracked-files={untracked}"),
                "--ignore-submodules=all",
            ],
            false,
        )?;
        parse_status(&output.stdout)
    }

    fn diff(&self, path: &str, staged: bool) -> Result<Diff, ApiError> {
        self.require_repository()?;
        files::validate_relative(path)?;
        let mut arguments = vec!["diff", "--no-ext-diff", "--no-textconv", "--unified=3"];
        if staged {
            arguments.push("--cached");
        }
        arguments.extend(["--", path]);
        let mut output = self.checked(arguments, false)?;
        if !staged && output.stdout.is_empty() && !self.is_tracked(path)? {
            let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
            output = self
                .run(
                    [
                        "diff",
                        "--no-index",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--unified=3",
                        "--",
                        null,
                        path,
                    ],
                    false,
                )
                .map_err(|error| self.api_error(error))?;
            if !output.status.success() && output.status.code() != Some(1) {
                return Err(self.api_error(RunError::Failed(output)));
            }
        }
        let text = String::from_utf8(output.stdout)
            .map_err(|_| ApiError::bad_request("Git diff contains non-Unicode output."))?;
        Ok(Diff {
            path: path.to_owned(),
            staged,
            text,
        })
    }

    fn apply(&self, action: Action) -> Result<(), ApiError> {
        let _write = self.write_lock.try_lock().map_err(|_| {
            ApiError::conflict("Another Git operation is running. Please retry after it finishes.")
        })?;
        self.require_repository()?;
        match action {
            Action::Stage { paths } => {
                let paths = validate_paths(paths)?;
                let mut arguments = vec!["add", "--all", "--"];
                arguments.extend(paths.iter().map(String::as_str));
                self.checked(arguments, true)?;
            }
            Action::Unstage { paths } => {
                let paths = validate_paths(paths)?;
                let mut arguments = vec!["reset", "-q", "HEAD", "--"];
                arguments.extend(paths.iter().map(String::as_str));
                self.checked(arguments, true)?;
            }
            Action::Commit { message } => {
                let message = validate_message(message)?;
                self.checked(["commit", "--no-verify", "-m", &message], true)?;
            }
            Action::Pull { confirm } => {
                require_confirmation(confirm)?;
                if !self.status(true)?.clean {
                    return Err(ApiError::conflict(
                        "Commit or discard local changes before pulling.",
                    ));
                }
                self.checked(["pull", "--ff-only"], true)?;
            }
            Action::Push { confirm } => {
                require_confirmation(confirm)?;
                self.checked(["push"], true)?;
            }
        }
        Ok(())
    }

    fn is_tracked(&self, path: &str) -> Result<bool, ApiError> {
        let output = self
            .run(["ls-files", "--error-unmatch", "--", path], false)
            .map_err(|error| self.api_error(error))?;
        match output.status.code() {
            Some(0) => Ok(true),
            Some(1) => Ok(false),
            _ => Err(self.api_error(RunError::Failed(output))),
        }
    }

    fn require_repository(&self) -> Result<(), ApiError> {
        let root = self
            .repository_root()
            .map_err(|error| self.api_error(error))?;
        if root != self.root {
            return Err(ApiError::forbidden(
                "The notes folder must be the Git repository root.",
            ));
        }
        Ok(())
    }

    fn repository_root(&self) -> Result<PathBuf, RunError> {
        let output = self.run(["rev-parse", "--show-toplevel"], false)?;
        if !output.status.success() {
            return Err(RunError::Failed(output));
        }
        let path = String::from_utf8(output.stdout)
            .map_err(|_| RunError::Io("Git returned a non-Unicode repository path.".into()))?;
        std::fs::canonicalize(path.trim()).map_err(|error| RunError::Io(error.to_string()))
    }

    fn checked<I, S>(&self, arguments: I, write: bool) -> Result<Output, ApiError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let output = self
            .run(arguments, write)
            .map_err(|error| self.api_error(error))?;
        if output.status.success() {
            Ok(output)
        } else {
            Err(self.api_error(RunError::Failed(output)))
        }
    }

    fn run<I, S>(&self, arguments: I, write: bool) -> Result<Output, RunError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let remote = self
            .remote
            .lock()
            .map_err(|_| RunError::Io("Git credentials are unavailable.".into()))?
            .clone();
        process::run(&self.root, arguments, write, remote.as_ref(), false)
    }

    fn api_error(&self, error: RunError) -> ApiError {
        let message = match error {
            RunError::Unavailable => "Git is not installed or is not on PATH.".into(),
            RunError::Timeout => "Git did not finish within 8 seconds.".into(),
            RunError::TooLarge => "Git produced more than 4 MiB of output.".into(),
            RunError::Io(message) => format!("Git could not run: {message}"),
            RunError::Failed(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                let message = stderr
                    .trim()
                    .replace(&self.root.to_string_lossy().to_string(), ".");
                if message.is_empty() {
                    format!("Git exited with status {}.", output.status)
                } else {
                    format!(
                        "Git failed: {}",
                        message.chars().take(2000).collect::<String>()
                    )
                }
            }
        };
        ApiError::bad_request(message)
    }
}

impl Status {
    fn unavailable(message: &str) -> Self {
        Self {
            available: false,
            repository: false,
            branch: None,
            oid: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            clean: true,
            files: Vec::new(),
            message: Some(message.into()),
        }
    }

    fn not_repository(message: &str) -> Self {
        Self {
            available: true,
            ..Self::unavailable(message)
        }
    }
}

fn validate_paths(paths: Vec<String>) -> Result<Vec<String>, ApiError> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err(ApiError::bad_request(
            "Choose between 1 and 5000 Git paths.",
        ));
    }
    for path in &paths {
        files::validate_relative(path)?;
    }
    Ok(paths)
}

fn validate_message(message: String) -> Result<String, ApiError> {
    let message = message.trim();
    if message.is_empty()
        || message.len() > 4096
        || message
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\t'))
    {
        return Err(ApiError::bad_request(
            "Commit messages must contain 1 to 4096 safe characters.",
        ));
    }
    Ok(message.to_owned())
}

fn require_confirmation(confirm: bool) -> Result<(), ApiError> {
    if confirm {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "Remote Git operations require explicit confirmation.",
        ))
    }
}

fn parse_status(bytes: &[u8]) -> Result<Status, ApiError> {
    let records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .collect::<Vec<_>>();
    let mut status = Status {
        available: true,
        repository: true,
        branch: None,
        oid: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        clean: true,
        files: Vec::new(),
        message: None,
    };
    let mut index = 0;
    while index < records.len() {
        let record = std::str::from_utf8(records[index])
            .map_err(|_| ApiError::bad_request("Git reported a non-Unicode path."))?;
        if let Some(value) = record.strip_prefix("# branch.oid ") {
            if value != "(initial)" {
                status.oid = Some(value.into());
            }
        } else if let Some(value) = record.strip_prefix("# branch.head ") {
            status.branch = Some(value.into());
        } else if let Some(value) = record.strip_prefix("# branch.upstream ") {
            status.upstream = Some(value.into());
        } else if let Some(value) = record.strip_prefix("# branch.ab ") {
            let mut values = value.split_whitespace();
            status.ahead = values
                .next()
                .and_then(|value| value.strip_prefix('+'))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            status.behind = values
                .next()
                .and_then(|value| value.strip_prefix('-'))
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
        } else if let Some(path) = record.strip_prefix("? ") {
            status.files.push(file_status(path, None, "?", "?")?);
        } else if record.starts_with("1 ") {
            let fields = record.splitn(9, ' ').collect::<Vec<_>>();
            if fields.len() != 9 {
                return Err(ApiError::internal("Git returned malformed status output."));
            }
            let (index_status, worktree_status) = split_status(fields[1])?;
            status
                .files
                .push(file_status(fields[8], None, index_status, worktree_status)?);
        } else if record.starts_with("2 ") {
            let fields = record.splitn(10, ' ').collect::<Vec<_>>();
            if fields.len() != 10 || index + 1 >= records.len() {
                return Err(ApiError::internal("Git returned malformed rename output."));
            }
            index += 1;
            let original = std::str::from_utf8(records[index])
                .map_err(|_| ApiError::bad_request("Git reported a non-Unicode path."))?;
            let (index_status, worktree_status) = split_status(fields[1])?;
            status.files.push(file_status(
                fields[9],
                Some(original),
                index_status,
                worktree_status,
            )?);
        } else if record.starts_with("u ") {
            let fields = record.splitn(11, ' ').collect::<Vec<_>>();
            if fields.len() != 11 {
                return Err(ApiError::internal(
                    "Git returned malformed conflict output.",
                ));
            }
            let (index_status, worktree_status) = split_status(fields[1])?;
            status.files.push(file_status(
                fields[10],
                None,
                index_status,
                worktree_status,
            )?);
        }
        index += 1;
    }
    status.clean = status.files.is_empty();
    Ok(status)
}

fn split_status(value: &str) -> Result<(&str, &str), ApiError> {
    if value.len() == 2 && value.is_ascii() {
        Ok((&value[..1], &value[1..]))
    } else {
        Err(ApiError::internal("Git returned malformed status codes."))
    }
}

#[path = "git/identities.rs"]
mod identities;
use identities::{file_status, identified_status};

pub(super) async fn status(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
) -> Result<Json<Status>, ApiError> {
    blocking(state, work, move |state, _| {
        state.authorize(None, false)?;
        if let Some(access) = &state.access {
            access.git_read()?;
        }
        let show_untracked = state
            .web_preferences
            .read()
            .map_err(|_| ApiError::internal("The Web settings are unavailable."))?
            .git_show_untracked;
        identified_status(state, state.git.status(show_untracked)?)
    })
    .await
    .map(Json)
}

pub(super) async fn diff(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(query): Query<DiffQuery>,
) -> Result<Json<Diff>, ApiError> {
    blocking(state, work, move |state, _| {
        state.authorize(None, false)?;
        if let Some(access) = &state.access {
            access.git_read()?;
        }
        let resource = state.root.resource_store()?.resource(&query.id, true)?;
        state.git.diff(&resource.path, query.staged)
    })
    .await
    .map(Json)
}

pub(super) async fn action(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Action>, JsonRejection>,
) -> Result<Json<Status>, ApiError> {
    let Json(mut action) = body.map_err(json_error)?;
    blocking(state, work, move |state, _| {
        state.owner()?;
        let _saving = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The save lock is unavailable."))?;
        if matches!(action, Action::Pull { .. }) {
            state.collaboration.ensure_inactive("")?;
        }
        identities::resolve_action(state, &mut action)?;
        state.git.apply(action)?;
        let show_untracked = state
            .web_preferences
            .read()
            .map_err(|_| ApiError::internal("The Web settings are unavailable."))?
            .git_show_untracked;
        identified_status(state, state.git.status(show_untracked)?)
    })
    .await
    .map(Json)
}

pub(super) fn clone_repository(
    root: &std::path::Path,
    remote: &Remote,
    author: &str,
) -> Result<(), ApiError> {
    let service = Service::new(root.into());
    let output = process::run(
        root,
        [
            "clone",
            "--quiet",
            "--no-local",
            "--no-hardlinks",
            "--template=",
            "--",
            &remote.url,
            ".",
        ],
        true,
        Some(remote),
        true,
    )
    .map_err(|error| service.api_error(error))?;
    if !output.status.success() {
        return Err(service.api_error(RunError::Failed(output)));
    }
    for (key, value) in [
        ("user.name", author.to_owned()),
        ("user.email", format!("{author}@notes.invalid")),
    ] {
        let output = process::run(root, ["config", key, &value], true, Some(remote), false)
            .map_err(|error| service.api_error(error))?;
        if !output.status.success() {
            return Err(service.api_error(RunError::Failed(output)));
        }
    }
    Ok(())
}
