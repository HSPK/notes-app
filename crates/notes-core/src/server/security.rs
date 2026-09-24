use std::{
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, atomic::AtomicBool},
    time::Instant,
};

use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, StatusCode, header, uri::Authority},
    middleware::Next,
    response::{IntoResponse, Response},
};

use crate::auth::AuthenticatedUser;

use super::{ASSET_CSP, ApiError, AppState, CancelWork, MAX_JSON_BYTES, REQUEST_TIMEOUT, Work};

pub(super) async fn guard(
    State(state): State<Arc<AppState>>,
    mut request: Request,
    next: Next,
) -> Response {
    let asset_request = matches!(request.uri().path(), "/assets" | "/api/public/assets");
    let response = match check_request(&state, &request) {
        Err(error) => error.into_response(),
        Ok(user) => match state.requests.clone().try_acquire_owned() {
            Err(_) => ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "The local server is busy. Please try again.",
            )
            .into_response(),
            Ok(_permit) => {
                if let Some(user) = user {
                    request.extensions_mut().insert(user);
                }
                let timeout =
                    if request.uri().path() == "/api/projects" && request.method() == "POST" {
                        std::time::Duration::from_secs(130)
                    } else {
                        REQUEST_TIMEOUT
                    };
                if let Some(axum::extract::ConnectInfo(connection)) =
                    request
                        .extensions()
                        .get::<axum::extract::ConnectInfo<super::net::ConnectionInfo>>()
                {
                    connection.allow_request(timeout + std::time::Duration::from_secs(1));
                }
                let work = Arc::new(Work {
                    cancelled: AtomicBool::new(false),
                    deadline: Instant::now() + timeout,
                    health: state.health.clone(),
                });
                request.extensions_mut().insert(work.clone());
                let _cancel = CancelWork(work);
                let result = async {
                    let scoped = super::projects::api::scope(
                        state.clone(),
                        request.uri().clone(),
                        request.headers().clone(),
                        request.extensions().get::<AuthenticatedUser>().cloned(),
                    )
                    .await;
                    if let Ok(scoped) = &scoped {
                        request.extensions_mut().insert(scoped.clone());
                    }
                    match scoped {
                        Ok(_) => next.run(request).await,
                        Err(error) => error.into_response(),
                    }
                };
                match tokio::time::timeout(timeout, result).await {
                    Ok(response) => response,
                    Err(_) => ApiError::new(StatusCode::REQUEST_TIMEOUT, "The request timed out.")
                        .into_response(),
                }
            }
        },
    };
    secure_headers(response, asset_request, &state.content_policy)
}

fn check_request(
    state: &AppState,
    request: &Request,
) -> Result<Option<AuthenticatedUser>, ApiError> {
    let headers = request.headers();
    let host = request_host(headers, state.host, &state.allowed_hosts)?;
    if headers.get_all(header::ORIGIN).iter().count() > 1
        || headers.get(header::ORIGIN).is_some_and(|value| {
            value
                .to_str()
                .ok()
                .and_then(http_origin)
                .is_none_or(|origin| !same_authority(&host, &origin))
        })
    {
        return Err(ApiError::forbidden(
            "Cross-origin requests are not allowed.",
        ));
    }
    let path = request.uri().path();
    let authenticated = authenticated_user(headers, state);
    // Socket upgrades use a short-lived, single-use ticket issued by an authenticated POST.
    if path.starts_with("/api/")
        && path != "/api/collaboration/socket"
        && !super::projects::public::endpoint(path)
    {
        if state.user_auth.is_some() {
            let public_auth_endpoint = matches!(
                path,
                "/api/auth/status" | "/api/auth/setup" | "/api/auth/login" | "/api/auth/register"
            );
            if !public_auth_endpoint && authenticated.is_none() {
                return Err(ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "Log in to continue.",
                ));
            }
        } else if !has_launch_authorization(headers, state) {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "Open the browser using this server's authenticated launch URL.",
            ));
        }
    }
    if path == "/assets"
        && if state.user_auth.is_some() {
            authenticated.is_none()
        } else {
            !has_session_cookie(headers, state)
        }
    {
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
    Ok(authenticated)
}

pub(super) fn has_launch_authorization(headers: &HeaderMap, state: &AppState) -> bool {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    headers.get_all(header::AUTHORIZATION).iter().count() == 1
        && secret_eq(authorization, &state.authorization)
}

/// An explicitly trusted ASCII DNS hostname, without a scheme, port, or wildcard.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowedHostname(String);

