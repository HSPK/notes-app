use super::room::normalize;

pub(super) fn serialize(original: &str, next: &str) -> String {
    let before = normalize(original);
    if before == next {
        return original.to_owned();
    }
    let raw = original.strip_prefix('\u{feff}').unwrap_or(original);
    let mut prefix = 0;
    for (a, b) in before.chars().zip(next.chars()) {
        if a != b {
            break;
        }
        prefix += a.len_utf8();
    }
    let mut old_end = before.len();
    let mut new_end = next.len();
    for (a, b) in before[prefix..]
        .chars()
        .rev()
        .zip(next[prefix..].chars().rev())
    {
        if a != b {
            break;
        }
        old_end -= a.len_utf8();
        new_end -= b.len_utf8();
    }
    let raw_offset = |target: usize| {
        let mut raw_index = 0;
        let mut normalized = 0;
        let bytes = raw.as_bytes();
        while normalized < target {
            raw_index += if bytes[raw_index] == b'\r' && bytes.get(raw_index + 1) == Some(&b'\n') {
                2
            } else {
                1
            };
            normalized += 1;
        }
        raw_index
    };
    let mut counts = [0; 3];
    let mut first = None;
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let ending = match bytes[i] {
            b'\r' if bytes.get(i + 1) == Some(&b'\n') => {
                i += 1;
                Some(1)
            }
            b'\r' => Some(2),
            b'\n' => Some(0),
            _ => None,
        };
        if let Some(ending) = ending {
            counts[ending] += 1;
            first.get_or_insert(ending);
        }
        i += 1;
    }
    let mut dominant = first.unwrap_or(0);
    for index in 0..3 {
        if counts[index] > counts[dominant] {
            dominant = index;
        }
    }
    let mut change = next[prefix..new_end].replace('\n', ["\n", "\r\n", "\r"][dominant]);
    let left = &raw[..raw_offset(prefix)];
    let right = &raw[raw_offset(old_end)..];
    if change.is_empty() {
        if left.ends_with('\r') && right.starts_with('\n') {
            change.push('\r');
        }
    } else {
        if left.ends_with('\r') && change.starts_with('\n') {
            change.insert(0, '\r');
        }
        if change.ends_with('\r') && right.starts_with('\n') {
            change.push('\n');
        }
    }
    format!(
        "{}{left}{change}{right}",
        if original.starts_with('\u{feff}') {
            "\u{feff}"
        } else {
            ""
        }
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_edits_preserve_metadata_and_mixed_newlines() {
        let source = "---\r\ntitle: Old\n---\r\n\r\n# Body\nOne\r\nTwo\rThree\n";
        assert_eq!(
            serialize(source, &normalize(source).replace("Old", "New")),
            source.replace("Old", "New")
        );
        assert_eq!(
            serialize(source, &normalize(source).replace("Two", "中文")),
            source.replace("Two", "中文")
        );
        assert_eq!(serialize(source, &normalize(source)), source);
    }
}
