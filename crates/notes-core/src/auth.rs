use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use argon2::PasswordHash;
use serde::{Deserialize, Serialize};

use crate::{
    settings::SettingsStore,
    storage::{PublishMode, load_json, save_json},
};

#[path = "auth/accounts.rs"]
mod accounts;
#[path = "auth/identity.rs"]
mod identity;
#[path = "auth/password.rs"]
mod password;
pub(crate) use password::{hash_password, verify_password};
#[path = "auth/sessions.rs"]
mod sessions;
pub(crate) use accounts::{AccountAction, AccountOverview, AccountResult};
pub(crate) use sessions::SESSION_TTL_SECONDS;
use sessions::SessionStore;

const DATABASE_VERSION: u32 = 1;
const MIN_PASSWORD_BYTES: usize = 12;
const MAX_PASSWORD_BYTES: usize = 1024;
const MAX_USERS: usize = 256;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Admin,
    User,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSummary {
    pub username: String,
    pub role: Role,
}

#[derive(Clone, Debug)]
pub struct UserStore {
    path: PathBuf,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct UserDatabase {
    version: u32,
    users: BTreeMap<String, StoredUser>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    invitations: BTreeMap<String, accounts::Invitation>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct StoredUser {
    password_hash: String,
    role: Role,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
}

impl UserDatabase {
    fn initial(username: String, password_hash: String) -> Self {
        Self {
            version: DATABASE_VERSION,
            invitations: BTreeMap::new(),
            users: BTreeMap::from([(
                username,
                StoredUser {
                    password_hash,
                    role: Role::Admin,
                    identity: None,
                },
            )]),
        }
    }

    fn validate(&self) -> Result<(), String> {
        accounts::validate_invitations(&self.invitations)?;
        if self.version != DATABASE_VERSION {
            return Err(format!(
                "Unsupported user database version {}.",
                self.version
            ));
        }
        if self.users.len() > MAX_USERS {
            return Err(format!(
                "The user database cannot contain more than {MAX_USERS} accounts."
            ));
        }
        let mut admins = 0;
        for (username, user) in &self.users {
            let normalized = normalize_username(username).map_err(|_| {
                format!("The user database contains an invalid username: {username}.")
            })?;
            if normalized != *username {
                return Err(format!(
                    "The user database contains an invalid username: {username}."
                ));
            }
            let hash = PasswordHash::new(&user.password_hash)
                .map_err(|_| format!("The password hash for {username} is invalid."))?;
            if hash.algorithm.as_str() != "argon2id" {
                return Err(format!(
                    "The password hash for {username} must use Argon2id."
                ));
            }
            if user.role == Role::Admin {
                admins += 1;
            }
        }
        if !self.users.is_empty() && admins == 0 {
            return Err("The user database must contain at least one administrator.".into());
        }
        Ok(())
    }
}

impl UserStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn platform_default() -> Result<Self, String> {
        let settings = SettingsStore::platform_default()?;
        Ok(Self::alongside_settings(settings.path()))
    }

    pub fn alongside_settings(settings_path: &Path) -> Self {
        Self::new(settings_path.with_file_name("users.json"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn setup_required(&self) -> Result<bool, String> {
        Ok(self.load()?.is_none())
    }

    pub fn initialize_admin(&self, username: &str, password: &str) -> Result<UserSummary, String> {
        let _file_lock = self.lock()?;
        let username = normalize_username(username)?;
        validate_password(password)?;
        if self.load()?.is_some() {
            return Err("The initial administrator has already been configured.".into());
        }
        let database = UserDatabase::initial(username.clone(), hash_password(password)?);
        if let Err(error) = save_json(&self.path, "users", &database, PublishMode::Create) {
            return if self.path.exists() {
                Err("The initial administrator has already been configured.".into())
            } else {
                Err(error)
            };
        }
        Ok(UserSummary {
            username,
            role: Role::Admin,
        })
    }

    pub fn add(&self, username: &str, password: &str, role: Role) -> Result<UserSummary, String> {
        let _file_lock = self.lock()?;
        let username = normalize_username(username)?;
        validate_password(password)?;
        let mut database = self.load()?.ok_or(
            "Open Notes in a browser and configure the initial administrator before adding users.",
        )?;
        if database.users.len() >= MAX_USERS {
            return Err(format!(
                "The user database cannot contain more than {MAX_USERS} accounts."
            ));
        }
        if database.users.contains_key(&username) {
            return Err(format!("The user {username} already exists."));
        }
        database.users.insert(
            username.clone(),
            StoredUser {
                password_hash: hash_password(password)?,
                role,
                identity: None,
            },
        );
        self.save(&database)?;
        Ok(UserSummary { username, role })
    }

    pub fn set_password(&self, username: &str, password: &str) -> Result<(), String> {
        let _file_lock = self.lock()?;
        let username = normalize_username(username)?;
        validate_password(password)?;
        let mut database = self
            .load()?
            .ok_or("No user database has been configured.")?;
        let user = database
            .users
            .get_mut(&username)
            .ok_or_else(|| format!("The user {username} does not exist."))?;
        user.replace_password(hash_password(password)?);
        self.save(&database)
    }

    pub fn remove(&self, username: &str) -> Result<(), String> {
        let _file_lock = self.lock()?;
        let username = normalize_username(username)?;
        let mut database = self
            .load()?
            .ok_or("No user database has been configured.")?;
        let user = database
            .users
            .get(&username)
            .ok_or_else(|| format!("The user {username} does not exist."))?;
        if user.role == Role::Admin
            && database
                .users
                .values()
                .filter(|user| user.role == Role::Admin)
                .count()
                == 1
        {
            return Err("The final administrator cannot be removed.".into());
        }
        database.users.remove(&username);
        self.save(&database)
    }

    fn verify(&self, username: &str, password: &str) -> Result<Option<UserSummary>, String> {
        let database = self.load()?;
        let normalized = normalize_username(username).ok();
        let stored = database.as_ref().and_then(|database| {
            normalized
                .as_ref()
                .and_then(|name| database.users.get(name))
        });
        let Some(stored) = stored else {
            let _ = hash_password(password)?;
            return Ok(None);
        };
        let verified = verify_password(&stored.password_hash, password)?;
        Ok(if verified {
            normalized.map(|username| UserSummary {
                username,
                role: stored.role,
            })
        } else {
            None
        })
    }

    fn load(&self) -> Result<Option<UserDatabase>, String> {
        let database: Option<UserDatabase> = load_json(&self.path, "user database")?;
        if let Some(database) = &database {
            database.validate()?;
        }
        Ok(database)
    }

    fn save(&self, database: &UserDatabase) -> Result<(), String> {
        database.validate()?;
        // Refuse to replace a database that became corrupt outside this process.
        self.load()?;
        save_json(&self.path, "users", database, PublishMode::Replace)
    }
}

pub fn normalize_username(value: &str) -> Result<String, String> {
    if value.trim() != value {
        return Err("Usernames cannot begin or end with whitespace.".into());
    }
    if !(3..=64).contains(&value.len()) {
        return Err(
            "Usernames must be 3-64 ASCII letters, numbers, periods, underscores or hyphens, and start with a letter or number."
                .into(),
        );
    }
    let username = value.to_ascii_lowercase();
    if !username
        .bytes()
        .next()
        .is_some_and(|byte| byte.is_ascii_alphanumeric())
        || !username
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        return Err(
            "Usernames must be 3-64 ASCII letters, numbers, periods, underscores or hyphens, and start with a letter or number."
                .into(),
        );
    }
    Ok(username)
}

pub fn validate_password(password: &str) -> Result<(), String> {
    if !(MIN_PASSWORD_BYTES..=MAX_PASSWORD_BYTES).contains(&password.len()) {
        return Err(format!(
            "Passwords must contain {MIN_PASSWORD_BYTES}-{MAX_PASSWORD_BYTES} UTF-8 bytes."
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub(crate) struct AuthenticatedUser {
    pub(crate) username: String,
    pub(crate) role: Role,
}

pub(crate) struct AuthService {
    store: UserStore,
    setup_lock: Mutex<()>,
    sessions: Mutex<SessionStore>,
    cookie_name: String,
}

impl AuthService {
    pub(crate) fn user_store(&self) -> &UserStore {
        &self.store
    }

    #[cfg(test)]
    pub(crate) fn new(store: UserStore) -> Result<Self, String> {
        Self::build(store, None, "notes_user_session_test".into())
    }

    pub(crate) fn new_scoped(store: UserStore, root: &Path) -> Result<Self, String> {
        let (path, cookie_name) = sessions::scope(store.path(), root)?;
        Self::build(store, Some(path), cookie_name)
    }

    fn build(
        store: UserStore,
        sessions_path: Option<PathBuf>,
        cookie_name: String,
    ) -> Result<Self, String> {
        let users = store.load()?;
        Ok(Self {
            store,
            setup_lock: Mutex::new(()),
            sessions: Mutex::new(SessionStore::load(sessions_path, users.as_ref())?),
            cookie_name,
        })
    }

    pub(crate) fn cookie_name(&self) -> &str {
        &self.cookie_name
    }

    pub(crate) fn setup_required(&self) -> Result<bool, String> {
        self.store.setup_required()
    }

    pub(crate) fn initialize_admin(
        &self,
        username: &str,
        password: &str,
    ) -> Result<Option<(AuthenticatedUser, String)>, String> {
        let _setup = self
            .setup_lock
            .lock()
            .map_err(|_| "The account setup lock is unavailable.")?;
        if !self.store.setup_required()? {
            return Ok(None);
        }
        let user = match self.store.initialize_admin(username, password) {
            Ok(user) => user,
            Err(error) => {
                if self.store.setup_required()? {
                    return Err(error);
                }
                return Ok(None);
            }
        };
        self.create_session(user).map(Some)
    }

    pub(crate) fn login(
        &self,
        username: &str,
        password: &str,
    ) -> Result<Option<(AuthenticatedUser, String)>, String> {
        self.store
            .verify(username, password)?
            .map(|user| self.create_session(user))
            .transpose()
    }

    pub(crate) fn authenticate(&self, token: &str) -> Option<AuthenticatedUser> {
        self.sessions.lock().ok()?.authenticate(token)
    }

    pub(crate) fn logout(&self, token: &str) -> Result<(), String> {
        self.sessions
            .lock()
            .map_err(|_| "The login session store is unavailable.")?
            .remove(token)
    }

    fn create_session(&self, user: UserSummary) -> Result<(AuthenticatedUser, String), String> {
        let database = self
            .store
            .load()?
            .ok_or("The user database is unavailable.")?;
        let stored = database
            .users
            .get(&user.username)
            .ok_or("The user no longer exists.")?;
        if stored.role != user.role {
            return Err("The account changed during login. Please log in again.".into());
        }
        let user = AuthenticatedUser {
            username: user.username,
            role: user.role,
        };
        let mut token = [0_u8; 32];
        getrandom::fill(&mut token)
            .map_err(|error| format!("Could not generate a login session: {error}"))?;
        let token = hex(&token);
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| "The login session store is unavailable.")?;
        sessions.insert(&token, user.clone(), &stored.password_hash)?;
        Ok((user, token))
    }
}

fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;

    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store(name: &str) -> (PathBuf, UserStore) {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("auth-{name}-{}", std::process::id()));
        fs::create_dir_all(&path).unwrap();
        let store = UserStore::new(path.join("users.json"));
        (path, store)
    }

    #[test]
    fn initial_admin_and_account_updates_preserve_required_roles() {
        let (path, store) = store("accounts");
        assert!(store.setup_required().unwrap());
        let admin = store
            .initialize_admin("Owner", "correct horse battery staple")
            .unwrap();
        assert_eq!(admin.username, "owner");
        assert_eq!(admin.role, Role::Admin);
        assert!(!store.setup_required().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(
            store
                .initialize_admin("other", "another secure password")
                .is_err()
        );
        store
            .add("writer", "writer password long enough", Role::User)
            .unwrap();
        store
            .set_password("writer", "replacement password long enough")
            .unwrap();
        assert_eq!(store.list().unwrap().len(), 2);
        assert!(store.remove("owner").is_err());
        store.remove("writer").unwrap();
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn concurrent_initial_setup_creates_exactly_one_administrator() {
        let (path, store) = store("setup-race");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let handles = ["first", "second"].map(|username| {
            let store = store.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.initialize_admin(username, "correct horse battery staple")
            })
        });
        barrier.wait();
        let results = handles.map(|handle| handle.join().unwrap());
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(store.list().unwrap().len(), 1);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn authentication_sessions_are_explicit_and_revocable() {
        let (path, store) = store("sessions");
        store
            .initialize_admin("admin", "correct horse battery staple")
            .unwrap();
        let auth = AuthService::new(store).unwrap();
        assert!(auth.login("admin", "wrong password").unwrap().is_none());
        assert!(auth.login("missing", "wrong password").unwrap().is_none());
        let (user, token) = auth
            .login("ADMIN", "correct horse battery staple")
            .unwrap()
            .unwrap();
        assert_eq!(user.username, "admin");
        assert_eq!(auth.authenticate(&token).unwrap().role, Role::Admin);
        auth.logout(&token).unwrap();
        assert!(auth.authenticate(&token).is_none());
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    #[ignore = "performance benchmark"]
    fn benchmark_session_authentication() {
        let (path, store) = store("session-benchmark");
        store
            .initialize_admin("benchmark", "benchmark password long enough")
            .unwrap();
        let auth = AuthService::new(store).unwrap();
        let user = AuthenticatedUser {
            username: "benchmark".into(),
            role: Role::Admin,
        };
        let summary = UserSummary {
            username: user.username.clone(),
            role: user.role,
        };
        let mut target = String::new();
        for _ in 0..1024 {
            target = auth.create_session(summary.clone()).unwrap().1;
        }
        for _ in 0..100 {
            std::hint::black_box(auth.authenticate(std::hint::black_box(&target)));
        }
        let mut runs = Vec::new();
        for _ in 0..8 {
            let started = std::time::Instant::now();
            for _ in 0..10_000 {
                std::hint::black_box(auth.authenticate(std::hint::black_box(&target)));
            }
            runs.push(started.elapsed().as_secs_f64() * 100.0);
        }
        runs.sort_by(f64::total_cmp);
        println!(
            "{{\"sessions\":1024,\"microsecondsPerLookup\":{:.3}}}",
            (runs[3] + runs[4]) / 2.0
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn usernames_and_passwords_have_stable_validation_rules() {
        for valid in ["abc", "first.last", "user_name", "user-123"] {
            assert!(normalize_username(valid).is_ok(), "{valid}");
        }
        for invalid in ["ab", " leading", "-leading", "name space", "用户"] {
            assert!(normalize_username(invalid).is_err(), "{invalid}");
        }
        assert!(validate_password("short").is_err());
        assert!(validate_password("long enough password").is_ok());
    }
}
