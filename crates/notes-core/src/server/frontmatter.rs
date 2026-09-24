const MAX_FRONTMATTER_BYTES: usize = 64 * 1024;

pub(super) fn title_from_reader(reader: impl std::io::Read) -> std::io::Result<Option<String>> {
    use std::io::{BufReader, Read};
    let mut header = Vec::new();
    let mut line_start = 0;
    let mut opened = false;
    let mut previous_cr = false;
    let bom = "\u{feff}".as_bytes();
    let reader = BufReader::with_capacity(1024, reader.take((MAX_FRONTMATTER_BYTES + 1) as u64));
    for byte in reader.bytes() {
        let byte = byte?;
        header.push(byte);
        if header.len() > MAX_FRONTMATTER_BYTES {
            return Ok(None);
        }
        if !opened {
            let opening = header.strip_prefix(bom).unwrap_or(&header);
            if opening.len() <= 3 {
                if !b"---".starts_with(opening) && !bom.starts_with(&header) {
                    return Ok(None);
                }
            } else if !matches!(byte, b' ' | b'\t' | b'\r' | b'\n') {
                return Ok(None);
            }
        }
        if byte == b'\n' && previous_cr {
            line_start = header.len();
            previous_cr = false;
            continue;
        }
        previous_cr = byte == b'\r';
        if !matches!(byte, b'\r' | b'\n') {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&header[line_start..header.len() - 1]) else {
            return Ok(None);
        };
        if !opened {
            if line
                .strip_prefix('\u{feff}')
                .unwrap_or(line)
                .trim_end_matches([' ', '\t'])
                != "---"
            {
                return Ok(None);
            }
            opened = true;
        } else if closing_fence(line) {
            return Ok(std::str::from_utf8(&header).ok().and_then(title));
        }
        line_start = header.len();
    }
    if opened && std::str::from_utf8(&header[line_start..]).is_ok_and(closing_fence) {
        Ok(std::str::from_utf8(&header).ok().and_then(title))
    } else {
        Ok(None)
    }
}

pub(super) fn body(content: &str) -> &str {
    split(content).map_or_else(
        || content.strip_prefix('\u{feff}').unwrap_or(content),
        |frontmatter| frontmatter.body,
    )
}

pub(super) fn title(content: &str) -> Option<String> {
    let frontmatter = split(content)?;
    if frontmatter.yaml.len() > MAX_FRONTMATTER_BYTES {
        return None;
    }
    let value: serde_yaml_ng::Value = serde_yaml_ng::from_str(frontmatter.yaml).ok()?;
    let mapping = value.as_mapping()?;
    let title = mapping.get(serde_yaml_ng::Value::String("title".into()))?;
    let title = match title {
        serde_yaml_ng::Value::String(value) => value.clone(),
        serde_yaml_ng::Value::Number(value) => value.to_string(),
        _ => return None,
    };
    let title = title.trim();
    if title.is_empty() || title.chars().count() > 200 || title.chars().any(char::is_control) {
        None
    } else {
        Some(title.to_owned())
    }
}

pub(super) fn metadata(content: &str) -> &str {
    split(content).map(|parts| parts.yaml).unwrap_or("")
}

pub(super) fn tags(content: &str) -> Result<Vec<String>, String> {
    let Some(parts) = split(content) else {
        return Ok(Vec::new());
    };
    if parts.yaml.len() > MAX_FRONTMATTER_BYTES {
        return Err("Metadata exceeds the 64 KiB tag indexing limit.".into());
    }
    let value: serde_yaml_ng::Value =
        serde_yaml_ng::from_str(parts.yaml).map_err(|error| format!("Invalid YAML: {error}"))?;
    let Some(mapping) = value.as_mapping() else {
        if value.is_null() {
            return Ok(Vec::new());
        }
        return Err("Metadata must be a YAML mapping.".into());
    };
    let mut tags = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for key in ["tags", "tag"] {
        let Some(value) = mapping.get(serde_yaml_ng::Value::String(key.into())) else {
            continue;
        };
        let values = match value {
            serde_yaml_ng::Value::Null => continue,
            serde_yaml_ng::Value::Sequence(values) => values.as_slice(),
            value => std::slice::from_ref(value),
        };
        for value in values {
            let value = value
                .as_str()
                .ok_or("Tags must be strings; quote numeric tags in YAML.")?;
            let value = value.trim().strip_prefix('#').unwrap_or(value.trim());
            if value.is_empty()
                || value.encode_utf16().count() > 80
                || value.chars().any(char::is_control)
            {
                return Err(
                    "Each tag must contain 1-80 characters without control characters.".into(),
                );
            }
            if seen.insert(value.to_lowercase()) {
                tags.push(value.to_owned());
            }
            if tags.len() > 64 {
                return Err("A note can have at most 64 tags.".into());
            }
        }
    }
    Ok(tags)
}

