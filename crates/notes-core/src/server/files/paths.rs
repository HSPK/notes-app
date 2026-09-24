use percent_encoding::percent_decode_str;

use super::ApiError;

const MAX_PATH_BYTES: usize = 2048;

pub(in crate::server) fn is_markdown(path: &str) -> bool {
    matches!(
        path.rsplit_once('.')
            .map(|(_, extension)| extension.to_ascii_lowercase())
            .as_deref(),
        Some("md" | "markdown")
    )
}

pub(in crate::server) fn validate_document_path(path: &str) -> Result<(), ApiError> {
    validate_relative(path)?;
    if !is_markdown(path) {
        return Err(ApiError::bad_request("Choose a .md or .markdown file."));
    }
    Ok(())
}

pub(in crate::server) fn validate_directory_path(path: &str) -> Result<(), ApiError> {
    validate_relative(path)?;
    let name = path.rsplit('/').next().unwrap_or(path);
    if ignored_directory(name) {
        return Err(ApiError::forbidden(
            "Hidden and dependency folders cannot be created or moved.",
        ));
    }
    Ok(())
}

pub(in crate::server) fn validate_relative(path: &str) -> Result<(), ApiError> {
    validate_path_syntax(path)?;
    // Query extraction already decodes once. Reject dangerous additional encodings
    // without changing legitimate file names that contain a literal percent sign.
    let mut candidate = path.to_owned();
    for _ in 0..4 {
        let decoded = percent_decode_str(&candidate)
            .decode_utf8()
            .map_err(|_| ApiError::bad_request("The path has an invalid percent encoding."))?;
        if decoded == candidate {
            return Ok(());
        }
        validate_path_syntax(&decoded)?;
        candidate = decoded.into_owned();
    }
    Err(ApiError::bad_request(
        "The path has too many layers of percent encoding.",
    ))
}

fn validate_path_syntax(path: &str) -> Result<(), ApiError> {
    if path.is_empty() || path.len() > MAX_PATH_BYTES {
        return Err(ApiError::bad_request(
            "The relative path is empty or too long.",
        ));
    }
    if path.chars().any(|character| {
        character.is_control()
            || matches!(character, '\\' | ':' | '<' | '>' | '"' | '|' | '?' | '*')
    }) {
        return Err(ApiError::forbidden(
            "Absolute, device, stream, and backslash paths are not allowed.",
        ));
    }
    let components = path.split('/').collect::<Vec<_>>();
    if components.len() > 64 {
        return Err(ApiError::bad_request(
            "The relative path has too many folders.",
        ));
    }
    for (index, component) in components.iter().enumerate() {
        if component.is_empty()
            || matches!(*component, "." | "..")
            || component.ends_with(['.', ' '])
            || reserved_name(component)
        {
            return Err(ApiError::forbidden(
                "Path traversal and reserved file names are not allowed.",
            ));
        }
        if index + 1 < components.len() && ignored_directory(component) {
            return Err(ApiError::forbidden(
                "Hidden and dependency folders are not accessible.",
            ));
        }
    }
    Ok(())
}

pub(super) fn ignored_directory(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "node_modules"
                | "target"
                | "venv"
                | "__pycache__"
                | "build"
                | "dist"
                | "$recycle.bin"
                | "system volume information"
        )
}

fn reserved_name(name: &str) -> bool {
    let base = name
        .split('.')
        .next()
        .unwrap_or("")
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
        || ["COM", "LPT"].iter().any(|prefix| {
            base.strip_prefix(prefix).is_some_and(|suffix| {
                matches!(
                    suffix,
                    "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
                )
            })
        })
}
