//! Markdown service shared by native applications and the authenticated CLI.

#[path = "server/accounts.rs"]
mod accounts;
#[path = "server/attachments.rs"]
mod attachments;
#[path = "server/authentication.rs"]
mod authentication;
#[path = "server/collaboration.rs"]
mod collaboration;
#[path = "server/files.rs"]
mod files;
#[path = "server/frontmatter.rs"]
mod frontmatter;
#[path = "server/git.rs"]
mod git;
#[path = "server/history.rs"]
mod history;
#[path = "server/images.rs"]
mod images;
#[path = "server/links.rs"]
mod links;
#[path = "server/listen.rs"]
mod listen;
#[path = "server/markdown.rs"]
mod markdown;
#[path = "server/net.rs"]
mod net;
#[path = "server/permissions.rs"]
mod permissions;
#[path = "server/preferences.rs"]
mod preferences;
#[path = "server/previews.rs"]
mod previews;
#[path = "server/projects.rs"]
mod projects;
#[path = "server/refactor.rs"]
mod refactor;
#[path = "server/resources.rs"]
mod resources;
#[path = "server/routes.rs"]
mod routes;
#[path = "server/search.rs"]
mod search;
#[path = "server/security.rs"]
mod security;
#[path = "server/state_store.rs"]
mod state_store;
#[path = "server/workspaces.rs"]
mod workspaces;

pub use listen::{
    start, start_on, start_with_users, start_with_users_on, start_with_users_on_hosts,
};
pub use security::AllowedHostname;

use std::future::IntoFuture;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::{
    appearance::Appearance,
    auth::AuthService,
    settings::{SettingsStore, WebPreferences},
};
use axum::Json;
use axum::http::{HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use tokio::runtime::Builder;
use tokio::sync::{Semaphore, oneshot};

const MAX_DOCUMENT_BYTES: usize = 4 * 1024 * 1024;
// A JSON string can expand each source byte to a six-byte escape.
const MAX_JSON_BYTES: usize = MAX_DOCUMENT_BYTES * 6 + 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const GRACEFUL_TIMEOUT: Duration = Duration::from_millis(250);
const RUNTIME_TIMEOUT: Duration = Duration::from_millis(350);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'nonce-__STYLE_NONCE__'; style-src-attr 'unsafe-inline'; \
    img-src 'self'; connect-src 'self'; font-src 'self' data:; \
    object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ASSET_CSP: &str = "default-src 'none'; script-src 'none'; object-src 'none'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

/// An initialized, exclusively owned listener. Dropping it shuts down its runtime.
pub struct RunningServer {
    url: String,
    root: PathBuf,
    port: u16,
    host: Ipv4Addr,
    health: Arc<Health>,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    finished: mpsc::Receiver<()>,
    appearance: Arc<RwLock<Appearance>>,
}

#[derive(Default)]
struct Health {
    running: AtomicBool,
    stopping: AtomicBool,
    failure: Mutex<Option<String>>,
}

impl Health {
    fn fail(&self, message: String) {
        if let Ok(mut failure) = self.failure.lock() {
            if failure.is_none() {
                *failure = Some(message);
            }
        }
        self.running.store(false, Ordering::Release);
    }

    fn result(&self) -> Result<(), String> {
        match self.failure.lock() {
            Ok(failure) => failure.clone().map_or(Ok(()), Err),
            Err(_) => Err("The HTTP server's status lock was poisoned.".into()),
        }
    }
}

impl RunningServer {
    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn host(&self) -> Ipv4Addr {
        self.host
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn is_running(&self) -> bool {
        self.health.running.load(Ordering::Acquire) && !self.health.stopping.load(Ordering::Acquire)
    }

    pub fn set_appearance(&self, appearance: Appearance) -> Result<(), String> {
        appearance.validate()?;
        *self
            .appearance
            .write()
            .map_err(|_| "The appearance settings lock was poisoned.")? = appearance;
        Ok(())
    }

    /// Stops only this instance, including incomplete HTTP connections.
    pub fn stop(&mut self) -> Result<(), String> {
        self.health.stopping.store(true, Ordering::Release);
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(handle) = self.thread.as_ref() {
            if !handle.is_finished()
                && matches!(
                    self.finished.recv_timeout(STOP_TIMEOUT),
                    Err(mpsc::RecvTimeoutError::Timeout)
                )
            {
                return Err("The HTTP server did not stop within two seconds.".into());
            }
        }
        if let Some(handle) = self.thread.take() {
            if handle.join().is_err() {
                self.health.fail("The HTTP server thread panicked.".into());
            }
        }
        self.health.result()
    }
}

impl Drop for RunningServer {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("Could not stop the Notes HTTP server: {error}");
        }
    }
}

