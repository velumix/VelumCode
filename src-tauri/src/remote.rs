//! Tailscale HTTPS and authorized USB forwarding use separate loopback listeners.
//! HTTP clients have a deliberately small API and never receive Tauri IPC access.
use crate::{
    remote_auth::{self, Auth, Device, Pending, Saved},
    runner,
    session_log::SessionLog,
    tailscale, usb,
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{
        sse::{Event, KeepAlive},
        IntoResponse, Response, Sse,
    },
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{oneshot, watch};

const COOKIE: &str = "__Host-muse";
const USB_COOKIE: &str = "muse-usb";

struct UsbLink {
    device: usb::Device,
    _stop: oneshot::Sender<()>,
}

struct Inner {
    auth: Auth,
    origin: Option<String>,
    server: Option<oneshot::Sender<()>>,
    serve: Option<tokio::process::Child>,
    tailscale: tailscale::Status,
    error: Option<String>,
    usb: Option<UsbLink>,
}

pub struct Core {
    inner: Mutex<Inner>,
    changes: watch::Sender<u64>,
    operation: tokio::sync::Mutex<()>,
    path: PathBuf,
}
pub struct RemoteState(Arc<Core>);

#[derive(Clone)]
struct WebState {
    core: Arc<Core>,
    app: Option<AppHandle>,
    usb: bool,
}

impl WebState {
    fn origin(&self, inner: &Inner) -> Option<String> {
        if self.usb {
            inner.usb.as_ref().map(|_| usb::ORIGIN.into())
        } else {
            inner.origin.clone()
        }
    }
    fn cookie(&self, token: &str, age: u64) -> String {
        let (name, secure) = if self.usb {
            (USB_COOKIE, "")
        } else {
            (COOKIE, " Secure;")
        };
        format!("{name}={token}; Path=/; HttpOnly;{secure} SameSite=Strict; Max-Age={age}")
    }
}

#[derive(Clone, Serialize)]
pub struct Status {
    enabled: bool,
    url: Option<String>,
    tailscale: tailscale::Status,
    devices: Vec<Device>,
    pending: Option<Pending>,
    error: Option<String>,
    usb: Option<usb::Device>,
}

type ApiResult = Result<Json<Value>, ApiError>;
struct ApiError(StatusCode, String);
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"error": self.1}))).into_response()
    }
}
fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}
fn unauthorized() -> ApiError {
    ApiError(
        StatusCode::UNAUTHORIZED,
        "Pair this phone with VelumCode on your desktop.".into(),
    )
}

fn status(core: &Core) -> Status {
    let inner = core.inner.lock().unwrap();
    Status {
        enabled: inner.origin.is_some(),
        url: inner.origin.clone(),
        tailscale: inner.tailscale.clone(),
        devices: inner
            .auth
            .saved
            .devices
            .iter()
            .filter(|d| d.expires_at > remote_auth::now())
            .map(Device::public)
            .collect(),
        pending: inner.auth.pending(remote_auth::now()),
        error: inner.error.clone(),
        usb: inner.usb.as_ref().map(|link| link.device.clone()),
    }
}

impl Core {
    fn persist(&self, saved: &Saved) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or("Remote settings directory is unavailable.")?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        let temporary = self.path.with_extension("json.tmp");
        std::fs::write(
            &temporary,
            serde_json::to_vec_pretty(saved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(temporary, &self.path).map_err(|e| e.to_string())
    }
    fn notify(&self) {
        self.changes.send_modify(|n| *n = n.wrapping_add(1));
    }
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config = std::env::var_os("MUSE_CODE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(app.path().app_config_dir()?);
    let path = config.join("remote.json");
    let saved: Saved = std::fs::read(&path)
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    let resume = saved.enabled;
    let (changes, _) = watch::channel(0);
    let core = Arc::new(Core {
        inner: Mutex::new(Inner {
            auth: Auth::new(saved),
            origin: None,
            server: None,
            serve: None,
            tailscale: tailscale::Status::default(),
            error: None,
            usb: None,
        }),
        changes,
        operation: tokio::sync::Mutex::new(()),
        path,
    });
    app.manage(RemoteState(core));
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        if resume {
            let _ = remote_enable(handle.clone(), true).await;
        } else {
            let _ = remote_check_tailscale(handle.clone()).await;
        }
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            if handle
                .state::<crate::desktop::DesktopState>()
                .quitting
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            let core = &handle.state::<RemoteState>().0;
            let stopped = core
                .inner
                .lock()
                .unwrap()
                .serve
                .as_mut()
                .is_some_and(|child| child.try_wait().map_or(true, |exit| exit.is_some()));
            if stopped {
                shutdown_tailscale(&handle);
                core.inner.lock().unwrap().error = Some("Tailscale disconnected. Check its connection, then enable remote access again.".into());
                let _ = remote_check_tailscale(handle.clone()).await;
            }
        }
    });
    Ok(())
}

pub fn changed(app: &AppHandle) {
    if let Some(state) = app.try_state::<RemoteState>() {
        state.0.notify();
    }
}
fn publish(app: &AppHandle, core: &Core) {
    core.notify();
    let _ = app.emit("remote-status", status(core));
}

fn shutdown_tailscale(app: &AppHandle) {
    if let Some(state) = app.try_state::<RemoteState>() {
        let mut inner = state.0.inner.lock().unwrap();
        inner.origin = None;
        if inner.auth.pairing.as_ref().is_some_and(|pair| !pair.usb) {
            inner.auth.pairing = None;
        }
        if let Some(server) = inner.server.take() {
            let _ = server.send(());
        }
        if let Some(mut child) = inner.serve.take() {
            let _ = child.start_kill();
        }
        state.0.notify();
    }
}

