use sha2::{Digest, Sha256};

use super::{StoredUser, UserStore};

impl StoredUser {
    fn account_id(&self) -> String {
        self.identity.clone().unwrap_or_else(|| {
            Sha256::digest(self.password_hash.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        })
    }

    pub(super) fn replace_password(&mut self, hash: String) {
        self.identity = Some(self.account_id());
        self.password_hash = hash;
    }
}

impl UserStore {
    pub(crate) fn account_id(&self, username: &str) -> Result<String, String> {
        self.load()?
            .and_then(|database| database.users.get(username).map(StoredUser::account_id))
            .ok_or_else(|| "The account no longer exists.".into())
    }
}
