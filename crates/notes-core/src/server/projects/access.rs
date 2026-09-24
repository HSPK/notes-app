use std::sync::Arc;

use super::{ApiError, Library, Project, Registry, Sharing, Summary, files};

#[derive(Clone)]
pub(crate) struct Access {
    pub(super) registry: Arc<Registry>,
    pub(in crate::server) id: String,
    pub(super) username: String,
    pub(super) identity: String,
    pub(in crate::server) library: Arc<Library>,
    pub(super) guest: Option<super::public::GuestGrant>,
}

impl Access {
    pub(in crate::server) fn actor(&self) -> &str {
        self.guest
            .as_ref()
            .map(|guest| guest.visitor.as_deref().unwrap_or("Anonymous link"))
            .unwrap_or(&self.username)
    }
    pub(in crate::server) fn visitor_name(&self) -> Option<&str> {
        self.guest
            .as_ref()
            .and_then(|guest| guest.visitor.as_deref())
    }

    pub(in crate::server) fn make_private(&self, path: &str) -> Result<(), ApiError> {
        self.owner()?;
        let resource = self.library.root.resource_store()?.identify(
            path,
            crate::server::state_store::resources::ResourceKind::Document,
        )?;
        self.registry.document_permission(
            &self.id,
            &self.username,
            resource.id,
            super::public::DocumentPermission::Private,
            false,
            None,
        )?;
        Ok(())
    }

    pub(in crate::server) fn is_user(&self, username: &str) -> bool {
        self.username == username
    }

    pub(in crate::server) fn project(&self) -> Result<Project, ApiError> {
        match &self.guest {
            Some(guest) => self.registry.guest_project(&self.id, guest),
            None => self.registry.project(&self.id, &self.identity),
        }
    }

    fn with_project<T>(
        &self,
        operation: impl FnOnce(&Project) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        match &self.guest {
            Some(guest) => operation(&self.registry.guest_project(&self.id, guest)?),
            None => self
                .registry
                .with_project(&self.id, &self.identity, operation),
        }
    }

    pub(in crate::server) fn is_public(&self) -> bool {
        self.guest.is_some()
    }

    pub(in crate::server) fn connection_identity(&self) -> &str {
        self.guest
            .as_ref()
            .map(|guest| guest.principal.as_str())
            .unwrap_or(&self.identity)
    }

    pub(in crate::server) fn public_valid(&self) -> bool {
        self.guest.is_some() && self.project().is_ok()
    }

    fn permission(&self, project: &Project, path: Option<&str>) -> Sharing {
        if let Some(guest) = &self.guest {
            return if path == Some(&guest.path) {
                project
                    .public_links
                    .get(&guest.path)
                    .map(|link| link.access)
                    .unwrap_or_default()
            } else {
                Sharing::Private
            };
        }
        project.permission(&self.identity, path)
    }

    pub(in crate::server) fn summary(&self) -> Result<Summary, ApiError> {
        if self.is_public() {
            return Err(ApiError::forbidden(
                "Public links cannot access project settings.",
            ));
        }
        self.with_project(|project| self.registry.summarize(project, &self.id, &self.identity))
    }

    fn canonical_permission_path(
        &self,
        project: &Project,
        path: Option<&str>,
    ) -> Result<Option<String>, ApiError> {
        #[cfg(any(windows, target_os = "macos"))]
        {
            if !project.pages.is_empty() {
                match path.filter(|path| files::is_markdown(path)) {
                    Some(path) => match self.library.root.canonical_document_path(path) {
                        Ok(path) => return Ok(Some(path)),
                        Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {}
                        Err(error) => return Err(error),
                    },
                    None => {}
                }
            }
        }
        let _ = (project, path);
        Ok(None)
    }

    pub(in crate::server) fn document_permissions(
        &self,
        path: &str,
    ) -> Result<crate::server::permissions::DocumentPermissions, ApiError> {
        self.with_project(|project| {
            let canonical = self.canonical_permission_path(project, Some(path))?;
            let path = canonical.as_deref().unwrap_or(path);
            let permission = self.permission(project, Some(path));
            if permission < Sharing::Read {
                return Err(ApiError::forbidden("This project or page is private."));
            }
            let writable = permission == Sharing::Edit;
            Ok(crate::server::permissions::DocumentPermissions {
                writable,
                collaborative: writable
                    && (self.is_public() || project.sharing(Some(path)) == Sharing::Edit),
                owner: !self.is_public() && project.owned(&self.identity),
            })
        })
    }

