//! Loopback-only Markdown service owned by the native application.

#[path = "server/files.rs"]
mod files;
#[path = "server/markdown.rs"]
mod markdown;
#[path = "server/net.rs"]
mod net;

use std::future::IntoFuture;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock, mpsc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::appearance::Appearance;
use axum::Json;
use axum::Router;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{DefaultBodyLimit, Extension, Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde::{Deserialize, Serialize};
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
    img-src 'self'; connect-src 'self'; font-src 'self'; \
    object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const ASSET_CSP: &str = "default-src 'none'; script-src 'none'; object-src 'none'; \
    base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox";

/// An initialized, exclusively owned listener. Dropping it shuts down its runtime.
pub struct RunningServer {
    url: String,
    root: PathBuf,
    port: u16,
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

/// Starts a new IPv4 loopback service. Port zero requests an ephemeral port.
///
/// Startup does not succeed until the listener and runtime have initialized.
/// An occupied port is an error; no existing process is contacted or stopped.
pub fn start(root: &Path, port: u16) -> Result<RunningServer, String> {
    let root = Arc::new(files::Root::open(root).map_err(|error| error.message)?);
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port))
        .map_err(|error| format!("Could not listen on 127.0.0.1:{port}: {error}"))?;
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
    let origin = format!("http://127.0.0.1:{port}");
    let url = format!("{origin}/#token={token}");
    let health = Arc::new(Health::default());
    let appearance = Arc::new(RwLock::new(Appearance::default()));
    let state = Arc::new(AppState {
        root: root.clone(),
        port,
        host: format!("127.0.0.1:{port}"),
        origin,
        authorization: format!("Bearer {token}"),
        cookie_name: format!("notes_session_{port}"),
        token,
        style_nonce,
        content_policy,
        health: health.clone(),
        requests: Arc::new(Semaphore::new(8)),
        workers: Arc::new(Semaphore::new(2)),
        saves: Mutex::new(()),
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
    let result = runtime.block_on(async {
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|error| format!("Could not initialize the HTTP listener: {error}"))?;
        let listener = net::LimitedListener::new(listener);
        let (graceful_tx, graceful_rx) = oneshot::channel();
        let task = tokio::spawn(
            axum::serve(listener, router(state.clone()))
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

struct AppState {
    root: Arc<files::Root>,
    port: u16,
    host: String,
    origin: String,
    authorization: String,
    cookie_name: String,
    token: String,
    style_nonce: String,
    content_policy: HeaderValue,
    health: Arc<Health>,
    requests: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    saves: Mutex<()>,
    appearance: Arc<RwLock<Appearance>>,
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

fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/favicon.ico", get(app_icon))
        .route("/icon.svg", get(vector_icon))
        .route("/app.mjs", get(app_script))
        .route("/model.mjs", get(model_script))
        .route("/styles.css", get(styles))
        .route("/editor.bundle.mjs", get(editor_script))
        .route("/editor.bundle.css", get(editor_styles))
        .route("/editor-helpers.mjs", get(editor_helpers))
        .route("/THIRD-PARTY-LICENSES.txt", get(editor_licenses))
        .route("/api/session", post(session))
        .route("/api/appearance", get(appearance))
        .route("/api/tree", get(tree))
        .route(
            "/api/document",
            get(document).put(save_document).post(create_document),
        )
        .route("/api/preview", post(preview))
        .route("/assets", get(asset))
        .fallback(not_found)
        .method_not_allowed_fallback(method_not_allowed)
        .layer(DefaultBodyLimit::max(MAX_JSON_BYTES))
        .layer(middleware::from_fn_with_state(state.clone(), guard))
        .with_state(state)
}

async fn guard(State(state): State<Arc<AppState>>, mut request: Request, next: Next) -> Response {
    let asset_request = request.uri().path() == "/assets";
    let response = match check_request(&state, &request) {
        Err(error) => error.into_response(),
        Ok(()) => match state.requests.clone().try_acquire_owned() {
            Err(_) => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "The local server is busy. Please try again.",
            )
            .into_response(),
            Ok(_permit) => {
                let work = Arc::new(Work {
                    cancelled: AtomicBool::new(false),
                    deadline: Instant::now() + REQUEST_TIMEOUT,
                    health: state.health.clone(),
                });
                request.extensions_mut().insert(work.clone());
                let _cancel = CancelWork(work);
                match tokio::time::timeout(REQUEST_TIMEOUT, next.run(request)).await {
                    Ok(response) => response,
                    Err(_) => ApiError::new(StatusCode::REQUEST_TIMEOUT, "The request timed out.")
                        .into_response(),
                }
            }
        },
    };
    secure_headers(response, asset_request, &state.content_policy)
}

fn check_request(state: &AppState, request: &Request) -> Result<(), ApiError> {
    let headers = request.headers();
    if headers.get_all(header::HOST).iter().count() != 1
        || headers
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            != Some(state.host.as_str())
    {
        return Err(ApiError::forbidden(
            "The request Host is not this local server.",
        ));
    }
    if headers.get_all(header::ORIGIN).iter().count() > 1
        || headers
            .get(header::ORIGIN)
            .is_some_and(|value| value.to_str().ok() != Some(state.origin.as_str()))
    {
        return Err(ApiError::forbidden(
            "Cross-origin requests are not allowed.",
        ));
    }
    if request.uri().path().starts_with("/api/") {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("");
        if headers.get_all(header::AUTHORIZATION).iter().count() != 1
            || !secret_eq(authorization, &state.authorization)
        {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "Open the browser using this server's authenticated launch URL.",
            ));
        }
    }
    if request.uri().path() == "/assets" && !has_session_cookie(headers, state) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "An authenticated browser session is required for attachments.",
        ));
    }
    if headers
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .is_some_and(|size| size > MAX_JSON_BYTES as u64)
    {
        return Err(ApiError::too_large("The request body is too large."));
    }
    Ok(())
}

