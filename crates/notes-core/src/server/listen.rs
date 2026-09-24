use super::{AllowedHostname, AuthService, RunningServer, SettingsStore, start_configured};
use crate::auth::UserStore;
use std::{net::Ipv4Addr, path::Path, sync::Arc};

/// Starts a new IPv4 loopback service. Port zero requests an ephemeral port.
///
/// Startup does not succeed until the listener and runtime have initialized.
/// An occupied port is an error; no existing process is contacted or stopped.
pub fn start(root: &Path, port: u16) -> Result<RunningServer, String> {
    start_on(root, Ipv4Addr::LOCALHOST, port)
}

/// Starts a diagnostic token service on an explicit loopback IPv4 address.
pub fn start_on(root: &Path, host: Ipv4Addr, port: u16) -> Result<RunningServer, String> {
    if !host.is_loopback() {
        return Err("Token authentication is limited to loopback hosts. Use user authentication for network access.".into());
    }
    start_configured(root, host, port, None, None, &[])
}

/// Starts a service that uses the shared local user database.
pub fn start_with_users(root: &Path, port: u16, users: UserStore) -> Result<RunningServer, String> {
    start_with_users_on(root, Ipv4Addr::LOCALHOST, port, users)
}

/// Starts an authenticated service on an explicit IPv4 address.
/// The unspecified address listens on every IPv4 interface.
pub fn start_with_users_on(
    root: &Path,
    host: Ipv4Addr,
    port: u16,
    users: UserStore,
) -> Result<RunningServer, String> {
    start_with_users_on_hosts(root, host, port, users, &[])
}

/// Adds exact DNS hostnames without relaxing same-origin checks.
pub fn start_with_users_on_hosts(
    root: &Path,
    host: Ipv4Addr,
    port: u16,
    users: UserStore,
    allowed_hosts: &[AllowedHostname],
) -> Result<RunningServer, String> {
    let settings_store = SettingsStore::new(users.path().with_file_name("settings.json"));
    let scope = std::fs::canonicalize(root)
        .map_err(|error| format!("Could not open the selected folder: {error}"))?;
    start_configured(
        root,
        host,
        port,
        Some(Arc::new(AuthService::new_scoped(users, &scope)?)),
        Some(settings_store),
        allowed_hosts,
    )
}