fn start_configured(
    root: &Path,
    host: Ipv4Addr,
    port: u16,
    user_auth: Option<Arc<AuthService>>,
    settings_store: Option<SettingsStore>,
    allowed_hosts: &[AllowedHostname],
) -> Result<RunningServer, String> {
    let root = Arc::new(files::Root::open(root).map_err(|error| error.message)?);
    let listener = TcpListener::bind(SocketAddrV4::new(host, port))
        .map_err(|error| format!("Could not listen on {host}:{port}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Could not configure the HTTP listener: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Could not read the listener address: {error}"))?
        .port();
    let mut random = [0_u8; 32];
    getrandom::fill(&mut random)
        .map_err(|error| format!("Could not generate a secure session token: {error}"))?;
    let token = hex(&random);
    let mut style_random = [0_u8; 16];
    getrandom::fill(&mut style_random)
        .map_err(|error| format!("Could not generate an editor style nonce: {error}"))?;
    let style_nonce = hex(&style_random);
    let content_policy = HeaderValue::from_str(&CSP.replace("__STYLE_NONCE__", &style_nonce))
        .map_err(|error| format!("Could not configure the editor content policy: {error}"))?;
    let browser_host = if host.is_unspecified() {
        Ipv4Addr::LOCALHOST
    } else {
        host
    };
    let origin = format!("http://{browser_host}:{port}");
    let url = if user_auth.is_some() {
        format!("{origin}/")
    } else {
        format!("{origin}/#token={token}")
    };
    let health = Arc::new(Health::default());
    let settings = settings_store
        .as_ref()
        .map(SettingsStore::load)
        .transpose()?
        .flatten()
        .unwrap_or_default();
    let appearance = Arc::new(RwLock::new(settings.appearance));
    let web_preferences = Arc::new(RwLock::new(settings.web));
    let projects = user_auth
        .as_ref()
        .map(|auth| projects::Registry::open(root.clone(), auth.user_store()).map(Arc::new))
        .transpose()?;
    if projects.is_none() {
        root.attach_resources(
            state_store::Store::temporary()
                .map_err(|error| error.message)?
                .project("local"),
        )
        .map_err(|error| error.message)?;
    }
    let state = Arc::new(AppState {
        library: Arc::new(Library::new(root.clone())),
        projects,
        access: None,
        port,
        host,
        allowed_hosts: allowed_hosts.into(),
        authorization: format!("Bearer {token}"),
        cookie_name: format!("notes_session_{port}"),
        user_cookie_name: user_auth
            .as_ref()
            .map(|auth| auth.cookie_name().to_owned())
            .unwrap_or_else(|| "notes_user_session".into()),
        user_auth,
        token,
        style_nonce,
        content_policy,
        health: health.clone(),
        requests: Arc::new(Semaphore::new(8)),
        workers: Arc::new(Semaphore::new(2)),
        settings_store,
        settings_update: Arc::new(Mutex::new(())),
        web_preferences,
        appearance: appearance.clone(),
    });
    let thread_health = health.clone();
    let (shutdown, shutdown_rx) = oneshot::channel();
    let (initialized_tx, initialized_rx) = mpsc::sync_channel(1);
    let (finished_tx, finished) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("notes-http".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                serve(
                    listener,
                    state,
                    shutdown_rx,
                    &initialized_tx,
                    &thread_health,
                )
            }));
            match result {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    let _ = initialized_tx.try_send(Err(error.clone()));
                    thread_health.fail(error);
                }
                Err(_) => {
                    let error = "The HTTP server thread panicked.".to_owned();
                    let _ = initialized_tx.try_send(Err(error.clone()));
                    thread_health.fail(error);
                }
            }
            thread_health.running.store(false, Ordering::Release);
            let _ = finished_tx.send(());
        })
        .map_err(|error| format!("Could not create the HTTP server thread: {error}"))?;
    let mut server = RunningServer {
        url,
        root: root.path().to_owned(),
        port,
        host,
        health,
        shutdown: Some(shutdown),
        thread: Some(thread),
        finished,
        appearance,
    };
    match initialized_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(server),
        Ok(Err(error)) => {
            let _ = server.stop();
            Err(error)
        }
        Err(_) => {
            let _ = server.stop();
            Err("The HTTP server did not finish initializing.".into())
        }
    }
}

