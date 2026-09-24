use super::{Access, Registry};
use crate::server::{
    ApiError, AppState, Health, Work,
    git::sync::Target,
    routes::{blocking, json_error},
};
use axum::{
    Json,
    extract::{Extension, rejection::JsonRejection},
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    sync::{Arc, atomic::Ordering},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Config {
    enabled: bool,
    interval_minutes: u32,
    target: Option<Target>,
    #[serde(default)]
    revision: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_minutes: 30,
            target: None,
            revision: 0,
        }
    }
}

impl Config {
    pub(super) fn validate(&self) -> Result<(), ApiError> {
        if !(1..=1440).contains(&self.interval_minutes) || self.enabled && self.target.is_none() {
            return Err(ApiError::bad_request(
                "Automatic Git sync requires an interval of 1-1440 minutes and an approved upstream.",
            ));
        }
        Ok(())
    }
    fn interval(&self) -> Duration {
        Duration::from_secs(u64::from(self.interval_minutes) * 60)
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    running: bool,
    next_run_at: Option<u64>,
    last_run_at: Option<u64>,
    last_success_at: Option<u64>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct View {
    enabled: bool,
    interval_minutes: u32,
    branch: Option<String>,
    upstream: Option<String>,
    #[serde(flatten)]
    status: Status,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(in crate::server) struct Settings {
    enabled: bool,
    interval_minutes: u32,
    #[serde(default)]
    confirm: bool,
}

impl Access {
    fn git_sync_view(&self) -> Result<View, ApiError> {
        self.owner()?;
        let project = self.project()?;
        let status = self
            .registry
            .sync_status
            .lock()
            .map_err(|_| ApiError::internal("Automatic Git sync status is unavailable."))?
            .get(&self.id)
            .cloned()
            .unwrap_or_default();
        Ok(View {
            enabled: project.git_sync.enabled,
            interval_minutes: project.git_sync.interval_minutes,
            branch: project
                .git_sync
                .target
                .as_ref()
                .map(|target| target.branch.trim_start_matches("refs/heads/").into()),
            upstream: project.git_sync.target.as_ref().map(|target| {
                format!(
                    "{}/{}",
                    target.remote,
                    target.merge.trim_start_matches("refs/heads/")
                )
            }),
            status,
        })
    }

    fn configure_git_sync(&self, settings: Settings, work: &Work) -> Result<View, ApiError> {
        self.owner()?;
        let mut config = Config {
            enabled: settings.enabled,
            interval_minutes: settings.interval_minutes,
            target: None,
            revision: 0,
        };
        if !(1..=1440).contains(&config.interval_minutes) {
            return Err(ApiError::bad_request(
                "Choose an interval from 1 to 1440 minutes.",
            ));
        }
        if settings.enabled {
            if !settings.confirm {
                return Err(ApiError::bad_request(
                    "Confirm automatic staging, committing and pushing before enabling it.",
                ));
            }
            config.target = Some(
                self.library
                    .git
                    .sync_target(&|| work.check().map_err(|error| error.message))?,
            );
        }
        config.validate()?;
        self.registry.mutate(|catalog| {
            let project = catalog
                .projects
                .get_mut(&self.id)
                .filter(|project| project.owned(&self.identity))
                .ok_or_else(|| {
                    ApiError::forbidden("Only the project owner can change automatic Git sync.")
                })?;
            config.revision = project.git_sync.revision.checked_add(1).ok_or_else(|| {
                ApiError::internal("Automatic Git sync configuration revision is exhausted.")
            })?;
            project.git_sync = config;
            Ok(())
        })?;
        self.registry.sync_status_update(&self.id, |status| {
            status.error = None;
            status.next_run_at = None;
        })?;
        self.git_sync_view()
    }
}

pub(in crate::server) async fn get(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
) -> Result<Json<View>, ApiError> {
    blocking(state, work, |state, _| access(state)?.git_sync_view())
        .await
        .map(Json)
}

pub(in crate::server) async fn update(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<Settings>, JsonRejection>,
) -> Result<Json<View>, ApiError> {
    let Json(settings) = body.map_err(json_error)?;
    blocking(state, work, |state, work| {
        access(state)?.configure_git_sync(settings, work)
    })
    .await
    .map(Json)
}

fn access(state: &AppState) -> Result<&Access, ApiError> {
    state
        .access
        .as_ref()
        .ok_or_else(|| ApiError::forbidden("Automatic Git sync requires an account-owned project."))
}

struct Schedule {
    config: Config,
    next: Instant,
    _lease: File,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time after epoch")
        .as_secs()
}

impl Registry {
    fn sync_status_update(
        &self,
        id: &str,
        update: impl FnOnce(&mut Status),
    ) -> Result<(), ApiError> {
        let mut statuses = self
            .sync_status
            .lock()
            .map_err(|_| ApiError::internal("Automatic Git sync status is unavailable."))?;
        update(statuses.entry(id.into()).or_default());
        Ok(())
    }

    fn sync_permitted(&self, id: &str, expected: &Config, health: &Health) -> Result<(), String> {
        if health.stopping.load(Ordering::Acquire) {
            return Err("Automatic Git sync stopped with the service.".into());
        }
        let catalog = self.catalog().map_err(|error| error.message)?;
        let project = catalog
            .projects
            .get(id)
            .filter(|project| project.git_sync == *expected && project.git_sync.enabled)
            .ok_or("Automatic Git sync was disabled or reconfigured.")?;
        let owner = project
            .owner
            .as_deref()
            .ok_or("The project has no owner.")?;
        if Some(self.users.account_id(owner)?) != project.owner_id {
            return Err("The project owner account no longer exists.".into());
        }
        Ok(())
    }

    fn sync_tick(
        &self,
        schedules: &mut HashMap<String, Schedule>,
        health: &Health,
    ) -> Result<(), ApiError> {
        let Some(catalog) = self.load()? else {
            return Ok(());
        };
        schedules.retain(|id, schedule| {
            catalog.projects.get(id).is_some_and(|project| {
                project.git_sync.enabled && project.git_sync == schedule.config
            })
        });
        for (id, project) in &catalog.projects {
            if health.stopping.load(Ordering::Acquire) {
                break;
            }
            if !project.git_sync.enabled {
                self.sync_status_update(id, |status| {
                    status.next_run_at = None;
                    status.running = false;
                })?;
                continue;
            }
            if !schedules.contains_key(id) {
                let waiting = self
                    .sync_status
                    .lock()
                    .map_err(|_| ApiError::internal("Automatic Git sync status is unavailable."))?
                    .get(id)
                    .is_some_and(|status| {
                        status.error.is_some()
                            && status.next_run_at.is_some_and(|next| next > now())
                    });
                if waiting {
                    continue;
                }
                let prepared = (|| {
                    self.sync_permitted(id, &project.git_sync, health)
                        .map_err(ApiError::forbidden)?;
                    let library = self.library(id, project)?;
                    let mut options = OpenOptions::new();
                    options.read(true).write(true).create(true).truncate(false);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::OpenOptionsExt;
                        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
                    }
                    let lease = options
                        .open(library.git.sync_lock_path()?)
                        .map_err(|error| {
                            ApiError::io("Could not open automatic Git sync lock", error)
                        })?;
                    lease.try_lock_exclusive().map_err(|error| {
                        ApiError::io(
                            "Another service owns automatic Git sync, or its lock is unavailable",
                            error,
                        )
                    })?;
                    Ok::<_, ApiError>(Schedule {
                        config: project.git_sync.clone(),
                        next: Instant::now() + project.git_sync.interval(),
                        _lease: lease,
                    })
                })();
                match prepared {
                    Ok(schedule) => {
                        self.sync_status_update(id, |status| {
                            status.error = None;
                            status.next_run_at = Some(now() + schedule.config.interval().as_secs());
                        })?;
                        schedules.insert(id.clone(), schedule);
                    }
                    Err(error) => {
                        self.sync_status_update(id, |status| {
                            status.error = Some(error.message);
                            status.next_run_at = Some(now() + 30);
                        })?;
                    }
                }
                continue;
            }
            let schedule = schedules.get_mut(id).expect("schedule was inserted");
            if Instant::now() < schedule.next {
                continue;
            }
            self.sync_status_update(id, |status| {
                status.running = true;
                status.last_run_at = Some(now());
                status.next_run_at = None;
            })?;
            let result = (|| {
                self.sync_permitted(id, &schedule.config, health)
                    .map_err(ApiError::forbidden)?;
                let library = self.library(id, project)?;
                let target = schedule.config.target.as_ref().ok_or_else(|| {
                    ApiError::bad_request("Automatic Git sync has no approved target.")
                })?;
                library.git.automatic_sync(&library.saves, target, &|| {
                    self.sync_permitted(id, &schedule.config, health)
                })
            })();
            schedule.next = Instant::now() + schedule.config.interval();
            self.sync_status_update(id, |status| {
                status.running = false;
                status.next_run_at = Some(now() + schedule.config.interval().as_secs());
                match result {
                    Ok(()) => { status.last_success_at = Some(now()); status.error = None; }
                    Err(error) => {
                        eprintln!("Automatic Git sync failed for project {id}; details are available to its owner in Settings.");
                        status.error = Some(error.message);
                    }
                }
            })?;
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "sync_tests.rs"]
mod tests;

pub(in crate::server) fn start(
    registry: Arc<Registry>,
    health: Arc<Health>,
) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("notes-git-sync".into())
        .spawn(move || {
            let mut schedules = HashMap::new();
            while !health.stopping.load(Ordering::Acquire) {
                if let Err(error) = registry.sync_tick(&mut schedules, &health) {
                    eprintln!("Automatic Git sync scheduler failed: {}", error.message);
                }
                for _ in 0..10 {
                    if health.stopping.load(Ordering::Acquire) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
            }
        })
        .map_err(|error| format!("Could not start automatic Git sync: {error}"))
}