    pub(in crate::server) fn check(&self, path: Option<&str>, write: bool) -> Result<(), ApiError> {
        let needed = if write { Sharing::Edit } else { Sharing::Read };
        self.with_project(|project| {
            let canonical = self.canonical_permission_path(project, path)?;
            let path = canonical.as_deref().or(path);
            if self.permission(project, path) < needed {
                return Err(ApiError::forbidden(if write {
                    "This project or page is read-only or private."
                } else {
                    "This project or page is private."
                }));
            }
            Ok(())
        })
    }

    pub(in crate::server) fn owner(&self) -> Result<(), ApiError> {
        if self.is_public() || !self.with_project(|project| Ok(project.owned(&self.identity)))? {
            return Err(ApiError::forbidden(
                "Only the project owner can perform this operation.",
            ));
        }
        Ok(())
    }

    pub(in crate::server) fn tree(&self) -> Result<files::Tree, ApiError> {
        if self.is_public() {
            return Err(ApiError::forbidden("Public links cannot browse projects."));
        }
        let project = self.project()?;
        if project.permission(&self.identity, None) != Sharing::Private {
            let mut tree = self.library.root.tree()?;
            tree.root = self.id.clone();
            tree.files.retain(|file| {
                project.permission(&self.identity, Some(&file.path)) != Sharing::Private
            });
            for directory in &mut tree.directories {
                if !project.owned(&self.identity)
                    && project.pages.iter().any(|(path, level)| {
                        *level == Sharing::Private
                            && path.rsplit_once('/').is_some_and(|(parent, name)| {
                                parent == directory.path && name.eq_ignore_ascii_case("index.md")
                            })
                    })
                {
                    directory.title = None;
                }
            }
            return Ok(tree);
        }
        let mut entries = Vec::new();
        for path in project.pages.keys() {
            if project.permission(&self.identity, Some(path)) == Sharing::Private {
                continue;
            }
            match self.library.root.source_document(path) {
                Ok(doc) => entries.push(files::TreeFile {
                    id: doc.id,
                    path: path.clone(),
                    name: path.rsplit('/').next().unwrap_or(path).into(),
                    title: doc.title.map(Arc::from),
                }),
                Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {}
                Err(error) => return Err(error),
            }
        }
        Ok(files::Tree {
            root: self.id.clone(),
            files: entries,
            directories: Vec::new(),
            truncated: false,
        })
    }

    pub(in crate::server) fn asset(
        &self,
        path: &str,
        document: Option<&str>,
    ) -> Result<(), ApiError> {
        files::validate_relative(path)?;
        let project = self.project()?;
        if !self.is_public() && project.owned(&self.identity) {
            return Ok(());
        }
        if files::is_markdown(path) {
            self.check(Some(path), false)?;
        }
        for (private, level) in &project.pages {
            if *level != Sharing::Private {
                continue;
            }
            let mut referenced = match project.attachments.get(private) {
                Some(paths) => self.includes_asset(paths, path)?,
                None => false,
            };
            if !referenced {
                match self.library.root.source_document(private) {
                    Ok(doc) => {
                        referenced = self.includes_asset(
                            &crate::server::markdown::referenced_assets(private, &doc.content),
                            path,
                        )?
                    }
                    Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {}
                    Err(error) => return Err(error),
                }
            }
            if referenced {
                return Err(ApiError::forbidden(
                    "This attachment belongs to a private document.",
                ));
            }
        }
        if !self.is_public() && project.permission(&self.identity, None) >= Sharing::Read {
            return Ok(());
        }
        let document = document
            .ok_or_else(|| ApiError::forbidden("A shared page is required for this attachment."))?;
        self.check(Some(document), false)?;
        if !self
            .project()?
            .attachments
            .get(document)
            .is_some_and(|paths| paths.contains(path))
        {
            return Err(ApiError::forbidden(
                "This attachment was not included when the page was shared.",
            ));
        }
        Ok(())
    }

    fn includes_asset(
        &self,
        paths: &std::collections::BTreeSet<String>,
        path: &str,
    ) -> Result<bool, ApiError> {
        if paths.contains(path) {
            return Ok(true);
        }
        #[cfg(any(windows, target_os = "macos"))]
        if !paths.is_empty() {
            let canonical = self.library.root.canonical_file_path(path)?;
            for candidate in paths {
                match self.library.root.canonical_file_path(candidate) {
                    Ok(candidate) if candidate == canonical => return Ok(true),
                    Ok(_) => {}
                    Err(error) if error.status == axum::http::StatusCode::NOT_FOUND => {}
                    Err(error) => return Err(error),
                }
            }
        }
        Ok(false)
    }