fn take_usb(core: &Core) -> Option<usb::Device> {
    let mut inner = core.inner.lock().unwrap();
    if inner.auth.pairing.as_ref().is_some_and(|pair| pair.usb) {
        inner.auth.pairing = None;
    }
    inner.usb.take().map(|link| link.device)
}

pub fn shutdown(app: &AppHandle) {
    shutdown_tailscale(app);
    if let Some(state) = app.try_state::<RemoteState>() {
        if let Some(device) = take_usb(&state.0) {
            tauri::async_runtime::spawn(async move {
                usb::disconnect(&device.serial).await;
            });
        }
        state.0.notify();
    }
}

#[tauri::command]
pub async fn remote_usb_devices() -> Result<Vec<usb::Device>, String> {
    usb::devices().await
}

#[tauri::command]
pub async fn remote_usb_disconnect(app: AppHandle) -> Status {
    let core = app.state::<RemoteState>().0.clone();
    let _operation = core.operation.lock().await;
    if let Some(device) = take_usb(&core) {
        usb::disconnect(&device.serial).await;
    }
    publish(&app, &core);
    status(&core)
}

#[tauri::command]
pub async fn remote_usb_connect(app: AppHandle, serial: String) -> Result<Status, String> {
    let core = app.state::<RemoteState>().0.clone();
    let _operation = core.operation.lock().await;
    let (device, package) = usb::require_phone(&serial).await?;
    let current = core
        .inner
        .lock()
        .unwrap()
        .usb
        .as_ref()
        .map(|link| link.device.serial.clone());
    if current.as_ref().is_some_and(|s| s != &serial) {
        return Err("Disconnect the current USB phone before connecting another.".into());
    }
    if current.is_none() {
        if app.asset_resolver().get("remote.html".into()).is_none() {
            return Err("Build the phone interface and restart VelumCode.".into());
        }
        let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, usb::PORT))
            .await
            .map_err(|_| {
                "USB port 43827 is in use. Close the other app using that port and try again."
            })?;
        usb::connect(&serial).await?;
        let (stop, stopped) = oneshot::channel();
        core.inner.lock().unwrap().usb = Some(UsbLink {
            device,
            _stop: stop,
        });
        let web = WebState {
            core: core.clone(),
            app: Some(app.clone()),
            usb: true,
        };
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            if axum::serve(listener, router(web))
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .is_err()
            {
                let _ = remote_usb_disconnect(handle).await;
            }
        });
    } else {
        usb::connect(&serial).await?;
    }
    let url = {
        let mut inner = core.inner.lock().unwrap();
        let (token, _) = inner.auth.invite(remote_auth::now());
        inner.auth.pairing.as_mut().unwrap().usb = true;
        format!("{}/#pair={token}", usb::ORIGIN)
    };
    if let Err(error) = usb::open(&serial, package, &url).await {
        take_usb(&core);
        usb::disconnect(&serial).await;
        publish(&app, &core);
        return Err(error);
    }
    publish(&app, &core);
    Ok(status(&core))
}

#[tauri::command]
pub fn remote_status(state: tauri::State<RemoteState>) -> Status {
    status(&state.0)
}

#[tauri::command]
pub async fn remote_check_tailscale(app: AppHandle) -> Status {
    let info = tailscale::status().await;
    let core = &app.state::<RemoteState>().0;
    core.inner.lock().unwrap().tailscale = info;
    publish(&app, core);
    status(core)
}

#[tauri::command]
pub async fn remote_enable(app: AppHandle, enabled: bool) -> Result<Status, String> {
    let core = app.state::<RemoteState>().0.clone();
    let _operation = core.operation.lock().await;
    if !enabled {
        shutdown_tailscale(&app);
        let mut inner = core.inner.lock().unwrap();
        inner.auth.saved.enabled = false;
        inner.error = None;
        core.persist(&inner.auth.saved)?;
        drop(inner);
        publish(&app, &core);
        return Ok(status(&core));
    }
    if core.inner.lock().unwrap().origin.is_some() {
        return Ok(status(&core));
    }
    let result = start(&app, &core).await;
    if let Err(error) = &result {
        core.inner.lock().unwrap().error = Some(error.clone());
    }
    publish(&app, &core);
    result.map(|()| status(&core))
}

async fn start(app: &AppHandle, core: &Arc<Core>) -> Result<(), String> {
    let info = tailscale::status().await;
    core.inner.lock().unwrap().tailscale = info.clone();
    if !info.connected {
        return Err(info.message);
    }
    let hostname = info
        .hostname
        .ok_or("Enable MagicDNS in Tailscale, then try again.")?;
    if !hostname.ends_with(".ts.net")
        || !hostname
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
    {
        return Err("Tailscale did not provide a valid private DNS name.".into());
    }
    if app.asset_resolver().get("remote.html".into()).is_none() {
        return Err(
            "The phone interface is missing. Build the frontend and restart VelumCode.".into(),
        );
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let child = tailscale::start(port).await?;
    let origin = format!("https://{hostname}:{}", tailscale::HTTPS_PORT);
    let (stop, stopped) = oneshot::channel();
    {
        let mut inner = core.inner.lock().unwrap();
        inner.auth.saved.enabled = true;
        if let Err(error) = core.persist(&inner.auth.saved) {
            inner.auth.saved.enabled = false;
            return Err(error);
        }
        inner.origin = Some(origin);
        inner.serve = Some(child);
        inner.server = Some(stop);
        inner.error = None;
    }
    let web = WebState {
        core: core.clone(),
        app: Some(app.clone()),
        usb: false,
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = axum::serve(listener, router(web))
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
        {
            let core = &handle.state::<RemoteState>().0;
            shutdown_tailscale(&handle);
            core.inner.lock().unwrap().error = Some(format!("Remote access stopped: {error}"));
            publish(&handle, core);
        }
    });
    Ok(())
}

#[derive(Serialize)]
pub struct Invitation {
    url: String,
    svg: String,
    code: String,
    expires_at: u64,
}

