use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{AuthenticatedUser, UserDatabase, hex};
use crate::storage::{PublishMode, load_json, save_json};

const DATABASE_VERSION: u32 = 1;
const MAX_SESSIONS: usize = 1024;
pub(crate) const SESSION_TTL_SECONDS: u64 = 12 * 60 * 60;

pub(super) fn scope(store: &Path, root: &Path) -> Result<(PathBuf, String), String> {
    let store = if store.is_absolute() {
        store.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(store)
    };
    let mut digest = Sha256::new();
    digest.update(store.to_string_lossy().as_bytes());
    digest.update([0]);
    digest.update(root.to_string_lossy().as_bytes());
    let scope = hex(&digest.finalize());
    Ok((
        store.with_file_name(format!("sessions-{}.json", &scope[..16])),
        format!("notes_user_session_{}", &scope[..16]),
    ))
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Session {
    user: AuthenticatedUser,
    expires_at: u64,
    credential_hash: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SessionDatabase {
    version: u32,
    sessions: HashMap<String, Session>,
}

pub(super) struct SessionStore {
    path: Option<PathBuf>,
    sessions: HashMap<String, Session>,
    active: HashMap<String, Session>,
    next_expiry: Option<u64>,
}

impl Default for SessionStore {
    fn default() -> Self {
        Self {
            path: None,
            sessions: HashMap::new(),
            active: HashMap::new(),
            next_expiry: None,
        }
    }
}

impl SessionStore {
    pub(super) fn revoke_user(&mut self, username: &str) -> Result<(), String> {
        self.sessions
            .retain(|_, session| session.user.username != username);
        self.active
            .retain(|_, session| session.user.username != username);
        self.update_next_expiry();
        self.persist(&self.sessions)
    }
    pub(super) fn load(
        path: Option<PathBuf>,
        users: Option<&UserDatabase>,
    ) -> Result<Self, String> {
        let now = unix_time();
        let allowed = users
            .into_iter()
            .flat_map(|database| database.users.iter())
            .map(|(name, user)| (name.as_str(), (user.role, token_hash(&user.password_hash))))
            .collect::<HashMap<_, _>>();
        let mut sessions = match path.as_deref() {
            Some(path) => load_json::<SessionDatabase>(path, "sessions")?
                .map(|database| {
                    if database.version != DATABASE_VERSION {
                        return Err(format!(
                            "Unsupported session database version {}.",
                            database.version
                        ));
                    }
                    if database.sessions.len() > MAX_SESSIONS {
                        return Err(format!(
                            "The session database cannot contain more than {MAX_SESSIONS} entries."
                        ));
                    }
                    Ok(database.sessions)
                })
                .transpose()?
                .unwrap_or_default(),
            None => HashMap::new(),
        };
        for token in sessions.keys() {
            if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err("The session database contains an invalid token hash.".into());
            }
        }
        sessions.retain(|_, session| {
            session.expires_at > now
                && session.expires_at <= now + SESSION_TTL_SECONDS
                && allowed
                    .get(session.user.username.as_str())
                    .is_some_and(|(role, credential)| {
                        *role == session.user.role && *credential == session.credential_hash
                    })
        });
        let next_expiry = sessions.values().map(|session| session.expires_at).min();
        Ok(Self {
            path,
            sessions,
            active: HashMap::new(),
            next_expiry,
        })
    }

    pub(super) fn authenticate(&mut self, token: &str) -> Option<AuthenticatedUser> {
        if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let now = unix_time();
        self.prune_expired(now);
        if let Some(session) = self.active.get(token) {
            return Some(session.user.clone());
        }
        let session = self.sessions.get(&token_hash(token))?.clone();
        let user = session.user.clone();
        self.active.insert(token.to_owned(), session);
        Some(user)
    }

    pub(super) fn insert(
        &mut self,
        token: &str,
        user: AuthenticatedUser,
        password_hash: &str,
    ) -> Result<(), String> {
        let now = unix_time();
        let mut sessions = self.sessions.clone();
        sessions.retain(|_, session| session.expires_at > now);
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, session)| session.expires_at)
                .map(|(token, _)| token.clone())
            {
                sessions.remove(&oldest);
            }
        }
        let session = Session {
            user,
            expires_at: now + SESSION_TTL_SECONDS,
            credential_hash: token_hash(password_hash),
        };
        sessions.insert(token_hash(token), session.clone());
        self.persist(&sessions)?;
        self.sessions = sessions;
        self.active
            .retain(|token, _| self.sessions.contains_key(&token_hash(token)));
        self.active.insert(token.to_owned(), session);
        self.update_next_expiry();
        Ok(())
    }

    pub(super) fn remove(&mut self, token: &str) -> Result<(), String> {
        let key = token_hash(token);
        if !self.sessions.contains_key(&key) {
            return Ok(());
        }
        let mut sessions = self.sessions.clone();
        sessions.remove(&key);
        self.persist(&sessions)?;
        self.sessions = sessions;
        self.active.remove(token);
        self.update_next_expiry();
        Ok(())
    }

    fn prune_expired(&mut self, now: u64) {
        if self.next_expiry.is_none_or(|expires| expires > now) {
            return;
        }
        self.sessions.retain(|_, session| session.expires_at > now);
        self.active.retain(|_, session| session.expires_at > now);
        self.update_next_expiry();
    }

    fn update_next_expiry(&mut self) {
        self.next_expiry = self
            .sessions
            .values()
            .map(|session| session.expires_at)
            .min();
    }

    fn persist(&self, sessions: &HashMap<String, Session>) -> Result<(), String> {
        let Some(path) = &self.path else {
            return Ok(());
        };
        load_json::<SessionDatabase>(path, "sessions")?;
        save_json(
            path,
            "sessions",
            &SessionDatabase {
                version: DATABASE_VERSION,
                sessions: sessions.clone(),
            },
            PublishMode::Replace,
        )
    }
}

fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn unix_time() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::Role;

    fn user() -> AuthenticatedUser {
        AuthenticatedUser {
            username: "tester".into(),
            role: Role::User,
        }
    }

    #[test]
    fn expiration_capacity_and_revocation_are_enforced() {
        let now = unix_time();
        let mut store = SessionStore::default();
        let expired = "e".repeat(64);
        let active = "a".repeat(64);
        store.sessions.insert(
            token_hash(&expired),
            Session {
                user: user(),
                expires_at: now - 1,
                credential_hash: token_hash("credential"),
            },
        );
        store.sessions.insert(
            token_hash(&active),
            Session {
                user: user(),
                expires_at: now + SESSION_TTL_SECONDS,
                credential_hash: token_hash("credential"),
            },
        );
        store.next_expiry = Some(now - 1);
        assert!(store.authenticate(&active).is_some());
        assert!(!store.sessions.contains_key(&token_hash(&expired)));
        store.remove(&active).unwrap();
        assert!(store.authenticate(&active).is_none());

        for index in 0..=MAX_SESSIONS {
            store
                .insert(&format!("{index:064x}"), user(), "credential")
                .unwrap();
        }
        assert_eq!(store.sessions.len(), MAX_SESSIONS);
        assert!(
            store
                .authenticate(&format!("{MAX_SESSIONS:064x}"))
                .is_some()
        );
    }
}
