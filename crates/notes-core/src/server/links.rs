use super::{ApiError, AppState, Work, frontmatter, markdown, routes::blocking};
use axum::{
    Json,
    extract::{Extension, Query},
};
use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeSet, ops::Range, sync::Arc};

pub(super) fn targets(path: &str, source: &str) -> BTreeSet<String> {
    Parser::new_ext(frontmatter::body(source), Options::all())
        .filter_map(|event| match event {
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                ..
            }) => markdown::local_reference(
                path,
                &dest_url,
                false,
                matches!(link_type, LinkType::WikiLink { .. }),
            ),
            _ => None,
        })
        .collect()
}

#[derive(Clone)]
struct LinkSpan {
    range: Range<usize>,
    destination: String,
    wiki: bool,
    image: bool,
    definition: bool,
}

fn spans(source: &str) -> Vec<LinkSpan> {
    let body = frontmatter::body(source);
    let offset = source.len() - body.len();
    let parser = Parser::new_ext(body, Options::all());
    let mut spans = parser
        .reference_definitions()
        .iter()
        .map(|(_, definition)| LinkSpan {
            range: definition.span.start + offset..definition.span.end + offset,
            destination: definition.dest.to_string(),
            wiki: false,
            image: false,
            definition: true,
        })
        .collect::<Vec<_>>();
    for (event, range) in parser.into_offset_iter() {
        let (destination, link_type, image) = match event {
            Event::Start(Tag::Link {
                dest_url,
                link_type,
                ..
            }) => (dest_url, link_type, false),
            Event::Start(Tag::Image {
                dest_url,
                link_type,
                ..
            }) => (dest_url, link_type, true),
            _ => continue,
        };
        if !matches!(link_type, LinkType::Inline | LinkType::WikiLink { .. }) {
            continue;
        }
        spans.push(LinkSpan {
            range: range.start + offset..range.end + offset,
            destination: destination.into_string(),
            wiki: matches!(link_type, LinkType::WikiLink { .. }),
            image,
            definition: false,
        });
    }
    spans
}

fn destination_range(source: &str, link: &LinkSpan) -> Result<Range<usize>, ApiError> {
    let raw = &source[link.range.clone()];
    if link.wiki {
        let opening = raw
            .find("[[")
            .ok_or_else(|| ApiError::bad_request("Unsupported wiki link spelling."))?
            + 2;
        let tail = &raw[opening..];
        let end = tail
            .find('|')
            .or_else(|| tail.find("]]"))
            .ok_or_else(|| ApiError::bad_request("Incomplete wiki link."))?;
        return Ok(link.range.start + opening..link.range.start + opening + end);
    }
    let start = if link.definition {
        raw.find("]:").map(|position| position + 2)
    } else {
        raw.rfind("](").map(|position| position + 2)
    }
    .ok_or_else(|| {
        ApiError::bad_request("This link syntax cannot be safely renamed automatically.")
    })?;
    let start = start + raw[start..].len() - raw[start..].trim_start().len();
    let angle = raw.as_bytes().get(start) == Some(&b'<');
    let from = start + usize::from(angle);
    let mut end = from;
    let mut depth = 0;
    let mut escaped = false;
    for (index, character) in raw[from..].char_indices() {
        if escaped {
            escaped = false;
            end = from + index + character.len_utf8();
            continue;
        }
        if character == '\\' {
            escaped = true;
            end = from + index + 1;
            continue;
        }
        if angle && character == '>'
            || !angle && (character.is_whitespace() || character == ')' && depth == 0)
        {
            break;
        }
        if !angle && character == '(' {
            depth += 1;
        }
        if !angle && character == ')' {
            depth -= 1;
        }
        end = from + index + character.len_utf8();
    }
    let destination = &raw[from..end];
    let probe = format!(
        "[x]({}{destination}{})",
        if angle { "<" } else { "" },
        if angle { ">" } else { "" }
    );
    let parsed = Parser::new(&probe).find_map(|event| match event {
        Event::Start(Tag::Link { dest_url, .. }) => Some(dest_url.into_string()),
        _ => None,
    });
    if parsed.as_deref() != Some(&link.destination) {
        return Err(ApiError::bad_request(
            "This link spelling needs a manual update before renaming.",
        ));
    }
    Ok(link.range.start + from..link.range.start + end)
}

fn relative(from: &str, target: &str) -> String {
    let mut parent = from.split('/').collect::<Vec<_>>();
    parent.pop();
    let mut target = target.split('/').collect::<Vec<_>>();
    while !parent.is_empty() && !target.is_empty() && parent[0] == target[0] {
        parent.remove(0);
        target.remove(0);
    }
    std::iter::repeat_n("..", parent.len())
        .chain(target)
        .collect::<Vec<_>>()
        .join("/")
}