#[tauri::command]
pub fn remote_pair(app: AppHandle) -> Result<Invitation, String> {
    let core = &app.state::<RemoteState>().0;
    let mut inner = core.inner.lock().unwrap();
    let origin = inner.origin.clone().ok_or("Enable remote access first.")?;
    let (token, code) = inner.auth.invite(remote_auth::now());
    let url = format!("{origin}/#pair={token}");
    let qr = qrcode::QrCode::new(url.as_bytes()).map_err(|e| e.to_string())?;
    let svg = qr
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(256, 256)
        .build();
    let invitation = Invitation {
        url,
        svg,
        code,
        expires_at: remote_auth::now() + remote_auth::PAIR_SECONDS,
    };
    drop(inner);
    publish(&app, core);
    Ok(invitation)
}

#[tauri::command]
pub fn remote_approve(app: AppHandle, code: String, control: bool) -> Result<(), String> {
    let core = &app.state::<RemoteState>().0;
    let mut inner = core.inner.lock().unwrap();
    inner.auth.approve(&code, control, remote_auth::now())?;
    if let Err(error) = core.persist(&inner.auth.saved) {
        if let Some(device) = inner.auth.pairing.as_mut().and_then(|p| p.device.take()) {
            inner.auth.saved.devices.retain(|d| d.id != device.id);
        }
        return Err(error);
    }
    drop(inner);
    publish(&app, core);
    Ok(())
}

#[tauri::command]
pub fn remote_cancel_pairing(app: AppHandle) {
    let core = &app.state::<RemoteState>().0;
    core.inner.lock().unwrap().auth.pairing = None;
    publish(&app, core);
}

#[tauri::command]
pub fn remote_revoke(app: AppHandle, id: String) -> Result<(), String> {
    let core = &app.state::<RemoteState>().0;
    let mut inner = core.inner.lock().unwrap();
    inner.auth.saved.devices.retain(|d| d.id != id);
    // A consumed pairing must never re-issue a revoked cookie.
    if inner
        .auth
        .pairing
        .as_ref()
        .is_some_and(|p| p.device.as_ref().is_some_and(|d| d.id == id))
    {
        inner.auth.pairing = None;
    }
    let result = core.persist(&inner.auth.saved);
    drop(inner);
    publish(&app, core);
    result
}

fn router(state: WebState) -> Router {
    Router::new()
        .route("/api/me", get(me))
        .route("/api/logout", post(logout))
        .route("/api/pair/claim", post(claim))
        .route("/api/pair/finish", post(finish))
        .route("/api/sessions", get(sessions))
        .route("/api/sessions/{id}", get(replay))
        .route("/api/sessions/{id}/send", post(send))
        .route("/api/sessions/{id}/respond", post(respond))
        .route("/api/sessions/{id}/queue", post(queue))
        .route("/api/sessions/{id}/stop", post(stop))
        .route("/api/sessions/{id}/options", post(configure))
        .route("/api/sessions/{id}/memory", post(memory_request))
        .route("/api/sessions/{id}/kanban", post(kanban_request))
        .route("/api/bots", post(bots_request))
        .route("/api/sessions/{id}/bots/{bot}/memory", post(bot_memory))
        .route("/api/sessions/{id}/bots/{bot}/chat", post(bot_chat))
        .route("/api/sessions/{id}/automation", post(automation_request))
        .route("/api/sessions/{id}/diagnostics", get(diagnostics))
        .route("/api/providers/{provider}/models", get(models))
        .route("/api/events", get(events))
        .fallback(asset)
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn_with_state(state.clone(), boundary))
        .with_state(state)
}

async fn boundary(
    State(state): State<WebState>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let origin = state.origin(&state.core.inner.lock().unwrap());
    let Some(origin) = origin else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Remote access is off.").into_response();
    };
    let headers = request.headers();
    let host = headers.get("host").and_then(|h| h.to_str().ok());
    if host != origin.split_once("://").map(|(_, host)| host) {
        return (StatusCode::FORBIDDEN, "Unrecognized host.").into_response();
    }
    let supplied_origin = headers.get("origin").and_then(|h| h.to_str().ok());
    if supplied_origin.is_some_and(|o| o != origin) {
        return (StatusCode::FORBIDDEN, "Unrecognized origin.").into_response();
    }
    if request.method() != Method::GET
        && request.method() != Method::HEAD
        && (supplied_origin != Some(origin.as_str())
            || headers.get("x-muse-request").and_then(|h| h.to_str().ok()) != Some("1"))
    {
        return (StatusCode::FORBIDDEN, "Use the VelumCode phone interface.").into_response();
    }
    let mut response = next.run(request).await;
    for (key, value) in [
        ("cache-control", "no-store"), ("x-content-type-options", "nosniff"),
        ("referrer-policy", "no-referrer"), ("x-frame-options", "DENY"),
        ("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"),
        ("permissions-policy", "camera=(), microphone=(), geolocation=()"),
    ] { response.headers_mut().insert(key, HeaderValue::from_static(value)); }
    response
}

fn credential(headers: &HeaderMap, usb: bool) -> Option<&str> {
    headers
        .get("cookie")?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| {
            let (name, value) = part.trim().split_once('=')?;
            (name == if usb { USB_COOKIE } else { COOKIE }).then_some(value)
        })
}
fn authenticate(state: &WebState, headers: &HeaderMap, control: bool) -> Result<Device, ApiError> {
    let inner = state.core.inner.lock().unwrap();
    if state.origin(&inner).is_none() {
        return Err(unauthorized());
    }
    let device = inner
        .auth
        .authenticate(
            credential(headers, state.usb).unwrap_or_default(),
            remote_auth::now(),
        )
        .filter(|device| device.usb == state.usb)
        .ok_or_else(unauthorized)?;
    if control && !device.control {
        return Err(ApiError(
            StatusCode::FORBIDDEN,
            "This phone has view-only access.".into(),
        ));
    }
    Ok(device)
}

