use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{Error as PasswordHashError, SaltString},
};

pub(crate) fn hash_password(password: &str) -> Result<String, String> {
    let mut salt = [0_u8; 16];
    getrandom::fill(&mut salt)
        .map_err(|error| format!("Could not generate a password salt: {error}"))?;
    let salt = SaltString::encode_b64(&salt)
        .map_err(|error| format!("Could not encode a password salt: {error}"))?;
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| format!("Could not hash the password: {error}"))
}

pub(crate) fn verify_password(hash: &str, password: &str) -> Result<bool, String> {
    let hash = PasswordHash::new(hash)
        .map_err(|error| format!("Invalid stored password hash: {error}"))?;
    match Argon2::default().verify_password(password.as_bytes(), &hash) {
        Ok(()) => Ok(true),
        Err(PasswordHashError::Password) => Ok(false),
        Err(error) => Err(format!("Could not verify the password: {error}")),
    }
}
