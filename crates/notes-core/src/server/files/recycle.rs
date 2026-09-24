use super::{
    ApiError, Root, StagedFile, check_version, read_limited, validate_document_path,
    validate_relative,
};

impl Root {
    pub(in crate::server) fn remove_document(
        &self,
        path: &str,
        version: &str,
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        validate_document_path(path)?;
        self.remove_checked(path, version, check)
    }

    pub(in crate::server) fn remove_checked(
        &self,
        path: &str,
        version: &str,
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        validate_relative(path)?;
        let resolved = self.resolve(path)?;
        let mut file = resolved.parent.open_regular(&resolved.name)?;
        let bytes = read_limited(&mut file, 16 * 1024 * 1024, "Recycled files")?;
        check_version(&bytes, version)?;
        check()?;
        drop(file);
        resolved
            .parent
            .remove_file(&resolved.name)
            .map_err(|error| ApiError::io("Could not move the file into the recycle bin", error))?;
        resolved.parent.sync()?;
        if let Ok(mut cache) = self.document_cache.lock() {
            cache.remove_tree(path);
        }
        if let Some(store) = self.resources.get() {
            store.retire_resource(path)?;
        }
        Ok(())
    }

    pub(in crate::server) fn restore_asset(
        &self,
        path: &str,
        bytes: &[u8],
        check: impl Fn() -> Result<(), ApiError>,
    ) -> Result<(), ApiError> {
        validate_relative(path)?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err(ApiError::too_large("The recycled attachment is too large."));
        }
        let resolved = self.resolve(path)?;
        let mut staged = StagedFile::write(&resolved.parent, bytes, None)?;
        check()?;
        staged.commit(&resolved.name, false)?;
        resolved.parent.sync()?;
        Ok(())
    }
}
