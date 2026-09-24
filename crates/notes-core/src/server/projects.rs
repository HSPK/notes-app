use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use fs2::FileExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    auth::{AuthenticatedUser, Role, UserStore},
    storage::{PublishMode, load_json, save_json},
};

use super::{ApiError, Library, files, hex};

#[path = "projects/access.rs"]
mod access;
#[path = "projects/api.rs"]
pub(super) mod api;
#[path = "projects/identities.rs"]
mod identities;
#[path = "projects/public.rs"]
pub(super) mod public;
#[path = "projects/shares.rs"]
pub(super) mod shares;
#[path = "projects/sync.rs"]
pub(super) mod sync;
#[path = "projects/watch_access.rs"]
pub(super) mod watch_access;
pub(super) use access::Access;
use public::{PublicLink, PublicLinkInfo};

#[cfg(test)]
#[path = "projects/access_tests.rs"]
mod access_tests;

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub(super) enum Sharing {
    #[default]
    Private,
    Read,
    Edit,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(super) struct Project {
    name: String,
    owner: Option<String>,
    owner_id: Option<String>,
    root: PathBuf,
    repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    token: Option<String>,
    shared: Sharing,
    pages: BTreeMap<String, Sharing>,
    #[serde(default)]
    attachments: BTreeMap<String, BTreeSet<String>>,
    #[serde(default = "default_image_directory")]
    image_directory: String,
    #[serde(default)]
    public_links: BTreeMap<String, PublicLink>,
    #[serde(default)]
    git_sync: sync::Config,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    version: u32,
    projects: BTreeMap<String, Project>,
    #[serde(skip)]
    public_index: HashMap<String, (String, String)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Summary {
    pub(in crate::server) id: String,
    pub(in crate::server) name: String,
    owner: Option<String>,
    owned: bool,
    root: Option<PathBuf>,
    repository: Option<String>,
    shared: Sharing,
    access: Sharing,
    pages: BTreeMap<String, Sharing>,
    document_ids: BTreeMap<String, String>,
    image_directory: String,
    git_available: bool,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    public_links: BTreeMap<String, PublicLinkInfo>,
}

impl Project {
    fn owned(&self, user: &str) -> bool {
        self.owner_id.as_deref() == Some(user)
    }

    fn permission(&self, user: &str, path: Option<&str>) -> Sharing {
        if self.owned(user) {
            Sharing::Edit
        } else {
            self.sharing(path)
        }
    }

    fn sharing(&self, path: Option<&str>) -> Sharing {
        path.and_then(|path| self.pages.get(path).copied())
            .unwrap_or(self.shared)
    }

    fn visible(&self, user: &str) -> bool {
        self.owned(user)
            || self.shared != Sharing::Private
            || self.pages.values().any(|level| *level != Sharing::Private)
    }

    fn git_available(&self, user: &str) -> bool {
        self.owned(user)
            || self.shared != Sharing::Private
                && !self.pages.values().any(|level| *level == Sharing::Private)
    }
}

pub(super) struct Registry {
    path: PathBuf,
    managed: PathBuf,
    protected: PathBuf,
    libraries: Mutex<HashMap<String, Arc<Library>>>,
    update: Mutex<()>,
    initial_root: PathBuf,
    users: UserStore,
    cache: Mutex<Option<(std::time::SystemTime, u64, Arc<Catalog>)>>,
    storage: Mutex<Option<Arc<super::state_store::Store>>>,
    sync_status: Mutex<HashMap<String, sync::Status>>,
}

impl Registry {
    pub(super) fn open(root: Arc<files::Root>, users: &UserStore) -> Result<Self, String> {
        let directory = users
            .path()
            .parent()
            .ok_or("The user database has no parent directory.")?;
        let directory = if directory.exists() {
            fs::canonicalize(directory)
        } else {
            std::path::absolute(directory)
        }
        .map_err(|error| error.to_string())?;
        let scope = hex(&Sha256::digest(root.path().to_string_lossy().as_bytes()));
        let registry = Self {
            path: directory.join(format!("projects-{}.json", &scope[..16])),
            managed: directory.join(format!("projects-{}", &scope[..16])),
            protected: directory,
            libraries: Mutex::new(HashMap::new()),
            update: Mutex::new(()),
            initial_root: root.path().into(),
            users: users.clone(),
            cache: Mutex::new(None),
            storage: Mutex::new(None),
            sync_status: Mutex::new(HashMap::new()),
        };
        if registry.load().map_err(|error| error.message)?.is_some() {
            registry
                .bind_public_identities()
                .map_err(|error| error.message)?;
        }
        Ok(registry)
    }

    fn initialize(&self) -> Result<(), ApiError> {
        if self.load()?.is_some() {
            return Ok(());
        }
        fs::create_dir_all(&self.protected)
            .map_err(|error| ApiError::io("Could not create project storage", error))?;
        let _lock = self.lock()?;
        if self.load()?.is_none() {
            let owner = self
                .users
                .list()
                .map_err(ApiError::internal)?
                .into_iter()
                .find(|user| user.role == Role::Admin)
                .map(|user| user.username);
            let project = Project {
                name: self
                    .initial_root
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .into_owned(),
                owner_id: owner
                    .as_deref()
                    .map(|owner| self.users.account_id(owner))
                    .transpose()
                    .map_err(ApiError::internal)?,
                owner,
                root: self.initial_root.clone(),
                repository: None,
                token: None,
                shared: Sharing::Private,
                pages: BTreeMap::new(),
                attachments: BTreeMap::new(),
                image_directory: default_image_directory(),
                public_links: BTreeMap::new(),
                git_sync: sync::Config::default(),
            };
            save_json(
                &self.path,
                "projects",
                &Catalog {
                    version: 1,
                    projects: BTreeMap::from([("default".into(), project)]),
                    public_index: HashMap::new(),
                },
                PublishMode::Create,
            )
            .map_err(ApiError::internal)?;
        }
        Ok(())
    }

    fn lock(&self) -> Result<File, ApiError> {
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options
            .open(self.path.with_extension("lock"))
            .map_err(|error| ApiError::io("Could not open the project lock", error))?;
        file.lock_exclusive()
            .map_err(|error| ApiError::io("Could not lock projects", error))?;
        Ok(file)
    }

    fn load(&self) -> Result<Option<Arc<Catalog>>, ApiError> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(ApiError::io("Could not inspect projects", error)),
        };
        let modified = metadata
            .modified()
            .map_err(|error| ApiError::io("Could not inspect project version", error))?;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| ApiError::internal("Project cache is unavailable."))?;
        if let Some((stamp, length, catalog)) = &*cache {
            if *stamp == modified && *length == metadata.len() {
                return Ok(Some(catalog.clone()));
            }
        }
        let mut catalog: Option<Catalog> =
            load_json(&self.path, "projects").map_err(ApiError::internal)?;
        if let Some(catalog) = &mut catalog {
            if catalog.version != 1 || catalog.projects.len() > 1024 {
                return Err(ApiError::internal(
                    "The project catalog is unsupported or too large.",
                ));
            }
            for (id, project) in &catalog.projects {
                project.git_sync.validate()?;
                if !valid_id(id)
                    || project.name.is_empty()
                    || !project.root.is_absolute()
                    || project.pages.len() > 5000
                {
                    return Err(ApiError::internal(
                        "The project catalog contains an invalid entry.",
                    ));
                }
                for path in project.pages.keys() {
                    files::validate_document_path(path)?;
                }
                for (path, link) in &project.public_links {
                    files::validate_document_path(path)?;
                    link.validate()?;
                    if project.pages.get(path) != Some(&link.access) {
                        return Err(ApiError::internal(
                            "Public link permissions do not match the document.",
                        ));
                    }
                    if catalog
                        .public_index
                        .insert(public::digest(&link.token), (id.clone(), path.clone()))
                        .is_some()
                    {
                        return Err(ApiError::internal(
                            "Duplicate public link in project storage.",
                        ));
                    }
                }
            }
        }
        let catalog = catalog.map(Arc::new);
        *cache = catalog
            .as_ref()
            .map(|catalog| (modified, metadata.len(), catalog.clone()));
        Ok(catalog)
    }

    fn catalog(&self) -> Result<Arc<Catalog>, ApiError> {
        self.load()?
            .ok_or_else(|| ApiError::internal("The project catalog is missing."))
    }

    fn mutate<T>(
        &self,
        operation: impl FnOnce(&mut Catalog) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        self.initialize()?;
        let _update = self
            .update
            .lock()
            .map_err(|_| ApiError::internal("Project updates are unavailable."))?;
        let _file = self.lock()?;
        let mut catalog = (*self.catalog()?).clone();
        let result = operation(&mut catalog)?;
        save_json(&self.path, "projects", &catalog, PublishMode::Replace)
            .map_err(ApiError::internal)?;
        *self
            .cache
            .lock()
            .map_err(|_| ApiError::internal("Project cache is unavailable."))? = None;
        Ok(result)
    }

    fn catalog_for(&self, user: &AuthenticatedUser) -> Result<(String, Arc<Catalog>), ApiError> {
        self.initialize()?;
        let identity = self
            .users
            .account_id(&user.username)
            .map_err(ApiError::internal)?;
        let mut catalog = self.catalog()?;
        if user.role == Role::Admin
            && catalog
                .projects
                .get("default")
                .is_some_and(|p| p.owner.is_none())
        {
            self.mutate(|catalog| {
                if let Some(project) = catalog.projects.get_mut("default") {
                    if project.owner.is_none() {
                        project.owner = Some(user.username.clone());
                        project.owner_id = Some(identity.clone());
                    }
                }
                Ok(())
            })?;
            catalog = self.catalog()?;
        }
        Ok((identity, catalog))
    }

    pub(super) fn list(&self, user: &AuthenticatedUser) -> Result<Vec<Summary>, ApiError> {
        let (identity, catalog) = self.catalog_for(user)?;
        catalog
            .projects
            .iter()
            .filter(|(_, p)| p.visible(&identity))
            .map(|(id, p)| self.summarize(p, id, &identity))
            .collect()
    }

    pub(super) fn project(&self, id: &str, user: &str) -> Result<Project, ApiError> {
        self.with_project(id, user, |project| Ok(project.clone()))
    }

    pub(super) fn with_project<T>(
        &self,
        id: &str,
        user: &str,
        operation: impl FnOnce(&Project) -> Result<T, ApiError>,
    ) -> Result<T, ApiError> {
        let catalog = self.catalog()?;
        let project = catalog
            .projects
            .get(id)
            .filter(|p| p.visible(user))
            .ok_or_else(|| {
                ApiError::forbidden(
                    "This project is private, removed, or no longer shared with you.",
                )
            })?;
        operation(project)
    }

    pub(super) fn resolve(
        self: &Arc<Self>,
        id: &str,
        user: &AuthenticatedUser,
    ) -> Result<Access, ApiError> {
        if !valid_id(id) {
            return Err(ApiError::bad_request("Invalid project identifier."));
        }
        let identity = if id == "default" {
            self.catalog_for(user)?.0
        } else {
            self.users
                .account_id(&user.username)
                .map_err(ApiError::internal)?
        };
        let library = self.with_project(id, &identity, |project| self.library(id, project))?;
        Ok(Access {
            registry: self.clone(),
            id: id.into(),
            username: user.username.clone(),
            identity,
            library,
            guest: None,
        })
    }

    fn library(&self, id: &str, project: &Project) -> Result<Arc<Library>, ApiError> {
        let mut libraries = self
            .libraries
            .lock()
            .map_err(|_| ApiError::internal("Projects are unavailable."))?;
        let library = match libraries.get(id) {
            Some(library) => library.clone(),
            None => {
                let mut library = Library::new(Arc::new(files::Root::open(&project.root)?));
                let store = self.storage()?.project(id);
                library.root.attach_resources(store.clone())?;
                library.store = Some(store);
                let library = Arc::new(library);
                libraries.insert(id.into(), library.clone());
                library
            }
        };
        if let Some(url) = project.repository.clone() {
            library.git.set_remote(super::git::Remote {
                url,
                token: project.token.clone(),
            })?;
        }
        Ok(library)
    }

    pub(super) fn storage(&self) -> Result<Arc<super::state_store::Store>, ApiError> {
        let mut storage = self
            .storage
            .lock()
            .map_err(|_| ApiError::internal("Workspace storage is unavailable."))?;
        if let Some(store) = &*storage {
            return Ok(store.clone());
        }
        let store = super::state_store::Store::open(&self.managed.join(".state/workspace.sqlite"))?;
        *storage = Some(store.clone());
        Ok(store)
    }

    fn insert(
        &self,
        user: &AuthenticatedUser,
        id: String,
        project: Project,
    ) -> Result<Summary, ApiError> {
        let identity = self
            .users
            .account_id(&user.username)
            .map_err(ApiError::internal)?;
        self.mutate(|catalog| {
            if catalog.projects.len() >= 1024
                || catalog
                    .projects
                    .values()
                    .filter(|p| p.owned(&identity))
                    .count()
                    >= 128
            {
                return Err(ApiError::conflict(
                    "The project limit has been reached (128 per user).",
                ));
            }
            if catalog
                .projects
                .values()
                .any(|p| p.root.starts_with(&project.root) || project.root.starts_with(&p.root))
            {
                return Err(ApiError::conflict(
                    "This directory overlaps an existing project.",
                ));
            }
            let summary = self.summarize(&project, &id, &identity)?;
            catalog.projects.insert(id, project);
            Ok(summary)
        })
    }

    fn manage(
        &self,
        id: &str,
        user: &str,
        name: Option<String>,
        path: Option<String>,
        shared: Sharing,
        image_directory: Option<String>,
    ) -> Result<Summary, ApiError> {
        let identity = self.users.account_id(user).map_err(ApiError::internal)?;
        self.mutate(|catalog| {
            let project = catalog
                .projects
                .get_mut(id)
                .filter(|p| p.owned(&identity))
                .ok_or_else(|| ApiError::forbidden("Only the project owner can change sharing."))?;
            if let Some(path) = path {
                let root = files::Root::open(&project.root)?;
                let path = root.canonical_document_path(&path)?;
                let doc = root.document(&path)?;
                if project.pages.len() >= 5000 && !project.pages.contains_key(&path) {
                    return Err(ApiError::conflict(
                        "The document permission limit was reached.",
                    ));
                }
                let referenced = super::markdown::referenced_assets(&path, &doc.content);
                project.attachments.insert(path.clone(), referenced);
                project.public_links.remove(&path);
                project.pages.insert(path, shared);
            } else {
                if let Some(name) = name {
                    project.name = validate_name(name)?;
                }
                project.shared = shared;
                if let Some(directory) = image_directory {
                    files::validate_relative(&directory)?;
                    project.image_directory = directory;
                }
            }
            self.summarize(project, id, &identity)
        })
    }
}

pub(super) fn default_image_directory() -> String {
    "assets/images".into()
}

fn valid_id(id: &str) -> bool {
    id == "default" || (id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

fn validate_name(name: String) -> Result<String, ApiError> {
    let name = name.trim();
    if name.is_empty() || name.len() > 200 || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(
            "Project names must contain 1-200 bytes without control characters.",
        ));
    }
    Ok(name.into())
}

fn private_directory(path: &Path) -> Result<(), ApiError> {
    let builder = fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    builder
        .create(path)
        .map_err(|error| ApiError::io("Could not create the project directory", error))
}
