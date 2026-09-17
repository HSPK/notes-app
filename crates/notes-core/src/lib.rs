//! Shared local-notes runtime. Native wrappers provide UI, not document logic.

pub mod app;
pub mod appearance;
pub mod command;
pub mod server;
pub mod settings;

pub use app::NotesCore;
pub use server::{RunningServer, start};
