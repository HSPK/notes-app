use super::{ApiError, Document, Root, validate_document_path, validate_relative};
use crate::server::state_store::{ProjectStore, resources::ResourceKind};
use std::fs;

impl Root {
    pub(in crate::server) fn create_directory(&self, path: &str) -> Result<String, ApiError> {
        super::validate_directory_path(path)?;
        let resolved = self.resolve(path)?;
        match resolved.parent.metadata(&resolved.name) {
            Ok(_) => {
                return Err(ApiError::conflict(
                    "A file or folder already exists at this path.",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(ApiError::io("Could not inspect the new folder path", error)),
        }
        resolved
            .parent
            .create_dir(&resolved.name)
            .map_err(|error| ApiError::io("Could not create the folder", error))?;
        resolved.parent.sync()?;
        let canonical = fs::canonicalize(self.path.join(path))
            .map_err(|error| ApiError::io("Could not resolve the new folder", error))?;
        let relative = canonical
            .strip_prefix(&self.path)
            .map_err(|_| ApiError::forbidden("The folder is outside this project."))?
            .to_str()
            .ok_or_else(|| ApiError::bad_request("Folder paths must be Unicode."))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if let Some(store) = self.resources.get() {
            store.retire_resource(&relative)?;
            store.identify(&relative, ResourceKind::Directory)?;
        }
        Ok(relative)
    }

    pub(in crate::server) fn attach_resources(&self, store: ProjectStore) -> Result<(), ApiError> {
        self.resources
            .set(store)
            .map_err(|_| ApiError::internal("Resource identities are already configured."))
    }

    pub(in crate::server) fn resource_store(&self) -> Result<&ProjectStore, ApiError> {
        self.resources
            .get()
            .ok_or_else(|| ApiError::internal("Resource identities are unavailable."))
    }

    pub(in crate::server) fn identify_document(
        &self,
        mut document: Document,
    ) -> Result<Document, ApiError> {
        if let Some(store) = self.resources.get() {
            document.project = Some(store.project.clone());
            document.path = self.canonical_document_path(&document.path)?;
            document.id = Some(store.identify(&document.path, ResourceKind::Document)?.id);
        }
        Ok(document)
    }

    pub(in crate::server) fn canonical_document_path(
        &self,
        path: &str,
    ) -> Result<String, ApiError> {
        validate_document_path(path)?;
        self.canonical_file_path(path)
    }

    pub(in crate::server) fn canonical_file_path(&self, path: &str) -> Result<String, ApiError> {
        validate_relative(path)?;
        let resolved = self.resolve(path)?;
        // Pin the validated parents and file while resolving filesystem spelling.
        let _file = resolved.parent.open_regular(&resolved.name)?;
        let canonical = fs::canonicalize(self.path.join(path))
            .map_err(|error| ApiError::io("Could not resolve the document name", error))?;
        let relative = canonical
            .strip_prefix(&self.path)
            .map_err(|_| ApiError::forbidden("The document is outside this project."))?;
        let path = relative
            .to_str()
            .ok_or_else(|| ApiError::bad_request("Document paths must be Unicode."))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        validate_relative(&path)?;
        Ok(path)
    }

    pub(in crate::server) fn canonical_destination(&self, path: &str) -> Result<String, ApiError> {
        validate_relative(path)?;
        let resolved = self.resolve(path)?;
        let parent = self
            .path
            .join(path)
            .parent()
            .ok_or_else(|| ApiError::bad_request("Choose a destination folder."))?
            .to_owned();
        let canonical = fs::canonicalize(parent)
            .map_err(|error| ApiError::io("Could not resolve the destination folder", error))?;
        let relative = canonical
            .strip_prefix(&self.path)
            .map_err(|_| ApiError::forbidden("The destination is outside this project."))?
            .join(&resolved.name)
            .to_str()
            .ok_or_else(|| ApiError::bad_request("Paths must be Unicode."))?
            .replace(std::path::MAIN_SEPARATOR, "/");
        validate_relative(&relative)?;
        Ok(relative)
    }
}
