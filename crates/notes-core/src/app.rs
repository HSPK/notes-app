use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::{
    RunningServer,
    auth::UserStore,
    server,
    settings::{Settings, SettingsStore},
};

/// A desktop-neutral controller. Wrappers own windows, menus and browser launch.
pub struct NotesCore {
    settings: Settings,
    settings_store: SettingsStore,
    user_store: UserStore,
    first_run: bool,
    service: Option<RunningServer>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub has_folder: bool,
    pub port: u16,
}

impl NotesCore {
    pub fn new(settings_path: Option<PathBuf>) -> Result<Self, String> {
        let settings_store = settings_path
            .map(SettingsStore::new)
            .map_or_else(SettingsStore::platform_default, Ok)?;
        let user_store = UserStore::alongside_settings(settings_store.path());
        let loaded = settings_store.load()?;
        Ok(Self {
            first_run: loaded.is_none(),
            settings: loaded.unwrap_or_default(),
            settings_store,
            user_store,
            service: None,
        })
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }
    pub fn settings_path(&self) -> &Path {
        self.settings_store.path()
    }
    pub fn is_first_run(&self) -> bool {
        self.first_run
    }
    pub fn status(&self) -> Status {
        Status {
            running: self.service.as_ref().is_some_and(RunningServer::is_running),
            has_folder: self.settings.directory.is_dir(),
            port: self.settings.port,
        }
    }

    pub fn save_settings(&mut self, mut settings: Settings) -> Result<(), String> {
        if let Some(persisted) = self.settings_store.load()? {
            settings.web = persisted.web;
        }
        settings.validate()?;
        if !settings.directory.as_os_str().is_empty() {
            settings.directory = settings
                .directory
                .canonicalize()
                .map_err(|error| format!("Could not open the selected folder: {error}"))?;
            if !settings.directory.is_dir() {
                return Err("Choose a folder, not a file.".into());
            }
        }
        let current_directory = self
            .service
            .as_ref()
            .map(RunningServer::root)
            .unwrap_or(&self.settings.directory);
        let location_changed =
            settings.directory != current_directory || settings.port != self.settings.port;
        if self.service.is_some() && location_changed {
            return Err("Stop the notes service before changing its folder or port.".into());
        }
        let mut prepared = if location_changed && !settings.directory.as_os_str().is_empty() {
            let service = server::start_with_users(
                &settings.directory,
                settings.port,
                self.user_store.clone(),
            )?;
            service.set_appearance(settings.appearance.clone())?;
            Some(service)
        } else {
            None
        };
        if !settings.auto_start {
            if let Some(mut service) = prepared.take() {
                service.stop()?;
            }
        }
        self.settings_store.save(&settings)?;
        self.settings = settings;
        self.first_run = false;
        if let Some(service) = prepared {
            self.service = Some(service);
        }
        if let Some(service) = &self.service {
            service.set_appearance(self.settings.appearance.clone())?;
        }
        Ok(())
    }

    pub fn start(&mut self) -> Result<(), String> {
        if self.status().running {
            return Ok(());
        }
        self.stop()?;
        if self.settings.directory.as_os_str().is_empty() {
            return Err("Choose a notes folder in Settings first.".into());
        }
        let service = server::start_with_users(
            &self.settings.directory,
            self.settings.port,
            self.user_store.clone(),
        )?;
        service.set_appearance(self.settings.appearance.clone())?;
        self.service = Some(service);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(mut service) = self.service.take() {
            service.stop()?;
        }
        Ok(())
    }

    /// Ensures the local service is running, but never opens a browser itself.
    pub fn open_url(&mut self) -> Result<String, String> {
        self.start()?;
        self.service
            .as_ref()
            .map(|service| service.url().to_owned())
            .ok_or_else(|| "The local server is unavailable.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::appearance::Theme;

    #[test]
    fn controller_preserves_running_session_when_appearance_changes() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("controller-{}", std::process::id()));
        std::fs::create_dir_all(base.join("notes")).unwrap();
        let path = base.join("settings.json");
        let mut core = NotesCore::new(Some(path.clone())).unwrap();
        assert!(core.is_first_run());
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let mut settings = core.settings().clone();
        settings.directory = base.join("notes");
        settings.port = port;
        core.save_settings(settings.clone()).unwrap();
        let url = core.open_url().unwrap();
        settings.directory = settings.directory.canonicalize().unwrap();
        settings.appearance.theme = Theme::Dark;
        let mut persisted = SettingsStore::new(path.clone()).load().unwrap().unwrap();
        persisted.web.auto_save_delay_ms = 2000;
        SettingsStore::new(path.clone()).save(&persisted).unwrap();
        core.save_settings(settings.clone()).unwrap();
        assert_eq!(core.open_url().unwrap(), url);
        assert_eq!(
            SettingsStore::new(path)
                .load()
                .unwrap()
                .unwrap()
                .appearance
                .theme,
            Theme::Dark
        );
        assert_eq!(core.settings().web.auto_save_delay_ms, 2000);
        settings.port = if port == 65535 { 8123 } else { port + 1 };
        assert!(core.save_settings(settings).is_err());
        assert_eq!(core.status().port, port);
        core.stop().unwrap();
        drop(core);
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn an_occupied_port_does_not_persist_a_broken_configuration() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("controller-port-{}", std::process::id()));
        std::fs::create_dir_all(base.join("notes")).unwrap();
        let path = base.join("settings.json");
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let mut core = NotesCore::new(Some(path.clone())).unwrap();
        let mut settings = core.settings().clone();
        settings.directory = base.join("notes");
        settings.port = listener.local_addr().unwrap().port();
        assert!(core.save_settings(settings).is_err());
        assert!(!path.exists());
        assert!(!core.status().running);
        assert!(!core.status().has_folder);
        drop(core);
        std::fs::remove_dir_all(base).unwrap();
    }
}