impl AllowedHostname {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::str::FromStr for AllowedHostname {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() > 253
            || value.parse::<IpAddr>().is_ok()
            || !value.split('.').all(|label| {
                !label.is_empty()
                    && label.len() <= 63
                    && !label.starts_with('-')
                    && !label.ends_with('-')
                    && label
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
        {
            return Err("Allowed host must be an ASCII DNS hostname without a scheme, port, path, trailing dot, or wildcard.".into());
        }
        Ok(Self(value.to_ascii_lowercase()))
    }
}

#[derive(Eq, PartialEq)]
enum RequestHost {
    Localhost,
    Ip(IpAddr),
    Dns(AllowedHostname),
}

fn request_host(
    headers: &HeaderMap,
    bound: Ipv4Addr,
    allowed_hosts: &[AllowedHostname],
) -> Result<Authority, ApiError> {
    if headers.get_all(header::HOST).iter().count() != 1 {
        return Err(ApiError::forbidden(
            "The request must contain exactly one allowed Host.",
        ));
    }
    let value = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::forbidden("The request Host is invalid."))?;
    let authority = value
        .parse::<Authority>()
        .map_err(|_| ApiError::forbidden("The request Host is invalid."))?;
    let allowed = match request_host_name(&authority) {
        Some(RequestHost::Localhost) => true,
        Some(RequestHost::Ip(ip)) if ip.is_loopback() => true,
        Some(RequestHost::Ip(IpAddr::V4(ip))) => bound.is_unspecified() || ip == bound,
        Some(RequestHost::Dns(host)) => allowed_hosts.contains(&host),
        _ => false,
    };
    if value.contains('@') || !valid_port(&authority) || !allowed {
        return Err(ApiError::forbidden(
            "The request Host is not allowed for this server binding. Configure --allow-host for DNS access.",
        ));
    }
    Ok(authority)
}

fn http_origin(value: &str) -> Option<Authority> {
    let (scheme, authority) = value.split_once("://")?;
    if !scheme.eq_ignore_ascii_case("http")
        || authority.is_empty()
        || authority
            .bytes()
            .any(|byte| matches!(byte, b'/' | b'?' | b'#' | b'@'))
    {
        return None;
    }
    authority.parse::<Authority>().ok().filter(valid_port)
}

fn valid_port(authority: &Authority) -> bool {
    let value = authority.as_str();
    let suffix = if value.starts_with('[') {
        value.split_once(']').map(|(_, suffix)| suffix)
    } else {
        value.strip_prefix(authority.host())
    };
    match suffix {
        Some("") => true,
        Some(value) => value.strip_prefix(':').is_some_and(|port| {
            !port.is_empty()
                && port.bytes().all(|byte| byte.is_ascii_digit())
                && port.parse::<u16>().is_ok()
        }),
        None => false,
    }
}

fn same_authority(host: &Authority, origin: &Authority) -> bool {
    let host_name = request_host_name(host);
    host_name.is_some()
        && host_name == request_host_name(origin)
        && effective_port(host) == effective_port(origin)
}

fn effective_port(authority: &Authority) -> u16 {
    authority.port_u16().unwrap_or(80)
}

fn request_host_name(authority: &Authority) -> Option<RequestHost> {
    let host = authority.host();
    let host = host
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(host);
    if host.trim_end_matches('.').eq_ignore_ascii_case("localhost") {
        return Some(RequestHost::Localhost);
    }
    host.parse::<IpAddr>()
        .map(RequestHost::Ip)
        .ok()
        .or_else(|| host.parse().ok().map(RequestHost::Dns))
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
    cookie_value(headers, &state.cookie_name).is_some_and(|value| secret_eq(value, &state.token))
}

pub(super) fn authenticated_user(
    headers: &HeaderMap,
    state: &AppState,
) -> Option<AuthenticatedUser> {
    let auth = state.user_auth.as_ref()?;
    let token = cookie_value(headers, &state.user_cookie_name)?;
    auth.authenticate(token)
}

pub(super) fn cookie_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    let mut matches = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|part| part.trim().split_once('='))
        .filter(|(candidate, _)| *candidate == name)
        .map(|(_, value)| value);
    let value = matches.next()?;
    matches.next().is_none().then_some(value)
}

fn secure_headers(mut response: Response, asset: bool, content_policy: &HeaderValue) -> Response {
    if response.status() != StatusCode::SWITCHING_PROTOCOLS {
        response
            .headers_mut()
            .insert(header::CONNECTION, HeaderValue::from_static("close"));
    }
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
