use super::{ApiError, ProjectStore, Store, db_error};
use crate::server::{files, frontmatter};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
};

#[cfg(test)]
#[path = "search_tests.rs"]
mod tests;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(in crate::server) enum Field {
    #[default]
    All,
    Title,
    Body,
    Metadata,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::server) struct Hit {
    pub id: Option<String>,
    pub project: String,
    pub path: String,
    pub title: String,
    pub version: String,
    pub tags: Vec<String>,
    pub snippet: String,
    pub offset: usize,
}

#[derive(Serialize)]
pub(in crate::server) struct Facet {
    pub tag: String,
    pub count: usize,
}

#[derive(Serialize)]
pub(in crate::server) struct Found {
    pub results: Vec<Hit>,
    pub tags: Vec<Facet>,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

impl ProjectStore {
    pub(in crate::server) fn invalidate_index(
        &self,
        path: &str,
        version: &str,
    ) -> Result<(), ApiError> {
        self.store.with(|connection| {
            connection.execute("UPDATE document_index SET stamp='' WHERE project=?1 AND path=?2 AND version!=?3",
                params![self.project,path,version]).map_err(db_error)?;
            Ok(())
        })
    }

    pub(in crate::server) fn indexed_stamp(&self, path: &str) -> Result<Option<String>, ApiError> {
        self.store.with(|connection| {
            connection
                .prepare_cached("SELECT stamp FROM document_index WHERE project=?1 AND path=?2")
                .map_err(db_error)?
                .query_row(params![self.project, path], |row| row.get(0))
                .optional()
                .map_err(db_error)
        })
    }