fn secret_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn has_session_cookie(headers: &HeaderMap, state: &AppState) -> bool {
    let mut matches = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .filter(|(name, _)| *name == state.cookie_name);
    matches
        .next()
        .is_some_and(|(_, value)| secret_eq(value, &state.token))
        && matches.next().is_none()
}

fn secure_headers(mut response: Response, asset: bool, content_policy: &HeaderValue) -> Response {
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        if asset {
            HeaderValue::from_static(ASSET_CSP)
        } else {
            content_policy.clone()
        },
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("same-origin"),
    );
    response
}

async fn index(State(state): State<Arc<AppState>>) -> Response {
    let page = include_str!("../../../web/public/index.html")
        .replace("__STYLE_NONCE__", &state.style_nonce);
    ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], page).into_response()
}

async fn app_script() -> Response {
    embedded(
        "text/javascript; charset=utf-8",
        include_bytes!("../../../web/public/app.mjs"),
    )
}

async fn model_script() -> Response {
    embedded(
        "text/javascript; charset=utf-8",
        include_bytes!("../../../web/public/model.mjs"),
    )
}

async fn styles() -> Response {
    embedded(
        "text/css; charset=utf-8",
        include_bytes!("../../../web/public/styles.css"),
    )
}

async fn editor_script() -> Response {
    embedded(
        "text/javascript; charset=utf-8",
        include_bytes!("../../../web/public/editor.bundle.mjs"),
    )
}

async fn editor_styles() -> Response {
    embedded(
        "text/css; charset=utf-8",
        include_bytes!("../../../web/public/editor.bundle.css"),
    )
}

async fn editor_helpers() -> Response {
    embedded(
        "text/javascript; charset=utf-8",
        include_bytes!("../../../web/public/editor-helpers.mjs"),
    )
}

async fn editor_licenses() -> Response {
    embedded(
        "text/plain; charset=utf-8",
        include_bytes!("../../../web/public/THIRD-PARTY-LICENSES.txt"),
    )
}

async fn app_icon() -> Response {
    embedded(
        "image/x-icon",
        include_bytes!("../../../Shared/Resources/Notes.ico"),
    )
}

async fn vector_icon() -> Response {
    embedded(
        "image/svg+xml",
        include_bytes!("../../../Shared/Resources/NotesIcon.svg"),
    )
}

fn embedded(content_type: &'static str, bytes: &'static [u8]) -> Response {
    ([(header::CONTENT_TYPE, content_type)], bytes).into_response()
}

#[derive(Serialize)]
struct Session {
    root: String,
    port: u16,
}