async fn me(State(state): State<WebState>, headers: HeaderMap) -> ApiResult {
    let device = authenticate(&state, &headers, false)?;
    Ok(Json(
        json!({"device": device.public(), "computer": state.core.inner.lock().unwrap().tailscale.hostname}),
    ))
}

#[derive(Deserialize)]
struct Claim {
    invitation: String,
    claim: String,
    name: String,
}
async fn claim(State(state): State<WebState>, Json(body): Json<Claim>) -> ApiResult {
    if !state
        .core
        .inner
        .lock()
        .unwrap()
        .auth
        .pairing
        .as_ref()
        .is_some_and(|pair| pair.usb == state.usb)
    {
        return Err(bad(
            "Start pairing again using this connection on your desktop.",
        ));
    }
    let pending = state
        .core
        .inner
        .lock()
        .unwrap()
        .auth
        .claim(
            &body.invitation,
            &body.claim,
            &body.name,
            remote_auth::now(),
        )
        .map_err(bad)?;
    if let Some(app) = &state.app {
        publish(app, &state.core);
    }
    Ok(Json(json!({"pending": pending})))
}

#[derive(Deserialize)]
struct Finish {
    claim: String,
}
async fn finish(
    State(state): State<WebState>,
    Json(body): Json<Finish>,
) -> Result<Response, ApiError> {
    let inner = state.core.inner.lock().unwrap();
    if !inner
        .auth
        .pairing
        .as_ref()
        .is_some_and(|pair| pair.usb == state.usb)
    {
        return Err(bad(
            "Start pairing again using this connection on your desktop.",
        ));
    }
    let paired = inner
        .auth
        .finish(&body.claim, remote_auth::now())
        .map_err(bad)?;
    let Some((device, token)) = paired else {
        return Ok(Json(
            json!({"status": "pending", "pending": inner.auth.pending(remote_auth::now())}),
        )
        .into_response());
    };
    let mut response = Json(json!({"status": "paired", "device": device.public()})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(
            &state.cookie(token, device.expires_at.saturating_sub(remote_auth::now())),
        )
        .map_err(|_| bad("Invalid login."))?,
    );
    Ok(response)
}

async fn logout(State(state): State<WebState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let device = authenticate(&state, &headers, false)?;
    {
        let mut inner = state.core.inner.lock().unwrap();
        inner.auth.saved.devices.retain(|d| d.id != device.id);
        state.core.persist(&inner.auth.saved).map_err(bad)?;
    }
    if let Some(app) = &state.app {
        publish(app, &state.core);
    }
    let mut response = Json(json!({"ok":true})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&state.cookie("", 0)).map_err(|_| bad("Invalid login."))?,
    );
    Ok(response)
}

async fn sessions(State(state): State<WebState>, headers: HeaderMap) -> ApiResult {
    authenticate(&state, &headers, false)?;
    let app = state
        .app
        .as_ref()
        .ok_or_else(|| bad("Desktop unavailable."))?;
    Ok(Json(
        json!({"sessions": app.state::<SessionLog>().summaries()}),
    ))
}

#[derive(Deserialize)]
struct Cursor {
    #[serde(default)]
    after: u64,
}
async fn replay(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(cursor): Query<Cursor>,
) -> ApiResult {
    authenticate(&state, &headers, false)?;
    let app = state
        .app
        .as_ref()
        .ok_or_else(|| bad("Desktop unavailable."))?;
    let replay = app
        .state::<SessionLog>()
        .replay(&id, cursor.after)
        .ok_or(ApiError(
            StatusCode::NOT_FOUND,
            "This conversation was closed on the desktop.".into(),
        ))?;
    let mut value = json!(replay);
    value["interactions"] = json!(runner::interactions_snapshot(app, &id).map_err(bad)?);
    Ok(Json(value))
}

async fn respond(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(decision): Json<crate::interactions::Decision>,
) -> ApiResult {
    authenticate(&state, &headers, true)?;
    let app = state
        .app
        .as_ref()
        .ok_or_else(|| bad("Desktop unavailable."))?;
    let snapshot = runner::respond_interaction(app, &id, decision, "phone")
        .map_err(|message| ApiError(StatusCode::CONFLICT, message))?;
    Ok(Json(json!(snapshot)))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prompt {
    prompt: String,
}
async fn send(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(body): Json<Prompt>,
) -> ApiResult {
    authenticate(&state, &headers, true)?;
    if body.prompt.trim().is_empty() || body.prompt.chars().count() > 16_000 {
        return Err(bad("Enter a message of up to 16,000 characters."));
    }
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        runner::agent_send(
            app.clone(),
            app.state::<runner::AgentState>(),
            id,
            body.prompt,
            false,
            Some(true),
        )
    })
    .await
    .map_err(|e| bad(e.to_string()))?
    .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    Ok(Json(json!(result)))
}

async fn queue(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<crate::message_queue::Request>,
) -> ApiResult {
    authenticate(
        &state,
        &headers,
        !matches!(request, crate::message_queue::Request::Load {}),
    )?;
    if let crate::message_queue::Request::Edit { prompt, .. } = &request {
        if prompt.trim().is_empty() || prompt.chars().count() > 16_000 {
            return Err(bad("Enter a message of up to 16,000 characters."));
        }
    }
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    session_workspace(&app, &id)?;
    let result =
        tauri::async_runtime::spawn_blocking(move || runner::queue_request(&app, &id, request))
            .await
            .map_err(|e| bad(e.to_string()))?
            .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    Ok(Json(json!(result)))
}

