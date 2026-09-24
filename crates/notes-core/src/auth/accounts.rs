use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{File, OpenOptions},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroize;

use super::{
    AuthService, AuthenticatedUser, MAX_USERS, Role, StoredUser, UserStore, UserSummary,
    hash_password, hex, normalize_username, validate_password,
};

const MAX_INVITES: usize = 128;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Invitation {
    digest: String,
    created_by: String,
    created_at: u64,
    expires_at: u64,
    used_by: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InvitationSummary {
    id: String,
    created_by: String,
    expires_at: u64,
    used_by: Option<String>,
    expired: bool,
}

#[derive(Serialize)]
pub(crate) struct AccountOverview {
    users: Vec<UserSummary>,
    invitations: Vec<InvitationSummary>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum AccountAction {
    Invite { hours: u64 },
    RevokeInvite { id: String },
    Role { username: String, role: Role },
    Password { username: String, password: String },
    Delete { username: String },
}

#[derive(Serialize)]
pub(crate) struct AccountResult {
    pub accounts: Option<AccountOverview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_secs())
        .map_err(|error| format!("Invalid system clock: {error}"))
}
fn random(bytes: usize) -> Result<String, String> {
    let mut value = vec![0; bytes];
    getrandom::fill(&mut value)
        .map_err(|error| format!("Could not generate invitation: {error}"))?;
    Ok(hex(&value))
}
fn digest(value: &str) -> String {
    hex(&Sha256::digest(value.as_bytes()))
}

pub(super) fn validate_invitations(invites: &BTreeMap<String, Invitation>) -> Result<(), String> {
    if invites.len() > MAX_INVITES {
        return Err("Too many invitation records.".into());
    }
    for (id, invite) in invites {
        if id.len() != 24
            || !id.bytes().all(|b| b.is_ascii_hexdigit())
            || invite.digest.len() != 64
            || !invite.digest.bytes().all(|b| b.is_ascii_hexdigit())
            || normalize_username(&invite.created_by).is_err()
            || invite.expires_at < invite.created_at
        {
            return Err("The user database contains an invalid invitation.".into());
        }
    }
    Ok(())
}

impl UserStore {
    pub fn list(&self) -> Result<Vec<UserSummary>, String> {
        let Some(database) = self.load()? else {
            return Ok(Vec::new());
        };
        Ok(database
            .users
            .into_iter()
            .map(|(username, user)| UserSummary {
                username,
                role: user.role,
            })
            .collect())
    }

    pub(super) fn lock(&self) -> Result<File, String> {
        let parent = self
            .path
            .parent()
            .ok_or("The user database has no parent folder.")?;
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(self.path.with_extension("lock"))
            .map_err(|error| error.to_string())?;
        file.lock_exclusive()
            .map_err(|error| format!("Could not lock the user database: {error}"))?;
        Ok(file)
    }

    fn overview(&self, actor: &str) -> Result<AccountOverview, String> {
        let database = self.load()?.ok_or("The user database is unavailable.")?;
        if !database
            .users
            .get(actor)
            .is_some_and(|user| user.role == Role::Admin)
        {
            return Err("Administrator access is required.".into());
        }
        let now = now()?;
        Ok(AccountOverview {
            users: database
                .users
                .into_iter()
                .map(|(username, user)| UserSummary {
                    username,
                    role: user.role,
                })
                .collect(),
            invitations: database
                .invitations
                .into_iter()
                .map(|(id, invitation)| InvitationSummary {
                    id,
                    created_by: invitation.created_by,
                    expires_at: invitation.expires_at,
                    used_by: invitation.used_by,
                    expired: invitation.expires_at <= now,
                })
                .collect(),
        })
    }

    fn register(&self, code: &str, username: &str, password: &str) -> Result<UserSummary, String> {
        let username = normalize_username(username)?;
        validate_password(password)?;
        let (id, secret) = code
            .split_once('.')
            .ok_or("Invalid, expired or already used invitation.")?;
        if id.len() != 24 || secret.len() != 64 {
            return Err("Invalid, expired or already used invitation.".into());
        }
        let _lock = self.lock()?;
        let mut database = self
            .load()?
            .ok_or("The administrator must initialize Notes first.")?;
        let invite = database
            .invitations
            .get_mut(id)
            .ok_or("Invalid, expired or already used invitation.")?;
        let supplied = digest(secret);
        let mismatch = supplied
            .bytes()
            .zip(invite.digest.bytes())
            .fold(0, |difference, (a, b)| difference | (a ^ b));
        if mismatch != 0 || invite.used_by.is_some() || invite.expires_at <= now()? {
            return Err("Invalid, expired or already used invitation.".into());
        }
        if database.users.len() >= MAX_USERS {
            return Err("The account limit has been reached.".into());
        }
        if database.users.contains_key(&username) {
            return Err("That username already exists.".into());
        }
        let password_hash = hash_password(password)?;
        invite.used_by = Some(username.clone());
        database.users.insert(
            username.clone(),
            StoredUser {
                password_hash,
                role: Role::User,
                identity: None,
            },
        );
        // Consuming the invitation and creating the account are one atomic publication.
        self.save(&database)?;
        Ok(UserSummary {
            username,
            role: Role::User,
        })
    }

    fn account_action(
        &self,
        actor: &str,
        mut action: AccountAction,
    ) -> Result<(Option<String>, Option<String>), String> {
        let _lock = self.lock()?;
        let mut database = self.load()?.ok_or("The user database is unavailable.")?;
        if !database
            .users
            .get(actor)
            .is_some_and(|user| user.role == Role::Admin)
        {
            return Err("Administrator access is required.".into());
        }
        let mut code = None;
        let mut revoke_user = None;
        match &mut action {
            AccountAction::Invite { hours } => {
                if !(1..=168).contains(hours) {
                    return Err("Invitation lifetime must be 1 to 168 hours.".into());
                }
                let now = now()?;
                database
                    .invitations
                    .retain(|_, invite| invite.used_by.is_none() && invite.expires_at > now);
                if database.invitations.len() >= MAX_INVITES {
                    return Err("Revoke an unused invitation before creating more.".into());
                }
                let id = random(12)?;
                let secret = random(32)?;
                database.invitations.insert(
                    id.clone(),
                    Invitation {
                        digest: digest(&secret),
                        created_by: actor.into(),
                        created_at: now,
                        expires_at: now + *hours * 3600,
                        used_by: None,
                    },
                );
                code = Some(format!("{id}.{secret}"));
            }
            AccountAction::RevokeInvite { id } => {
                if database.invitations.remove(id).is_none() {
                    return Err("The invitation no longer exists.".into());
                }
            }
            AccountAction::Role { username, role } => {
                let username = normalize_username(username)?;
                let user = database
                    .users
                    .get(&username)
                    .ok_or("The account does not exist.")?;
                if user.role == Role::Admin
                    && *role != Role::Admin
                    && database
                        .users
                        .values()
                        .filter(|user| user.role == Role::Admin)
                        .count()
                        == 1
                {
                    return Err("The final administrator cannot be demoted.".into());
                }
                database
                    .users
                    .get_mut(&username)
                    .ok_or("The account does not exist.")?
                    .role = *role;
                revoke_user = Some(username);
            }
            AccountAction::Delete { username } => {
                let username = normalize_username(username)?;
                let user = database
                    .users
                    .get(&username)
                    .ok_or("The account does not exist.")?;
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
                revoke_user = Some(username);
            }
            AccountAction::Password { username, password } => {
                let validated = validate_password(password);
                let hashed = validated.and_then(|_| hash_password(password));
                password.zeroize();
                let username = normalize_username(username)?;
                database
                    .users
                    .get_mut(&username)
                    .ok_or("The account does not exist.")?
                    .replace_password(hashed?);
                revoke_user = Some(username);
            }
        }
        self.save(&database)?;
        Ok((code, revoke_user))
    }
}

impl AuthService {
    pub(crate) fn register_invited(
        &self,
        code: &str,
        username: &str,
        password: &str,
    ) -> Result<(AuthenticatedUser, String), String> {
        let _lock = self
            .setup_lock
            .lock()
            .map_err(|_| "Account management is unavailable.")?;
        self.create_session(self.store.register(code, username, password)?)
    }

    pub(crate) fn accounts(&self, actor: &str) -> Result<AccountOverview, String> {
        self.store.overview(actor)
    }

    pub(crate) fn manage_account(
        &self,
        actor: &str,
        action: AccountAction,
    ) -> Result<AccountResult, String> {
        let _lock = self
            .setup_lock
            .lock()
            .map_err(|_| "Account management is unavailable.")?;
        let (code, revoke) = self.store.account_action(actor, action)?;
        if let Some(username) = revoke {
            self.sessions
                .lock()
                .map_err(|_| "Session management is unavailable.")?
                .revoke_user(&username)?;
        }
        let accounts = if self
            .store
            .list()?
            .iter()
            .any(|user| user.username == actor && user.role == Role::Admin)
        {
            Some(self.store.overview(actor)?)
        } else {
            None
        };
        Ok(AccountResult { accounts, code })
    }
}