async fn session(State(state): State<Arc<AppState>>) -> Response {
    let mut response = Json(Session {
        root: state.root.path().to_string_lossy().into_owned(),
        port: state.port,
    })
    .into_response();
    let cookie = format!(
        "{}={}; Path=/assets; HttpOnly; SameSite=Strict",
        state.cookie_name, state.token
    );
    match HeaderValue::from_str(&cookie) {
        Ok(cookie) => {
            response.headers_mut().insert(header::SET_COOKIE, cookie);
            response
        }
        Err(_) => ApiError::internal("Could not establish the browser session.").into_response(),
    }
}

async fn tree(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
) -> Result<Json<files::Tree>, ApiError> {
    blocking(state, work, |state, _| state.root.tree())
        .await
        .map(Json)
}

async fn appearance(State(state): State<Arc<AppState>>) -> Result<Json<Appearance>, ApiError> {
    state
        .appearance
        .read()
        .map(|appearance| Json(appearance.clone()))
        .map_err(|_| ApiError::internal("The appearance settings are unavailable."))
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

async fn document(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    query: Result<Query<PathQuery>, QueryRejection>,
) -> Result<Json<files::Document>, ApiError> {
    let Query(query) = query.map_err(query_error)?;
    blocking(state, work, move |state, _| {
        state.root.document(&query.path)
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SaveDocument {
    path: String,
    content: String,
    version: String,
}

async fn save_document(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<SaveDocument>, JsonRejection>,
) -> Result<Json<files::Document>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The document save lock was poisoned."))?;
        state
            .root
            .save(&body.path, &body.content, &body.version, || work.check())
    })
    .await
    .map(Json)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NewDocument {
    path: String,
    content: String,
}

async fn create_document(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<NewDocument>, JsonRejection>,
) -> Result<(StatusCode, Json<files::Document>), ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |state, work| {
        let _save = state
            .saves
            .lock()
            .map_err(|_| ApiError::internal("The document save lock was poisoned."))?;
        state
            .root
            .create(&body.path, &body.content, || work.check())
    })
    .await
    .map(|document| (StatusCode::CREATED, Json(document)))
}

#[derive(Serialize)]
struct Preview {
    html: String,
}

async fn preview(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    body: Result<Json<NewDocument>, JsonRejection>,
) -> Result<Json<Preview>, ApiError> {
    let Json(body) = body.map_err(json_error)?;
    blocking(state, work, move |_, _| {
        files::validate_document_path(&body.path)?;
        files::validate_content(body.content.as_bytes())?;
        Ok(Preview {
            html: markdown::render(
                &body.path,
                body.content
                    .strip_prefix('\u{feff}')
                    .unwrap_or(&body.content),
            ),
        })
    })
    .await
    .map(Json)
}

async fn asset(
    State(state): State<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    query: Result<Query<PathQuery>, QueryRejection>,
) -> Result<Response, ApiError> {
    let Query(query) = query.map_err(query_error)?;
    let asset = blocking(state, work, move |state, _| state.root.asset(&query.path)).await?;
    let mut response = ([(header::CONTENT_TYPE, asset.mime)], asset.bytes).into_response();
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static(if asset.download {
            "attachment"
        } else {
            "inline"
        }),
    );
    Ok(response)
}

async fn blocking<T, F>(state: Arc<AppState>, work: Arc<Work>, operation: F) -> Result<T, ApiError>
where
    T: Send + 'static,
    F: FnOnce(&AppState, &Work) -> Result<T, ApiError> + Send + 'static,
{
    let permit = state.workers.clone().try_acquire_owned().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "The document worker is busy. Please try again.",
        )
    })?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work.check()?;
        let result = operation(&state, &work)?;
        work.check()?;
        Ok(result)
    })
    .await
    .map_err(|error| ApiError::internal(format!("The document worker failed: {error}")))?
}

fn json_error(error: JsonRejection) -> ApiError {
    if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
        ApiError::too_large("The request body is too large.")
    } else {
        ApiError::bad_request(format!("Invalid JSON request: {}", error.body_text()))
    }
}

fn query_error(error: QueryRejection) -> ApiError {
    ApiError::bad_request(format!(
        "Invalid document path query: {}",
        error.body_text()
    ))
}

async fn not_found() -> ApiError {
    ApiError::new(StatusCode::NOT_FOUND, "This endpoint does not exist.")
}

async fn method_not_allowed() -> ApiError {
    ApiError::new(
        StatusCode::METHOD_NOT_ALLOWED,
        "This HTTP method is not allowed.",
    )
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
