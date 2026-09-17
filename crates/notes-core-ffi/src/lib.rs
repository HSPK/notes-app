//! Small, owned C ABI for native wrappers that do not link Rust directly.

use std::{
    ffi::{CStr, CString, c_char},
    path::PathBuf,
    ptr,
    sync::Mutex,
};

use notes_core::{NotesCore, settings::Settings};
use serde::Deserialize;
use serde_json::{Value, json};

pub struct NotesCoreHandle {
    core: Mutex<NotesCore>,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    GetSettings,
    SaveSettings { settings: Settings },
    Status,
    Start,
    Stop,
    OpenUrl,
}

fn owned_string(text: String) -> *mut c_char {
    CString::new(text.replace('\0', "\\0"))
        .expect("NUL bytes were escaped")
        .into_raw()
}

fn response(result: Result<Value, String>) -> *mut c_char {
    let value = result.unwrap_or_else(|error| json!({"ok": false, "error": error}));
    owned_string(value.to_string())
}

#[unsafe(no_mangle)]
pub extern "C" fn notes_core_abi_version() -> u32 {
    1
}

/// # Safety
/// Any non-null input points to a valid NUL-terminated string; error_out is writable.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn notes_core_create(
    settings_path: *const c_char,
    error_out: *mut *mut c_char,
) -> *mut NotesCoreHandle {
    if !error_out.is_null() {
        unsafe { *error_out = ptr::null_mut() };
    }
    let result = (|| {
        let path = if settings_path.is_null() {
            None
        } else {
            Some(PathBuf::from(
                unsafe { CStr::from_ptr(settings_path) }
                    .to_str()
                    .map_err(|error| format!("Settings path must be UTF-8: {error}"))?,
            ))
        };
        NotesCore::new(path)
    })();
    match result {
        Ok(core) => Box::into_raw(Box::new(NotesCoreHandle {
            core: Mutex::new(core),
        })),
        Err(error) => {
            if error_out.is_null() {
                eprintln!("Could not create Notes Core: {error}");
            } else {
                unsafe { *error_out = owned_string(error) };
            }
            ptr::null_mut()
        }
    }
}

/// # Safety
/// The handle is owned by the caller, not already freed, and has no active requests.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn notes_core_free(handle: *mut NotesCoreHandle) {
    if !handle.is_null() {
        drop(unsafe { Box::from_raw(handle) });
    }
}

/// # Safety
/// The handle remains alive for the call. request_json is a valid C string or NULL.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn notes_core_request(
    handle: *mut NotesCoreHandle,
    request_json: *const c_char,
) -> *mut c_char {
    response((|| {
        let handle = unsafe { handle.as_ref() }.ok_or("Notes Core handle is null.")?;
        if request_json.is_null() {
            return Err("Request is null.".into());
        }
        let text = unsafe { CStr::from_ptr(request_json) }
            .to_str()
            .map_err(|error| format!("Request must be UTF-8: {error}"))?;
        let request: Request = serde_json::from_str(text)
            .map_err(|error| format!("Invalid Notes Core request: {error}"))?;
        let mut core = handle
            .core
            .lock()
            .map_err(|_| "Notes Core state is unavailable.")?;
        match request {
            Request::GetSettings => Ok(json!({
                "ok": true,
                "firstRun": core.is_first_run(),
                "settings": serde_json::to_value(core.settings()).map_err(|error| error.to_string())?,
            })),
            Request::SaveSettings { settings } => {
                core.save_settings(settings)?;
                Ok(
                    json!({"ok": true, "settings": serde_json::to_value(core.settings()).map_err(|error| error.to_string())?}),
                )
            }
            Request::Status => Ok(json!({"ok": true, "status": core.status()})),
            Request::Start => {
                core.start()?;
                Ok(json!({"ok": true, "status": core.status()}))
            }
            Request::Stop => {
                core.stop()?;
                Ok(json!({"ok": true, "status": core.status()}))
            }
            Request::OpenUrl => Ok(json!({"ok": true, "url": core.open_url()?})),
        }
    })())
}

/// # Safety
/// text is NULL or a string returned by this ABI that has not already been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn notes_core_string_free(text: *mut c_char) {
    if !text.is_null() {
        drop(unsafe { CString::from_raw(text) });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    unsafe fn call(handle: *mut NotesCoreHandle, value: Value) -> Value {
        let text = CString::new(value.to_string()).unwrap();
        let reply = unsafe { notes_core_request(handle, text.as_ptr()) };
        let parsed =
            serde_json::from_str(unsafe { CStr::from_ptr(reply) }.to_str().unwrap()).unwrap();
        unsafe { notes_core_string_free(reply) };
        parsed
    }

    #[test]
    fn c_api_owns_results_and_reports_invalid_requests() {
        let base = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("ffi-test-{}", std::process::id()));
        std::fs::create_dir_all(base.join("notes")).unwrap();
        let path = CString::new(base.join("settings.json").to_str().unwrap()).unwrap();
        let mut error = ptr::null_mut();
        let handle = unsafe { notes_core_create(path.as_ptr(), &mut error) };
        assert!(!handle.is_null());
        assert!(error.is_null());
        let initial = unsafe { call(handle, json!({"op":"get_settings"})) };
        assert_eq!(initial["firstRun"], true);
        let mut settings = initial["settings"].clone();
        settings["Directory"] = json!(base.join("notes"));
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        settings["Port"] = json!(listener.local_addr().unwrap().port());
        settings["AutoStart"] = json!(false);
        drop(listener);
        let saved = unsafe { call(handle, json!({"op":"save_settings","settings":settings})) };
        assert_eq!(saved["ok"], true);
        assert_eq!(
            unsafe { call(handle, json!({"op":"status"})) }["status"]["hasFolder"],
            true
        );
        assert_eq!(
            unsafe { call(handle, json!({"op":"not_an_operation"})) }["ok"],
            false
        );
        assert_eq!(
            unsafe { call(ptr::null_mut(), json!({"op":"status"})) }["ok"],
            false
        );
        unsafe {
            notes_core_free(handle);
            notes_core_string_free(ptr::null_mut());
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}
