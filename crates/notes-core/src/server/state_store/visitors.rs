use super::{ApiError, ProjectStore, db_error, now};
use rusqlite::{OptionalExtension, params};
use sha2::{Digest, Sha256};

fn fingerprint(value: &str) -> String {
    crate::server::hex(&Sha256::digest(value.as_bytes()))
}

impl ProjectStore {
    pub(in crate::server) fn visitor(
        &self,
        token: &str,
        link: &str,
        password: &str,
    ) -> Result<Option<String>, ApiError> {
        self.store.with_read(|connection| {
            let digest = fingerprint(token);
            let valid: Option<i64> = connection
                .query_row(
                    "SELECT expires FROM public_sessions
                WHERE digest=?1 AND project=?2 AND link=?3 AND password=?4",
                    params![digest, self.project, link, password],
                    |row| row.get(0),
                )
                .optional()
                .map_err(db_error)?;
            let time = now()?;
            Ok(valid
                .filter(|expires| *expires > time)
                .map(|_| format!("Guest {}", &digest[..8])))
        })
    }

    pub(in crate::server) fn issue_visitor(
        &self,
        link: &str,
        password: &str,
        deadline: Option<i64>,
    ) -> Result<(String, i64), ApiError> {
        let created = now()?;
        let expires = deadline
            .unwrap_or(i64::MAX)
            .min(created + 12 * 60 * 60 * 1000);
        if expires <= created {
            return Err(ApiError::forbidden("This public link has expired."));
        }
        let mut random = [0; 24];
        getrandom::fill(&mut random).map_err(|error| ApiError::internal(error.to_string()))?;
        let token = crate::server::hex(&random);
        self.store.with(|connection| {
            connection.execute("DELETE FROM public_sessions WHERE expires<=?1", [created]).map_err(db_error)?;
            let count: usize = connection.query_row("SELECT COUNT(*) FROM public_sessions WHERE project=?1",
                [&self.project], |row| row.get(0)).map_err(db_error)?;
            if count >= 4096 { return Err(ApiError::conflict("Too many active visitor sessions. Try again after older sessions expire.")); }
            connection.execute("INSERT INTO public_sessions(digest,project,link,password,created,expires) VALUES (?1,?2,?3,?4,?5,?6)",
                params![fingerprint(&token),self.project,link,password,created,expires]).map_err(db_error)?;
            Ok((token,expires))
        })
    }
}
