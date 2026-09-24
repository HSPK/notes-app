//! Shared local-notes runtime. Host adapters own UI, arguments, and process lifecycle.

pub mod app;
pub mod appearance;
pub mod auth;
pub mod server;
pub mod settings;

mod storage;

pub use app::NotesCore;
pub use server::{RunningServer, start};