struct FrontMatter<'a> {
    yaml: &'a str,
    body: &'a str,
}

fn split(content: &str) -> Option<FrontMatter<'_>> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let (opening, mut remaining) = next_line(content);
    if opening.trim_end_matches([' ', '\t']) != "---" || remaining.is_empty() {
        return None;
    }
    let yaml_start = content.len() - remaining.len();
    while !remaining.is_empty() {
        let line_start = content.len() - remaining.len();
        let (line, tail) = next_line(remaining);
        if closing_fence(line) {
            return Some(FrontMatter {
                yaml: &content[yaml_start..line_start],
                body: tail.trim_start_matches(['\r', '\n']),
            });
        }
        remaining = tail;
    }
    None
}

fn closing_fence(line: &str) -> bool {
    matches!(line.trim_end_matches([' ', '\t']), "---" | "...")
}

fn next_line(text: &str) -> (&str, &str) {
    let end = text.find(['\r', '\n']).unwrap_or(text.len());
    let ending = &text[end..];
    let newline = if ending.starts_with("\r\n") {
        2
    } else if ending.is_empty() {
        0
    } else {
        1
    };
    (&text[..end], &text[end + newline..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct CountingReader<'a> {
        remaining: &'a [u8],
        bytes: usize,
        chunk: usize,
    }
    impl Read for CountingReader<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = buffer.len().min(self.remaining.len()).min(self.chunk);
            buffer[..count].copy_from_slice(&self.remaining[..count]);
            self.remaining = &self.remaining[count..];
            self.bytes += count;
            Ok(count)
        }
    }

    #[test]
    fn streamed_titles_stop_after_metadata_and_support_all_line_endings() {
        let label = "\u{6280}\u{672f}\u{7b14}\u{8bb0}";
        for ending in ["\n", "\r\n", "\r"] {
            for closing in ["---", "...", "--- \t", "... \t"] {
                let header =
                    format!("\u{feff}--- \t{ending}title: \"{label}\"{ending}{closing}{ending}");
                let content = format!("{header}{}", "# Body\n".repeat(30_000));
                for chunk in [1, 1024] {
                    let mut reader = CountingReader {
                        remaining: content.as_bytes(),
                        bytes: 0,
                        chunk,
                    };
                    assert_eq!(title_from_reader(&mut reader).unwrap(), Some(label.into()));
                    assert!(reader.bytes <= 1024);
                }
            }
        }
        let source = format!("# No metadata {}", "x".repeat(100_000));
        let mut reader = CountingReader {
            remaining: source.as_bytes(),
            bytes: 0,
            chunk: 1024,
        };
        assert_eq!(title_from_reader(&mut reader).unwrap(), None);
        assert!(reader.bytes <= 1024);
    }

    #[test]
    fn streamed_title_limits_do_not_turn_a_truncated_line_into_a_fence() {
        let prefix = "---\ntitle: Boundary\n# ";
        let header = format!(
            "{prefix}{}\n---",
            "x".repeat(MAX_FRONTMATTER_BYTES - prefix.len() - 4)
        );
        assert_eq!(header.len(), MAX_FRONTMATTER_BYTES);
        assert_eq!(
            title_from_reader(header.as_bytes()).unwrap(),
            Some("Boundary".into())
        );
        let overflow = format!("{header}x");
        let mut reader = CountingReader {
            remaining: overflow.as_bytes(),
            bytes: 0,
            chunk: 1024,
        };
        assert_eq!(title_from_reader(&mut reader).unwrap(), None);
        assert!(reader.bytes <= MAX_FRONTMATTER_BYTES + 1);
        for source in [
            "---",
            "---\n",
            " ---\ntitle: Not metadata\n---\n",
            "---\ntitle: [broken\n---\n",
            "---\ntitle: true\n---\n",
            "---\ntitle: >-\n  A folded\n  title\n...\nBody",
        ] {
            assert_eq!(title_from_reader(source.as_bytes()).unwrap(), title(source));
        }
        assert_eq!(
            title_from_reader(&b"---\ntitle: \xff\n---\n"[..]).unwrap(),
            None
        );
    }

    #[test]
    fn extracts_only_safe_frontmatter_titles() {
        assert_eq!(
            title("---\ntitle: \"Displayed title\"\n---\n# Body"),
            Some("Displayed title".into())
        );
        assert_eq!(title("---\ntitle: 42\n...\nBody"), Some("42".into()));
        assert_eq!(title("# Body\n\ntitle: Not metadata"), None);
        assert_eq!(title("---\ntitle: [broken\n---\nBody"), None);
        assert_eq!(title("---\ntitle: true\n---\nBody"), None);
    }
}