    pub(in crate::server) fn image_directory(&self) -> Result<String, ApiError> {
        Ok(self.project()?.image_directory)
    }

    pub(in crate::server) fn allow_uploaded_image(
        &self,
        document: &str,
        image: &str,
    ) -> Result<(), ApiError> {
        self.registry.mutate(|catalog| {
            let project = catalog
                .projects
                .get_mut(&self.id)
                .ok_or_else(|| ApiError::forbidden("The project is unavailable."))?;
            if self.permission(project, Some(document)) != Sharing::Edit
                || self.guest.as_ref().is_some_and(|guest| {
                    project
                        .public_links
                        .get(document)
                        .is_none_or(|link| super::public::digest(&link.token) != guest.digest)
                })
            {
                return Err(ApiError::forbidden("This page is read-only."));
            }
            if project.pages.contains_key(document) {
                let paths = project.attachments.entry(document.into()).or_default();
                if paths.len() >= 5000 {
                    return Err(ApiError::conflict(
                        "The shared attachment limit was reached.",
                    ));
                }
                paths.insert(image.into());
            }
            Ok(())
        })
    }

    pub(in crate::server) fn movable(&self, path: &str, destination: &str) -> Result<(), ApiError> {
        self.check(None, true)?;
        self.check(Some(path), true)?;
        self.check(Some(destination), true)?;
        let project = self.project()?;
        if !project.owned(&self.identity) && !project.pages.is_empty() && !files::is_markdown(path)
        {
            return Err(ApiError::forbidden(
                "Only the owner can move folders while document-specific permissions are configured.",
            ));
        }
        if project
            .pages
            .keys()
            .any(|shared| shared == destination || shared.starts_with(&format!("{destination}/")))
        {
            return Err(ApiError::conflict(
                "The destination already has page permissions. Choose another destination.",
            ));
        }
        Ok(())
    }

    pub(in crate::server) fn relocate_permissions(
        &self,
        old: &str,
        new: &str,
    ) -> Result<(), ApiError> {
        if self.is_public() {
            return Err(ApiError::forbidden(
                "Public links cannot move project resources.",
            ));
        }
        self.registry.mutate(|catalog| {
            let project = catalog
                .projects
                .get_mut(&self.id)
                .ok_or_else(|| ApiError::forbidden("This project no longer exists."))?;
            if project.permission(&self.identity, None) < Sharing::Edit
                || project.permission(&self.identity, Some(old)) < Sharing::Edit
            {
                return Err(ApiError::forbidden("Move permission was removed."));
            }
            let moved = |path: &str| {
                (path == old || path.starts_with(&format!("{old}/")))
                    .then(|| format!("{new}{}", &path[old.len()..]))
            };
            let targets = project
                .pages
                .keys()
                .filter(|path| *path == new || path.starts_with(&format!("{new}/")))
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            let pages = project
                .pages
                .keys()
                .filter_map(|path| moved(path).map(|next| (path.clone(), next)))
                .collect::<Vec<_>>();
            for (path, next) in pages {
                if let Some(level) = project.pages.remove(&path) {
                    project.pages.entry(next).or_insert(level);
                }
            }
            let links = project
                .public_links
                .keys()
                .filter_map(|path| moved(path).map(|next| (path.clone(), next)))
                .collect::<Vec<_>>();
            for (path, next) in links {
                if let Some(link) = project.public_links.remove(&path) {
                    if !targets.contains(&next) {
                        project.public_links.entry(next).or_insert(link);
                    }
                }
            }
            let documents = project
                .attachments
                .keys()
                .filter_map(|path| moved(path).map(|next| (path.clone(), next)))
                .collect::<Vec<_>>();
            for (path, next) in documents {
                if let Some(assets) = project.attachments.remove(&path) {
                    project.attachments.entry(next).or_default().extend(assets);
                }
            }
            for assets in project.attachments.values_mut() {
                *assets = assets
                    .iter()
                    .map(|path| moved(path).unwrap_or_else(|| path.clone()))
                    .collect();
            }
            Ok(())
        })
    }

    pub(in crate::server) fn git_read(&self) -> Result<(), ApiError> {
        self.check(None, false)?;
        if !self.project()?.git_available(&self.identity) {
            return Err(ApiError::forbidden(
                "Git access is limited to the owner while this project contains private documents.",
            ));
        }
        Ok(())
    }
}
