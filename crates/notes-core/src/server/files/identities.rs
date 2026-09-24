use super::{ApiError, Document, Root, document_from_bytes, is_markdown};
use crate::server::{
    markdown,
    state_store::resources::{Resource, ResourceKind},
};
use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::{collections::BTreeMap, sync::atomic::Ordering};

#[derive(Clone, Debug, Serialize)]
pub(in crate::server) struct Reference {
    pub source: String,
    #[serde(flatten)]
    pub resource: Resource,
}

impl Root {
    pub(in crate::server) fn resource_revision(&self) -> Result<u64, ApiError> {
        let Some(store) = self.resources.get() else {
            return Ok(0);
        };
        let revision = store.identity_revision()?;
        if self.resource_epoch.swap(revision, Ordering::AcqRel) != revision {
            self.document_cache
                .lock()
                .map_err(|_| ApiError::internal("The document cache is unavailable."))?
                .clear();
        }
        Ok(revision)
    }

    fn reference_location(
        &self,
        path: &str,
        image: bool,
    ) -> Result<Option<(String, ResourceKind)>, ApiError> {
        if image && is_markdown(path) {
            return Ok(None);
        }
        let kind = if is_markdown(path) {
            ResourceKind::Document
        } else {
            ResourceKind::Asset
        };
        let canonical = match self.canonical_file_path(path) {
            Ok(path) => path,
            Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => path.into(),
            Err(error) if matches!(error.status.as_u16(), 400 | 403) => return Ok(None),
            Err(error) => return Err(error),
        };
        Ok(Some((canonical, kind)))
    }

    pub(in crate::server) fn rendered_document(
        &self,
        path: &str,
        bytes: &[u8],
    ) -> Result<Document, ApiError> {
        let document = if self.resources.get().is_some() {
            super::documents::source_from_bytes(path, bytes)?
        } else {
            return document_from_bytes(path, bytes);
        };
        self.decorate_document(document)
    }

    pub(in crate::server) fn decorate_document(
        &self,
        document: Document,
    ) -> Result<Document, ApiError> {
        let mut document = self.identify_document(document)?;
        let Some(id) = document.id.as_deref() else {
            return Ok(document);
        };
        let (html, references) =
            self.render_resource_markdown(&document.path, id, &document.content)?;
        document.html = html;
        document.references = references;
        Ok(document)
    }

    pub(in crate::server) fn render_resource_markdown(
        &self,
        path: &str,
        document: &str,
        content: &str,
    ) -> Result<(String, Vec<Reference>), ApiError> {
        let targets = markdown::resource_paths(path, content);
        let mut sources = Vec::new();
        let mut locations = Vec::new();
        for (source, image) in targets {
            if let Some(location) = self.reference_location(&source, image)? {
                sources.push(source);
                locations.push(location);
            }
        }
        let resources = self.resource_store()?.identify_many(&locations)?;
        let references = sources
            .into_iter()
            .zip(resources)
            .collect::<BTreeMap<_, _>>();
        let mut failure = None;
        let html = markdown::render_with_urls(path, content, |url, image| {
            if failure.is_some() {
                return None;
            }
            let Some(local) = url.strip_prefix('/') else {
                return Some(url);
            };
            let (encoded, fragment) = local
                .split_once('#')
                .map(|(p, h)| (p, format!("#{h}")))
                .unwrap_or((local, String::new()));
            let source = match percent_decode_str(encoded).decode_utf8() {
                Ok(path) => path.into_owned(),
                Err(_) => {
                    failure = Some(ApiError::bad_request("A local link is not valid Unicode."));
                    return None;
                }
            };
            let resource = references.get(&source)?;
            if image && resource.kind != ResourceKind::Asset {
                return None;
            }
            Some(match resource.kind {
                ResourceKind::Document => format!("/?document={}{fragment}", resource.id),
                ResourceKind::Asset => {
                    format!("/assets?id={}&document={document}{fragment}", resource.id)
                }
                ResourceKind::Directory => return None,
            })
        });
        if let Some(error) = failure {
            return Err(error);
        }
        Ok((
            html,
            references
                .into_iter()
                .map(|(source, resource)| Reference { source, resource })
                .collect(),
        ))
    }
}