pub(super) fn rewrite(
    source: &str,
    old_document: &str,
    new_document: &str,
    old: &str,
    new: &str,
) -> Result<String, ApiError> {
    let mut edits = Vec::new();
    let rebase = old_document.rsplit_once('/').map(|(parent, _)| parent)
        != new_document.rsplit_once('/').map(|(parent, _)| parent);
    let expected = spans(source)
        .into_iter()
        .filter_map(|link| {
            markdown::local_reference(old_document, &link.destination, link.image, link.wiki).map(
                |target| {
                    let target = if target == old || target.starts_with(&format!("{old}/")) {
                        format!("{new}{}", &target[old.len()..])
                    } else {
                        target
                    };
                    (target, link.image)
                },
            )
        })
        .collect::<BTreeSet<_>>();
    for link in spans(source) {
        let Some(target) =
            markdown::local_reference(old_document, &link.destination, link.image, link.wiki)
        else {
            continue;
        };
        let moved = target == old || target.starts_with(&format!("{old}/"));
        if !moved && !rebase {
            continue;
        }
        if link.destination.starts_with('#') {
            continue;
        }
        let target = if moved {
            format!("{new}{}", &target[old.len()..])
        } else {
            target
        };
        let fragment = link
            .destination
            .split_once('#')
            .map(|(_, fragment)| format!("#{fragment}"))
            .unwrap_or_default();
        let query = link
            .destination
            .split('#')
            .next()
            .and_then(|value| value.split_once('?'))
            .map(|(_, query)| format!("?{query}"))
            .unwrap_or_default();
        let path = if link.destination.starts_with('/') {
            format!("/{target}")
        } else {
            relative(new_document, &target)
        };
        let path = if link.wiki {
            path
        } else {
            const SAFE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
                .remove(b'/')
                .remove(b'.')
                .remove(b'-')
                .remove(b'_')
                .remove(b'~');
            percent_encoding::utf8_percent_encode(&path, SAFE).to_string()
        };
        if link.wiki && (path.contains("[[") || path.contains("]]") || path.contains('|')) {
            return Err(ApiError::bad_request(
                "Choose a name that can be represented safely by existing wiki links.",
            ));
        }
        edits.push((
            destination_range(source, &link)?,
            format!("{path}{query}{fragment}"),
        ));
    }
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start));
    edits.dedup_by(|a, b| a.0 == b.0);
    let mut result = source.to_owned();
    let mut previous = source.len();
    for (range, replacement) in edits {
        if range.end > previous {
            return Err(ApiError::bad_request(
                "Overlapping link syntax needs a manual rename.",
            ));
        }
        previous = range.start;
        result.replace_range(range, &replacement);
    }
    let actual = spans(&result)
        .into_iter()
        .filter_map(|link| {
            markdown::local_reference(new_document, &link.destination, link.image, link.wiki)
                .map(|target| (target, link.image))
        })
        .collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(ApiError::bad_request(
            "This Markdown link spelling needs a manual update before renaming.",
        ));
    }
    Ok(result)
}

#[derive(Deserialize)]
pub(super) struct BacklinksQuery {
    document: String,
}
#[derive(Serialize)]
pub(super) struct Backlink {
    id: Option<String>,
    path: String,
    title: Option<String>,
}

pub(super) async fn backlinks(
    Extension(state): Extension<Arc<AppState>>,
    Extension(work): Extension<Arc<Work>>,
    Query(query): Query<BacklinksQuery>,
) -> Result<Json<Vec<Backlink>>, ApiError> {
    blocking(state, work, move |state, work| {
        let path = state.document_path(&query.document)?;
        state.authorize(Some(&path), false)?;
        let files = if let Some(access) = &state.access {
            access.tree()?.files
        } else {
            state.root.tree()?.files
        };
        let mut result = Vec::new();
        for file in files {
            work.check()?;
            if file.path == path {
                continue;
            }
            let document = state.root.source_document(&file.path)?;
            if targets(&file.path, &document.content).contains(&path) {
                state.authorize(Some(&file.path), false)?;
                result.push(Backlink {
                    id: document.id,
                    path: file.path,
                    title: document.title,
                });
            }
        }
        Ok(result)
    })
    .await
    .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wiki_and_markdown_references_resolve_without_including_code_or_metadata() {
        let source = "---\nexample: '[[Hidden]]'\n---\n[[Target|Alias]] [regular](Target.md) `[[Code]]`\n\n```\n[[Fence]]\n```\n";
        assert_eq!(
            targets("docs/source.md", source),
            BTreeSet::from(["docs/Target.md".into()])
        );
    }
    #[test]
    fn rename_changes_only_destinations_and_rebases_a_moved_note() {
        let source = "---\ntitle: Keep\n---\n[[Old|Label]] [link](Old.md \"title\")\n[reference][id]\n\n[id]: <Old.md> 'keep'\n`[[Old]]`\n";
        let renamed = rewrite(
            source,
            "docs/source.md",
            "docs/source.md",
            "docs/Old.md",
            "docs/New name.md",
        )
        .unwrap();
        assert!(renamed.contains("[[New name.md|Label]]"));
        assert!(renamed.contains("[link](New%20name.md \"title\")"));
        assert!(renamed.contains("[id]: <New%20name.md> 'keep'"));
        assert!(renamed.contains("`[[Old]]`"));
        assert_eq!(
            rewrite(
                "![Image](images/pic.png)",
                "note.md",
                "docs/note.md",
                "note.md",
                "docs/note.md"
            )
            .unwrap(),
            "![Image](../images/pic.png)"
        );
    }
}