fn serve(
    listener: TcpListener,
    state: Arc<AppState>,
    shutdown: oneshot::Receiver<()>,
    initialized: &mpsc::SyncSender<Result<(), String>>,
    health: &Arc<Health>,
) -> Result<(), String> {
    let runtime = Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(2)
        .thread_name("notes-http-worker")
        .enable_all()
        .build()
        .map_err(|error| format!("Could not create the HTTP runtime: {error}"))?;
    let git_sync = state
        .projects
        .as_ref()
        .map(|registry| projects::sync::start(registry.clone(), health.clone()))
        .transpose()?;
    let result = runtime.block_on(async {
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|error| format!("Could not initialize the HTTP listener: {error}"))?;
        let listener = net::LimitedListener::new(listener);
        let (graceful_tx, graceful_rx) = oneshot::channel();
        let task = tokio::spawn(
            axum::serve(
                listener,
                routes::router(state.clone())
                    .into_make_service_with_connect_info::<net::ConnectionInfo>(),
            )
            .with_graceful_shutdown(async move {
                let _ = graceful_rx.await;
            })
            .into_future(),
        );
        let abort = task.abort_handle();
        let stopping = health.clone();
        tokio::spawn(async move {
            let _ = shutdown.await;
            stopping.stopping.store(true, Ordering::Release);
            let _ = graceful_tx.send(());
            tokio::time::sleep(GRACEFUL_TIMEOUT).await;
            abort.abort();
        });
        health.running.store(true, Ordering::Release);
        let _ = initialized.send(Ok(()));
        match task.await {
            Ok(Ok(())) if health.stopping.load(Ordering::Acquire) => Ok(()),
            Err(error) if error.is_cancelled() && health.stopping.load(Ordering::Acquire) => Ok(()),
            Ok(Ok(())) => Err("The HTTP server stopped unexpectedly.".into()),
            Ok(Err(error)) => Err(format!("The HTTP listener failed: {error}")),
            Err(error) => Err(format!("The HTTP server task failed: {error}")),
        }
    });
    health.running.store(false, Ordering::Release);
    health.stopping.store(true, Ordering::Release);
    if let Some(worker) = git_sync {
        if worker.join().is_err() {
            return Err("Automatic Git sync worker failed.".into());
        }
    }
    runtime.shutdown_timeout(RUNTIME_TIMEOUT);
    if state.workers.available_permits() != 2 {
        Err(
            "A filesystem operation did not finish before shutdown; pending saves were cancelled."
                .into(),
        )
    } else {
        result
    }
}

struct Library {
    collaboration: collaboration::Hub,
    root: Arc<files::Root>,
    git: git::Service,
    saves: Mutex<()>,
    preview_cache: Mutex<previews::Cache>,
    store: Option<state_store::ProjectStore>,
    index_state: Mutex<search::IndexState>,
    index_dirty: AtomicBool,
}

impl Library {
    fn new(root: Arc<files::Root>) -> Self {
        Self {
            git: git::Service::new(root.path().to_owned()),
            root,
            collaboration: collaboration::Hub::default(),
            saves: Mutex::new(()),
            preview_cache: Mutex::new(previews::Cache::default()),
            store: None,
            index_state: Mutex::new(search::IndexState::default()),
            index_dirty: AtomicBool::new(true),
        }
    }
}

#[derive(Clone)]
struct AppState {
    library: Arc<Library>,
    projects: Option<Arc<projects::Registry>>,
    access: Option<projects::Access>,
    port: u16,
    host: Ipv4Addr,
    allowed_hosts: Arc<[AllowedHostname]>,
    authorization: String,
    cookie_name: String,
    user_cookie_name: String,
    user_auth: Option<Arc<AuthService>>,
    token: String,
    style_nonce: String,
    content_policy: HeaderValue,
    health: Arc<Health>,
    requests: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    settings_store: Option<SettingsStore>,
    settings_update: Arc<Mutex<()>>,
    web_preferences: Arc<RwLock<WebPreferences>>,
    appearance: Arc<RwLock<Appearance>>,
}

impl std::ops::Deref for AppState {
    type Target = Library;
    fn deref(&self) -> &Library {
        &self.library
    }
}

impl AppState {
    fn authorize(&self, path: Option<&str>, write: bool) -> Result<(), ApiError> {
        match &self.access {
            Some(access) => access.check(path, write),
            None if self.user_auth.is_none() => Ok(()),
            None => Err(ApiError::forbidden("Select an accessible project first.")),
        }
    }

    fn owner(&self) -> Result<(), ApiError> {
        match &self.access {
            Some(access) => access.owner(),
            None => self.authorize(None, true),
        }
    }
}
struct Work {
    cancelled: AtomicBool,
    deadline: Instant,
    health: Arc<Health>,
}

impl Work {
    fn check(&self) -> Result<(), ApiError> {
        if self.health.stopping.load(Ordering::Acquire) {
            Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "The local server is stopping.",
            ))
        } else if self.cancelled.load(Ordering::Acquire) || Instant::now() >= self.deadline {
            Err(ApiError::new(
                StatusCode::REQUEST_TIMEOUT,
                "The request was cancelled or timed out.",
            ))
        } else {
            Ok(())
        }
    }
}

struct CancelWork(Arc<Work>);

impl Drop for CancelWork {
    fn drop(&mut self) {
        self.0.cancelled.store(true, Ordering::Release);
    }
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message)
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message)
    }

    fn too_large(message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, message)
    }

    fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }

    fn io(context: &str, error: std::io::Error) -> Self {
        let status = match error.kind() {
            std::io::ErrorKind::NotFound => StatusCode::NOT_FOUND,
            std::io::ErrorKind::PermissionDenied => StatusCode::FORBIDDEN,
            std::io::ErrorKind::AlreadyExists => StatusCode::CONFLICT,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self::new(status, format!("{context}: {error}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        #[derive(Serialize)]
        struct ErrorBody {
            error: String,
        }
        (
            self.status,
            Json(ErrorBody {
                error: self.message,
            }),
        )
            .into_response()
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(result, "{byte:02x}");
    }
    result
}