#[derive(Default, Deserialize)]
struct ModelQuery {
    #[serde(default)]
    refresh: bool,
}
async fn models(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(provider): Path<crate::providers::Provider>,
    Query(query): Query<ModelQuery>,
) -> ApiResult {
    authenticate(&state, &headers, false)?;
    let catalog = tauri::async_runtime::spawn_blocking(move || {
        crate::provider_models::catalog(provider, query.refresh)
    })
    .await
    .map_err(|e| bad(e.to_string()))?;
    Ok(Json(json!(catalog)))
}
async fn configure(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(options): Json<crate::provider_models::RunOptions>,
) -> ApiResult {
    authenticate(&state, &headers, true)?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    runner::configure_session(
        &app,
        &app.state::<runner::AgentState>(),
        &id,
        options,
        false,
    )
    .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    Ok(Json(json!({"ok":true})))
}

async fn diagnostics(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    authenticate(&state, &headers, false)?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let workspace = session_workspace(&app, &id)?;
    let report = tauri::async_runtime::spawn_blocking(move || {
        crate::app_context::diagnostics(&app, &workspace, Some(&id))
    })
    .await
    .map_err(|e| bad(e.to_string()))?;
    Ok(Json(report))
}

fn session_workspace(app: &tauri::AppHandle, id: &str) -> Result<String, ApiError> {
    app.state::<SessionLog>()
        .summaries()
        .into_iter()
        .find(|s| s.id == id)
        .map(|s| s.workspace)
        .ok_or(ApiError(
            StatusCode::NOT_FOUND,
            "This conversation is closed.".into(),
        ))
}
async fn bots_request(
    State(state): State<WebState>,
    headers: HeaderMap,
    Json(request): Json<crate::bots::Request>,
) -> ApiResult {
    authenticate(
        &state,
        &headers,
        !matches!(&request, crate::bots::Request::List {}),
    )?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let view = crate::bots::bots_request(app, request)
        .await
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    Ok(Json(json!(view)))
}
async fn bot_memory(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path((id, bot)): Path<(String, String)>,
    Json(request): Json<crate::memory::Request>,
) -> ApiResult {
    authenticate(
        &state,
        &headers,
        !matches!(&request, crate::memory::Request::List { .. }),
    )?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let workspace = session_workspace(&app, &id)?;
    let view = crate::bots::bots_memory(app, bot, workspace, request)
        .await
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    Ok(Json(json!(view)))
}
async fn bot_chat(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path((id, bot)): Path<(String, String)>,
) -> ApiResult {
    authenticate(&state, &headers, true)?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let workspace = session_workspace(&app, &id)?;
    let profile = app.state::<crate::bots::Store>().get(&bot).map_err(bad)?;
    if !profile.enabled {
        return Err(bad("This bot is disabled."));
    }
    let sessions = app.state::<SessionLog>().summaries();
    if let Some(existing) = sessions.iter().find(|s| {
        s.bot.as_ref().is_some_and(|b| b.id == bot)
            && s.workspace == workspace
            && !s.id.starts_with("bot-run-")
    }) {
        return Ok(Json(json!({"id":existing.id})));
    }
    if sessions.len() >= 32 {
        return Err(bad(
            "Close a desktop conversation before opening another bot.",
        ));
    }
    let tab = uuid::Uuid::new_v4().to_string();
    app.emit(
        "bot-chat-open",
        json!({"tab_id":tab,"bot":profile,"workspace":workspace}),
    )
    .map_err(|e| bad(e.to_string()))?;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(100)).await;
        if let Some(session) = app
            .state::<SessionLog>()
            .summaries()
            .into_iter()
            .find(|s| s.id.starts_with(&format!("{tab}-agent-")))
        {
            return Ok(Json(json!({"id":session.id})));
        }
    }
    Err(bad("The desktop has not opened the bot conversation yet. Check Velum on your desktop before trying again."))
}
async fn automation_request(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<crate::automation::Request>,
) -> ApiResult {
    authenticate(
        &state,
        &headers,
        !matches!(
            &request,
            crate::automation::Request::List {} | crate::automation::Request::Preview { .. }
        ),
    )?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let workspace = session_workspace(&app, &id)?;
    let workspace_key = crate::automation::canonical(&workspace).map_err(bad)?;
    if let crate::automation::Request::Run { id }
    | crate::automation::Request::Pause { id, .. }
    | crate::automation::Request::Stop { id } = &request
    {
        let view = app.state::<crate::automation::Store>().view();
        if !view
            .snapshot
            .jobs
            .iter()
            .any(|j| &j.id == id && j.workspace == workspace_key)
        {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                "This job belongs to another workspace.".into(),
            ));
        }
    }
    let mut value = crate::automation::automation_request(app, request)
        .await
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    filter_automation_workspace(&mut value, &workspace_key);
    Ok(Json(value))
}
fn filter_automation_workspace(value: &mut Value, workspace: &str) {
    if let Some(jobs) = value.get_mut("jobs").and_then(|v| v.as_array_mut()) {
        jobs.retain(|j| j["workspace"].as_str() == Some(workspace));
        let ids = jobs
            .iter()
            .filter_map(|j| j["id"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        if let Some(runs) = value.get_mut("runs").and_then(|v| v.as_array_mut()) {
            runs.retain(|r| {
                r["workspace"].as_str() == Some(workspace)
                    || r["workspace"].as_str().unwrap_or("").is_empty()
                        && r["job_id"]
                            .as_str()
                            .is_some_and(|id| ids.iter().any(|v| v == id))
            });
        }
    }
}
async fn kanban_request(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<crate::kanban::Request>,
) -> ApiResult {
    authenticate(
        &state,
        &headers,
        !matches!(request, crate::kanban::Request::Load {}),
    )?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let workspace = app
        .state::<SessionLog>()
        .summaries()
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(ApiError(
            StatusCode::NOT_FOUND,
            "This conversation is closed.".into(),
        ))?
        .workspace;
    let result = crate::kanban::kanban_request(app, workspace, request)
        .await
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    Ok(Json(json!(result)))
}

async fn memory_request(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(request): Json<crate::memory::Request>,
) -> ApiResult {
    let writing = !matches!(request, crate::memory::Request::List { .. });
    authenticate(&state, &headers, writing)?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    let workspace = app
        .state::<SessionLog>()
        .summaries()
        .into_iter()
        .find(|s| s.id == id)
        .ok_or(ApiError(
            StatusCode::NOT_FOUND,
            "This conversation is closed.".into(),
        ))?
        .workspace;
    let result = app
        .state::<crate::memory::Store>()
        .request(&workspace, request)
        .map_err(|e| ApiError(StatusCode::CONFLICT, e))?;
    if writing {
        crate::memory::changed(&app);
    }
    Ok(Json(json!(result)))
}

async fn stop(
    State(state): State<WebState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult {
    authenticate(&state, &headers, true)?;
    let app = state.app.ok_or_else(|| bad("Desktop unavailable."))?;
    tauri::async_runtime::spawn_blocking(move || {
        runner::agent_stop(app.clone(), app.state::<runner::AgentState>(), id)
    })
    .await
    .map_err(|e| bad(e.to_string()))?
    .map_err(bad)?;
    Ok(Json(json!({"ok":true})))
}

async fn events(State(state): State<WebState>, headers: HeaderMap) -> Result<Response, ApiError> {
    authenticate(&state, &headers, false)?;
    let mut receiver = state.core.changes.subscribe();
    let stream = async_stream::stream! {
        yield Ok::<Event, Infallible>(Event::default().event("change").data("ready"));
        let mut check = tokio::time::interval(Duration::from_secs(2));
        loop {
            let changed = tokio::select! { result = receiver.changed() => { if result.is_err() { break; } true }, _ = check.tick() => false };
            if authenticate(&state, &headers, false).is_err() {
                yield Ok(Event::default().event("revoked").data("Pair again"));
                break;
            }
            if changed { yield Ok(Event::default().event("change").data("updated")); }
        }
    };
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response())
}

async fn asset(State(state): State<WebState>, uri: axum::http::Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let name = if path.is_empty() { "remote.html" } else { path };
    let allowed = matches!(
        name,
        "remote.html"
            | "manifest.webmanifest"
            | "sw.js"
            | "velum-icon.png"
            | "velum-192.png"
            | "velum-512.png"
    ) || name.strip_prefix("assets/").is_some_and(|s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
    });
    if !allowed {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(app) = state.app else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Some(asset) = app.asset_resolver().get(name.into()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mut response = Response::new(Body::from(asset.bytes));
    if let Ok(mime) = HeaderValue::from_str(&asset.mime_type) {
        response.headers_mut().insert("content-type", mime);
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    fn fixture(control: bool) -> (WebState, String) {
        let token = remote_auth::secret();
        let saved = Saved {
            enabled: true,
            devices: vec![Device {
                id: "phone".into(),
                name: "Test phone".into(),
                control,
                usb: false,
                credential_hash: remote_auth::hash(&token),
                created_at: remote_auth::now(),
                expires_at: remote_auth::now() + 60,
            }],
        };
        let (changes, _) = watch::channel(0);
        let core = Arc::new(Core {
            inner: Mutex::new(Inner {
                auth: Auth::new(saved),
                origin: Some("https://desktop.test.ts.net:8443".into()),
                server: None,
                serve: None,
                tailscale: tailscale::Status::default(),
                error: None,
                usb: None,
            }),
            changes,
            operation: tokio::sync::Mutex::new(()),
            path: std::env::temp_dir()
                .join(format!("muse-remote-test-{}.json", uuid::Uuid::new_v4())),
        });
        (
            WebState {
                core,
                app: None,
                usb: false,
            },
            token,
        )
    }
    fn request(path: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
        let mut request = Request::builder()
            .uri(path)
            .header("host", "desktop.test.ts.net:8443");
        if let Some(token) = token {
            request = request.header("cookie", format!("{COOKIE}={token}"));
        }
        if let Some(body) = body {
            request
                .method("POST")
                .header("origin", "https://desktop.test.ts.net:8443")
                .header("x-muse-request", "1")
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap()
        } else {
            request.body(Body::empty()).unwrap()
        }
    }
    async fn body(response: Response) -> Value {
        serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 100_000)
                .await
                .unwrap(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn private_data_requires_pairing_and_never_returns_credential_hash() {
        let (state, token) = fixture(true);
        for path in [
            "/api/me",
            "/api/sessions",
            "/api/sessions/one",
            "/api/sessions/one/diagnostics",
            "/api/events",
        ] {
            assert_eq!(
                router(state.clone())
                    .oneshot(request(path, None, None))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::UNAUTHORIZED
            );
        }
        let response = router(state)
            .oneshot(request("/api/me", Some(&token), None))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let value = body(response).await;
        assert!(value["device"].get("credential_hash").is_none());
        assert_eq!(value["device"]["name"], "Test phone");
    }
    #[tokio::test]
    async fn host_origin_and_csrf_header_are_required() {
        let (state, token) = fixture(true);
        let mut evil = request("/api/me", Some(&token), None);
        evil.headers_mut()
            .insert("host", HeaderValue::from_static("attacker.example"));
        assert_eq!(
            router(state.clone()).oneshot(evil).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let mut evil = request("/api/logout", Some(&token), Some(json!({})));
        evil.headers_mut().insert(
            "origin",
            HeaderValue::from_static("https://attacker.example"),
        );
        assert_eq!(
            router(state.clone()).oneshot(evil).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
        let mut evil = request("/api/logout", Some(&token), Some(json!({})));
        evil.headers_mut().remove("x-muse-request");
        assert_eq!(
            router(state).oneshot(evil).await.unwrap().status(),
            StatusCode::FORBIDDEN
        );
    }
    #[tokio::test]
    async fn read_only_devices_cannot_send_or_stop_and_extra_controls_are_rejected() {
        let (state, token) = fixture(false);
        assert_eq!(
            router(state.clone())
                .oneshot(request(
                    "/api/sessions/one/options",
                    Some(&token),
                    Some(json!({"model":"test","reasoning":"high"}))
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            router(state.clone())
                .oneshot(request("/api/providers/codex/models", None, None))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            router(state.clone())
                .oneshot(request(
                    "/api/sessions/one/options",
                    Some(&token),
                    Some(json!({"model":"test","reasoning":"high","yolo":true}))
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            router(state.clone())
                .oneshot(request(
                    "/api/sessions/one/send",
                    Some(&token),
                    Some(json!({"prompt":"hello"}))
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            router(state.clone())
                .oneshot(request(
                    "/api/sessions/one/stop",
                    Some(&token),
                    Some(json!({}))
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            router(state)
                .oneshot(request(
                    "/api/sessions/one/send",
                    Some(&token),
                    Some(json!({"prompt":"hello","yolo":true}))
                ))
                .await
                .unwrap()
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }
    #[tokio::test]
    async fn queue_api_requires_pairing_control_and_rejects_permission_overrides() {
        let (state, token) = fixture(false);
        for (payload, auth, expected) in [
            (json!({"action":"load"}), None, StatusCode::UNAUTHORIZED),
            (
                json!({"action":"resume"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"pause"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"clear"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"remove","message_id":"one"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"edit","message_id":"one","prompt":"Changed"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"resume","yolo":true}),
                Some(token.as_str()),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
            (
                json!({"action":"load","workspace":"C:\\elsewhere"}),
                Some(token.as_str()),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
        ] {
            assert_eq!(
                router(state.clone())
                    .oneshot(request("/api/sessions/one/queue", auth, Some(payload)))
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn kanban_api_requires_pairing_control_and_fixed_workspace() {
        let (state, token) = fixture(false);
        for (body, auth, expected) in [
            (json!({"action":"load"}), None, StatusCode::UNAUTHORIZED),
            (
                json!({"action":"delete","id":"card","revision":0}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"restore","id":"card","revision":0}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"purge","id":"card","revision":0}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"move","id":"card","column":"done","before":null,"revision":0}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"load","workspace":"C:\\elsewhere"}),
                Some(token.as_str()),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
        ] {
            assert_eq!(
                router(state.clone())
                    .oneshot(request("/api/sessions/one/kanban", auth, Some(body)))
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn bot_and_schedule_controls_require_pairing_and_write_access() {
        let (state, token) = fixture(false);
        for (path, payload, auth, expected) in [
            (
                "/api/bots",
                json!({"action":"list"}),
                None,
                StatusCode::UNAUTHORIZED,
            ),
            (
                "/api/bots",
                json!({"action":"delete","id":"bot","revision":"r1"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                "/api/sessions/one/bots/bot/chat",
                json!({}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                "/api/sessions/one/bots/bot/memory",
                json!({"action":"list","query":""}),
                None,
                StatusCode::UNAUTHORIZED,
            ),
            (
                "/api/sessions/one/bots/bot/memory",
                json!({"action":"configure","settings":{"enabled":false,"capture":"manual","budget_bytes":1000}}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                "/api/sessions/one/automation",
                json!({"action":"run","id":"job"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                "/api/sessions/one/automation",
                json!({"action":"configure","enabled":true}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                "/api/sessions/one/automation",
                json!({"action":"list","workspace":"C:\\elsewhere"}),
                Some(token.as_str()),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
        ] {
            assert_eq!(
                router(state.clone())
                    .oneshot(request(path, auth, Some(payload)))
                    .await
                    .unwrap()
                    .status(),
                expected,
                "{path}"
            );
        }
    }
    #[test]
    fn run_history_keeps_its_workspace_after_a_task_is_unassigned() {
        let mut view = json!({"jobs":[{"id":"existing","workspace":"alpha"},{"id":"foreign","workspace":"beta"}],"runs":[{"id":"removed-task","job_id":"removed","workspace":"alpha"},{"id":"legacy","job_id":"existing"},{"id":"foreign","job_id":"foreign","workspace":"beta"},{"id":"unknown","job_id":"removed"}]});
        filter_automation_workspace(&mut view, "alpha");
        assert_eq!(view["jobs"].as_array().unwrap().len(), 1);
        assert_eq!(
            view["runs"]
                .as_array()
                .unwrap()
                .iter()
                .map(|r| r["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["removed-task", "legacy"]
        );
    }
    #[tokio::test]
    async fn memory_api_requires_pairing_control_and_fixed_workspace() {
        let (state, token) = fixture(false);
        for (body, auth, expected) in [
            (json!({"action":"list"}), None, StatusCode::UNAUTHORIZED),
            (
                json!({"action":"delete","id":"test","revision":"r1"}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"configure","settings":{"enabled":false,"capture":"manual","budget_bytes":1000}}),
                Some(token.as_str()),
                StatusCode::FORBIDDEN,
            ),
            (
                json!({"action":"list","workspace":"C:\\elsewhere"}),
                Some(token.as_str()),
                StatusCode::UNPROCESSABLE_ENTITY,
            ),
        ] {
            assert_eq!(
                router(state.clone())
                    .oneshot(request("/api/sessions/one/memory", auth, Some(body)))
                    .await
                    .unwrap()
                    .status(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn pairing_cookie_needs_desktop_approval_and_revocation_is_immediate() {
        let (state, _) = fixture(true);
        let claim = remote_auth::secret();
        let (invitation, code) = state
            .core
            .inner
            .lock()
            .unwrap()
            .auth
            .invite(remote_auth::now());
        let response = router(state.clone())
            .oneshot(request(
                "/api/pair/claim",
                None,
                Some(json!({"invitation":invitation,"claim":claim,"name":"My phone"})),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response = router(state.clone())
            .oneshot(request(
                "/api/pair/finish",
                None,
                Some(json!({"claim":claim})),
            ))
            .await
            .unwrap();
        assert!(response.headers().get("set-cookie").is_none());
        assert_eq!(body(response).await["pending"]["code"], code);
        state
            .core
            .inner
            .lock()
            .unwrap()
            .auth
            .approve(&code, true, remote_auth::now())
            .unwrap();
        let response = router(state.clone())
            .oneshot(request(
                "/api/pair/finish",
                None,
                Some(json!({"claim":claim})),
            ))
            .await
            .unwrap();
        let cookie = response.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .to_owned();
        assert!(cookie.contains("HttpOnly; Secure; SameSite=Strict"));
        let token = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
        assert_eq!(
            router(state.clone())
                .oneshot(request("/api/me", Some(token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        state.core.inner.lock().unwrap().auth.saved.devices.clear();
        assert_eq!(
            router(state.clone())
                .oneshot(request("/api/me", Some(token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = router(state)
            .oneshot(request(
                "/api/pair/finish",
                None,
                Some(json!({"claim":claim})),
            ))
            .await
            .unwrap();
        assert!(response.headers().get("set-cookie").is_none());
    }
    #[tokio::test]
    async fn disabling_remote_access_blocks_existing_cookies_and_path_traversal() {
        let (state, token) = fixture(true);
        for path in [
            "/index.html",
            "/assets/../../remote.json",
            "/api/agent_send",
            "/src/main.tsx",
        ] {
            assert_eq!(
                router(state.clone())
                    .oneshot(request(path, Some(&token), None))
                    .await
                    .unwrap()
                    .status(),
                StatusCode::NOT_FOUND
            );
        }
        state.core.inner.lock().unwrap().origin = None;
        assert_eq!(
            router(state)
                .oneshot(request("/api/me", Some(&token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    fn usb_request(path: &str, token: Option<&str>, body: Option<Value>) -> Request<Body> {
        let mut req = request(path, None, body);
        req.headers_mut()
            .insert("host", HeaderValue::from_static("127.0.0.1:43827"));
        if req.method() == Method::POST {
            req.headers_mut()
                .insert("origin", HeaderValue::from_static(usb::ORIGIN));
        }
        if let Some(token) = token {
            req.headers_mut().insert(
                "cookie",
                HeaderValue::from_str(&format!("{USB_COOKIE}={token}")).unwrap(),
            );
        }
        req
    }

    #[tokio::test]
    async fn usb_pairing_requires_approval_and_credentials_cannot_cross_transports() {
        let (tailnet, tail_token) = fixture(true);
        let mut cable = tailnet.clone();
        cable.usb = true;
        let (stop, _stopped) = oneshot::channel();
        let claim_token = remote_auth::secret();
        let (invitation, code) = {
            let mut inner = cable.core.inner.lock().unwrap();
            inner.usb = Some(UsbLink {
                device: usb::Device {
                    serial: "TEST".into(),
                    name: "Test USB phone".into(),
                    authorized: true,
                },
                _stop: stop,
            });
            let invitation = inner.auth.invite(remote_auth::now());
            inner.auth.pairing.as_mut().unwrap().usb = true;
            invitation
        };
        let claim_body =
            json!({"invitation": invitation, "claim": claim_token, "name": "USB phone"});
        assert_eq!(
            router(tailnet.clone())
                .oneshot(request("/api/pair/claim", None, Some(claim_body.clone())))
                .await
                .unwrap()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            router(cable.clone())
                .oneshot(usb_request("/api/pair/claim", None, Some(claim_body)))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        let pending = router(cable.clone())
            .oneshot(usb_request(
                "/api/pair/finish",
                None,
                Some(json!({"claim": claim_token})),
            ))
            .await
            .unwrap();
        assert!(pending.headers().get("set-cookie").is_none());
        assert_eq!(body(pending).await["pending"]["code"], code);
        cable
            .core
            .inner
            .lock()
            .unwrap()
            .auth
            .approve(&code, true, remote_auth::now())
            .unwrap();
        let paired = router(cable.clone())
            .oneshot(usb_request(
                "/api/pair/finish",
                None,
                Some(json!({"claim": claim_token})),
            ))
            .await
            .unwrap();
        let cookie = paired.headers()["set-cookie"].to_str().unwrap();
        assert!(cookie.starts_with("muse-usb="));
        assert!(cookie.contains("HttpOnly; SameSite=Strict"));
        assert!(!cookie.contains("Secure")); // HTTP exists only inside authorized ADB forwarding.
        let usb_token = cookie.split(';').next().unwrap().split_once('=').unwrap().1;
        assert_eq!(
            router(cable.clone())
                .oneshot(usb_request("/api/me", Some(usb_token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            router(tailnet.clone())
                .oneshot(request("/api/me", Some(usb_token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            router(cable.clone())
                .oneshot(usb_request("/api/me", Some(&tail_token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut attack = usb_request("/api/logout", Some(usb_token), Some(json!({})));
        attack.headers_mut().insert(
            "origin",
            HeaderValue::from_static("http://attacker.example"),
        );
        assert_eq!(
            router(cable.clone())
                .oneshot(attack)
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        let mut attack = usb_request("/api/logout", Some(usb_token), Some(json!({})));
        attack.headers_mut().remove("x-muse-request");
        assert_eq!(
            router(cable.clone())
                .oneshot(attack)
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
        cable.core.inner.lock().unwrap().origin = None;
        assert_eq!(
            router(cable.clone())
                .oneshot(usb_request("/api/me", Some(usb_token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        take_usb(&cable.core);
        assert_eq!(
            router(cable)
                .oneshot(usb_request("/api/me", Some(usb_token), None))
                .await
                .unwrap()
                .status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }
}