    pub(in crate::server) fn index_document(
        &self,
        document: &files::Document,
        stamp: &str,
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        self.store.with(|connection| {
            let transaction = connection.transaction().map_err(db_error)?;
            check()?;
            write_index_document(&transaction, &self.project, document, stamp)?;
            check()?;
            transaction.commit().map_err(db_error)
        })
    }
}

fn write_index_document(
    transaction: &rusqlite::Transaction<'_>,
    project: &str,
    document: &files::Document,
    stamp: &str,
) -> Result<(), ApiError> {
    let source = if document.content.contains('\r') {
        Cow::Owned(document.content.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(document.content.as_str())
    };
    let body = frontmatter::body(&source);
    let metadata = frontmatter::metadata(&source);
    let (tags, warning) = match frontmatter::tags(&source) {
        Ok(tags) => (tags, None),
        Err(error) => (Vec::new(), Some(error)),
    };
    let tags =
        serde_json::to_string(&tags).map_err(|error| ApiError::internal(error.to_string()))?;
    let title = document
        .title
        .as_deref()
        .unwrap_or_else(|| document.path.rsplit('/').next().unwrap_or(&document.path));
    let old: Option<(i64, String)> = transaction
        .prepare_cached("SELECT id,version FROM document_index WHERE project=?1 AND path=?2")
        .map_err(db_error)?
        .query_row(params![project, document.path], |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .optional()
        .map_err(db_error)?;
    if old
        .as_ref()
        .is_some_and(|(_, version)| version == &document.version)
    {
        transaction
            .prepare_cached("UPDATE document_index SET stamp=?3 WHERE project=?1 AND path=?2")
            .map_err(db_error)?
            .execute(params![project, document.path, stamp])
            .map_err(db_error)?;
        return Ok(());
    }
    if let Some((id, _)) = old {
        transaction
            .prepare_cached("DELETE FROM document_fts WHERE rowid=?1")
            .map_err(db_error)?
            .execute([id])
            .map_err(db_error)?;
    }
    transaction.prepare_cached("INSERT INTO document_index(project,path,version,stamp,title,source,body,metadata,tags,warning)
                VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(project,path) DO UPDATE SET
                version=excluded.version,stamp=excluded.stamp,title=excluded.title,source=excluded.source,
                body=excluded.body,metadata=excluded.metadata,tags=excluded.tags,warning=excluded.warning").map_err(db_error)?
                .execute(params![project,document.path,document.version,stamp,title,source,body,metadata,tags,warning]).map_err(db_error)?;
    transaction.prepare_cached("INSERT INTO document_fts(rowid,title,body,metadata,path,tags)
                SELECT id,title,body,metadata,path,tags FROM document_index WHERE project=?1 AND path=?2").map_err(db_error)?
                .execute(params![project,document.path]).map_err(db_error)?;
    Ok(())
}

fn excerpt(source: &str, terms: &[String]) -> (String, usize) {
    if terms.is_empty() {
        return (source.chars().take(240).collect(), 0);
    }
    let lower = source.to_lowercase();
    let target = terms
        .iter()
        .filter_map(|term| lower.find(term))
        .min()
        .unwrap_or(0);
    let mut folded = 0;
    let mut start = source.len();
    for (position, character) in source.char_indices() {
        if folded >= target {
            start = position;
            break;
        }
        folded += character.to_lowercase().map(char::len_utf8).sum::<usize>();
    }
    let offset = source[..start].encode_utf16().count();
    let from = source[..start]
        .char_indices()
        .rev()
        .nth(60)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let text = source[from..].chars().take(240).collect::<String>();
    (text, offset)
}

impl Store {
    pub(in crate::server) fn search(
        &self,
        projects: &[String],
        query: &str,
        field: Field,
        selected_tags: &[String],
        mut allowed: impl FnMut(&str, &str, &str) -> Result<bool, ApiError>,
    ) -> Result<Found, ApiError> {
        let terms = query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        let indexed_terms = terms
            .iter()
            .filter(|term| term.chars().count() >= 3)
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" AND ");
        let selected = selected_tags
            .iter()
            .map(|tag| tag.trim().to_lowercase())
            .collect::<BTreeSet<_>>();
        let projects = serde_json::to_string(projects)
            .map_err(|error| ApiError::internal(error.to_string()))?;
        self.with(|connection| {
            let searchable = if terms.is_empty() { "NULL" } else {
                match field { Field::All => "d.source", Field::Title => "d.title", Field::Body => "d.body", Field::Metadata => "d.metadata" }
            };
            let base = format!("SELECT d.project,d.path,d.stamp,d.title,{searchable},d.tags,d.version,d.warning,d.id FROM document_index d");
            let sql = if indexed_terms.is_empty() {
                format!("{base} WHERE d.project IN (SELECT value FROM json_each(?1)) ORDER BY d.path")
            } else {
                format!("{base} JOIN document_fts ON document_fts.rowid=d.id WHERE d.project IN (SELECT value FROM json_each(?1))
                    AND document_fts MATCH ?2 ORDER BY bm25(document_fts),d.path")
            };
            let mut statement = connection.prepare(&sql).map_err(db_error)?;
            let mut rows = if indexed_terms.is_empty() { statement.query([projects]).map_err(db_error)? }
                else { statement.query(params![projects,indexed_terms]).map_err(db_error)? };
            let mut source_statement = connection.prepare_cached("SELECT source FROM document_index WHERE id=?1").map_err(db_error)?;
            let mut results = Vec::new();
            let mut facets = BTreeMap::<String, (String, usize)>::new();
            let mut warnings = Vec::new();
            let mut truncated = false;
            while let Some(row) = rows.next().map_err(db_error)? {
                let project: String = row.get(0).map_err(db_error)?;
                let path: String = row.get(1).map_err(db_error)?;
                let stamp: String = row.get(2).map_err(db_error)?;
                if !allowed(&project, &path, &stamp)? { continue; }
                let title: String = row.get(3).map_err(db_error)?;
                let text: String = if terms.is_empty() { String::new() } else { row.get(4).map_err(db_error)? };
                if !terms.is_empty() {
                    let searchable = text.to_lowercase();
                    let extra = if matches!(field, Field::All) { format!("{title}\n{path}").to_lowercase() } else { String::new() };
                    if !terms.iter().all(|term| searchable.contains(term) || extra.contains(term)) { continue; }
                }
                let tags: String = row.get(5).map_err(db_error)?;
                let tags: Vec<String> = serde_json::from_str(&tags).map_err(|error| ApiError::internal(format!("Invalid tag index: {error}")))?;
                if !selected.iter().all(|selected| tags.iter().any(|tag| tag.to_lowercase() == *selected)) { continue; }
                for tag in &tags {
                    let entry = facets.entry(tag.to_lowercase()).or_insert_with(|| (tag.clone(), 0));
                    entry.1 += 1;
                }
                let warning: Option<String> = row.get(7).map_err(db_error)?;
                if let Some(warning) = warning {
                    if warnings.len() < 10 { warnings.push(format!("{path}: {warning}")); }
                }
                if results.len() >= 100 { truncated = true; continue; }
                let source = if !terms.is_empty() && matches!(field, Field::All) { text } else {
                    let id: i64 = row.get(8).map_err(db_error)?;
                    source_statement.query_row([id], |row| row.get::<_, String>(0)).map_err(db_error)?
                };
                let (snippet, offset) = excerpt(&source, &terms);
                results.push(Hit { id: None, project, path, title, version: row.get(6).map_err(db_error)?, tags, snippet, offset });
            }
            let mut tags = facets.into_values().map(|(tag,count)| Facet { tag,count }).collect::<Vec<_>>();
            tags.sort_by(|a,b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
            tags.truncate(200);
            Ok(Found { results, tags, truncated, warnings })
        })
    }
}
