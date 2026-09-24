use super::{Access, ApiError, Library, Registry, public::GuestGrant};
use crate::server::permissions::DocumentPermissions;
use std::sync::{Arc, Weak};

// Participation lives inside Library; strong Access references would create an ownership cycle.
pub(in crate::server) struct WatchAccess {
    registry: Weak<Registry>,
    library: Weak<Library>,
    id: String,
    username: String,
    identity: String,
    guest: Option<GuestGrant>,
    principal: String,
}

impl WatchAccess {
    pub(in crate::server) fn new(access: &Access) -> Self {
        Self {
            registry: Arc::downgrade(&access.registry),
            library: Arc::downgrade(&access.library),
            id: access.id.clone(),
            username: access.username.clone(),
            identity: access.identity.clone(),
            guest: access.guest.clone(),
            principal: access.connection_identity().into(),
        }
    }

    pub(in crate::server) fn connection_identity(&self) -> &str {
        &self.principal
    }

    pub(in crate::server) fn document_permissions(
        &self,
        path: &str,
    ) -> Result<DocumentPermissions, ApiError> {
        let registry = self
            .registry
            .upgrade()
            .ok_or_else(|| ApiError::forbidden("The project was closed."))?;
        let library = self
            .library
            .upgrade()
            .ok_or_else(|| ApiError::forbidden("The document library was closed."))?;
        Access {
            registry,
            library,
            id: self.id.clone(),
            username: self.username.clone(),
            identity: self.identity.clone(),
            guest: self.guest.clone(),
        }
        .document_permissions(path)
    }
}
