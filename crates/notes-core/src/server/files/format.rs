use super::{ApiError, BOM, validate_content};

pub(super) fn preserve_format(original: &[u8], content: &str) -> Result<Vec<u8>, ApiError> {
    let has_bom = original.starts_with(BOM) || content.starts_with('\u{feff}');
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let original = std::str::from_utf8(original)
        .map_err(|_| ApiError::bad_request("The original document is not valid UTF-8."))?;
    let bytes = original.as_bytes();
    let only_crlf = bytes.contains(&b'\n')
        && bytes.iter().enumerate().all(|(index, byte)| match byte {
            b'\n' => index > 0 && bytes[index - 1] == b'\r',
            b'\r' => bytes.get(index + 1) == Some(&b'\n'),
            _ => true,
        });
    let content = if only_crlf && !content.contains('\r') {
        content.replace('\n', "\r\n")
    } else if bytes.contains(&b'\r') && !bytes.contains(&b'\n') && !content.contains('\r') {
        content.replace('\n', "\r")
    } else {
        content.to_owned()
    };
    let mut result = Vec::with_capacity(content.len() + if has_bom { BOM.len() } else { 0 });
    if has_bom {
        result.extend_from_slice(BOM);
    }
    result.extend_from_slice(content.as_bytes());
    validate_content(&result)?;
    Ok(result)
}
