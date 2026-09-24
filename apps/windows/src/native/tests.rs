use super::*;
use notes_core::settings::SettingsStore;
use std::{
    process::{Child, Command},
    time::{Duration, Instant},
};

struct Fixture {
    child: Child,
    directory: PathBuf,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
struct Windows {
    pid: u32,
    owner: HWND,
    settings: HWND,
}
unsafe extern "system" fn enumerate(hwnd: HWND, parameter: LPARAM) -> i32 {
    unsafe {
        let windows = &mut *(parameter as *mut Windows);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid != windows.pid {
            return 1;
        }
        let mut class = [0u16; 128];
        let count = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        if String::from_utf16_lossy(&class[..count as usize]) != CLASS {
            return 1;
        }
        if GetWindow(hwnd, GW_OWNER).is_null() {
            windows.owner = hwnd;
        } else {
            windows.settings = hwnd;
        }
        1
    }
}
fn find(pid: u32, settings: bool) -> HWND {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let mut windows = Windows {
            pid,
            owner: null_mut(),
            settings: null_mut(),
        };
        unsafe {
            EnumWindows(Some(enumerate), &mut windows as *mut Windows as LPARAM);
        }
        let result = if settings {
            windows.settings
        } else {
            windows.owner
        };
        let ready = !result.is_null()
            && unsafe {
                if settings {
                    !GetDlgItem(result, PORT).is_null()
                } else {
                    !GetMenu(result).is_null()
                }
            };
        if ready || Instant::now() >= deadline {
            return result;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}
unsafe fn send(hwnd: HWND, command: usize) {
    unsafe {
        let mut result = 0;
        assert_ne!(
            SendMessageTimeoutW(
                hwnd,
                WM_COMMAND,
                command,
                0,
                SMTO_ABORTIFHUNG,
                3000,
                &mut result
            ),
            0
        );
    }
}

/// Run explicitly with NOTES_NATIVE_SMOKE_EXE set to the built notes.exe.
#[test]
#[ignore = "requires an interactive Windows desktop and a built notes.exe"]
fn isolated_native_settings_and_quit() {
    unsafe {
        let mutex = OpenMutexW(
            MUTEX_ALL_ACCESS,
            0,
            wide("Local\\RustMarkdownNotes.Native.v2").as_ptr(),
        );
        if !mutex.is_null() {
            CloseHandle(mutex);
            eprintln!(
                "Skipping external native smoke: another Notes instance owns the shared singleton."
            );
            return;
        }
        if GetLastError() != ERROR_FILE_NOT_FOUND {
            eprintln!(
                "Skipping external native smoke: could not safely establish singleton availability."
            );
            return;
        }
    }
    let exe = std::env::var_os("NOTES_NATIVE_SMOKE_EXE").expect("Set NOTES_NATIVE_SMOKE_EXE");
    let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!("native-smoke-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let config = Settings {
        directory: directory.clone(),
        auto_start: false,
        auto_open_browser: false,
        ..Settings::default()
    };
    let path = directory.join("NotesApp").join("settings.json");
    let store = SettingsStore::new(path.clone());
    store.save(&config).unwrap();
    let child = Command::new(exe)
        .env("LOCALAPPDATA", &directory)
        .spawn()
        .unwrap();
    let mut fixture = Fixture { child, directory };
    let owner = find(fixture.child.id(), false);
    assert!(
        !owner.is_null(),
        "Native owner window was not created; child exit: {:?}",
        fixture.child.try_wait()
    );
    std::thread::sleep(Duration::from_millis(500));
    unsafe {
        assert!(
            !GetMenu(owner).is_null(),
            "Fallback menu missing; window valid={}, child={:?}",
            IsWindow(owner),
            fixture.child.try_wait()
        );
        send(owner, SETTINGS);
        let settings = find(fixture.child.id(), true);
        assert!(!settings.is_null(), "Settings window was not created");
        std::thread::sleep(Duration::from_millis(250));
        assert!(
            !GetDlgItem(settings, PORT).is_null(),
            "Port control missing"
        );
        let mut port = [0u16; 16];
        let count = SendMessageW(
            GetDlgItem(settings, PORT),
            WM_GETTEXT,
            port.len(),
            port.as_mut_ptr() as LPARAM,
        );
        assert_eq!(String::from_utf16_lossy(&port[..count as usize]), "8123");
        assert_eq!(SendDlgItemMessageW(settings, AUTO, BM_GETCHECK, 0, 0), 0);
        assert_eq!(SendDlgItemMessageW(settings, BROWSER, BM_GETCHECK, 0, 0), 0);
        SendMessageW(
            GetDlgItem(settings, PORT),
            WM_SETTEXT,
            0,
            wide("8124").as_ptr() as LPARAM,
        );
        // Editing then cancelling must not mutate persisted preferences.
        send(settings, CANCEL);
        assert_eq!(store.load().unwrap().unwrap().port, 8123);
        send(owner, SETTINGS);
        let settings = find(fixture.child.id(), true);
        assert!(!settings.is_null());
        SendMessageW(GetDlgItem(settings, AUTO), BM_SETCHECK, 1, 0);
        send(settings, SAVE);
        assert!(store.load().unwrap().unwrap().auto_start);
        send(owner, QUIT);
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = fixture.child.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline, "Native quit timed out");
        std::thread::sleep(Duration::from_millis(50));
    }
}
#[test]
fn tray_protocol_dispatch_has_one_activation_path() {
    assert_eq!(tray_action(true, NIN_SELECT), TrayAction::Open);
    assert_eq!(tray_action(true, NIN_KEYSELECT), TrayAction::Open);
    assert_eq!(tray_action(true, WM_LBUTTONUP), TrayAction::None);
    assert_eq!(tray_action(true, WM_LBUTTONDBLCLK), TrayAction::None);
    assert_eq!(tray_action(true, WM_RBUTTONUP), TrayAction::None);
    assert_eq!(tray_action(true, WM_CONTEXTMENU), TrayAction::Menu);
    assert_eq!(tray_action(false, WM_LBUTTONUP), TrayAction::Open);
    assert_eq!(tray_action(false, WM_LBUTTONDBLCLK), TrayAction::None);
    assert_eq!(tray_action(false, NIN_SELECT), TrayAction::None);
    assert_eq!(tray_action(false, WM_RBUTTONUP), TrayAction::Menu);
    let now = Instant::now();
    let interval = Duration::from_millis(500);
    let mut last = None;
    assert!(accept_activation(&mut last, now, interval));
    assert!(!accept_activation(
        &mut last,
        now + Duration::from_millis(100),
        interval
    ));
    assert!(accept_activation(
        &mut last,
        now + Duration::from_millis(600),
        interval
    ));
}

#[test]
fn in_process_settings_drafts_appearance_and_brushes() {
    unsafe {
        let class = wide(CLASS);
        let mut wc: WNDCLASSW = zeroed();
        wc.lpfnWndProc = Some(wndproc);
        wc.hInstance = GetModuleHandleW(null());
        wc.lpszClassName = class.as_ptr();
        wc.hbrBackground = GetSysColorBrush(COLOR_WINDOW);
        let atom = RegisterClassW(&wc);
        assert_ne!(atom, 0);
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            wide("Isolated native settings test").as_ptr(),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            100,
            100,
            null_mut(),
            null_mut(),
            wc.hInstance,
            null(),
        );
        assert!(!hwnd.is_null());
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("native-in-process-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let directory = directory.canonicalize().unwrap();
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = Settings {
            directory: directory.clone(),
            port,
            auto_start: false,
            auto_open_browser: false,
            ..Settings::default()
        };
        let path = directory.join("settings.json");
        let mut core = NotesCore::new(Some(path.clone())).unwrap();
        core.save_settings(config).unwrap();
        let original_url = core.open_url().unwrap();
        let mut app = Box::new(App {
            hwnd,
            preferences: null_mut(),
            core,
            last_running: true,
            taskbar_created: u32::MAX,
            tray_present: false,
            tray_version4: false,
            last_activation: None,
            settings_font: null_mut(),
        });
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut *app as *mut App as isize);
        app.settings();
        assert!(!app.preferences.is_null());
        assert!(!GetDlgItem(app.preferences, BROWSE as i32).is_null());
        preferences::layout(&mut app, 144);
        let mut scaled: RECT = zeroed();
        GetWindowRect(GetDlgItem(app.preferences, LATIN_FONT), &mut scaled);
        assert_eq!(scaled.right - scaled.left, 645);
        preferences::layout(&mut app, 96);
        let dc = GetDC(app.preferences);
        for msg in [WM_CTLCOLORSTATIC, WM_CTLCOLORBTN] {
            assert_eq!(
                SendMessageW(app.preferences, msg, dc as usize, 0),
                GetSysColorBrush(COLOR_WINDOW) as isize
            );
            assert_eq!(GetBkMode(dc), TRANSPARENT as i32);
            assert_eq!(GetTextColor(dc), GetSysColor(COLOR_WINDOWTEXT));
        }
        ReleaseDC(app.preferences, dc);
        SetDlgItemTextW(
            app.preferences,
            DIRECTORY,
            wide("C:\\unsaved-folder-draft").as_ptr(),
        );
        SetDlgItemTextW(app.preferences, LATIN_FONT, wide("Draft Font").as_ptr());
        let draft = preferences::read(app.preferences, app.core.settings()).unwrap();
        assert_eq!(draft.directory, PathBuf::from("C:\\unsaved-folder-draft"));
        assert_eq!(app.core.settings().directory, directory);
        app.command(app.preferences, CANCEL);
        app.settings();
        let restored = preferences::read(app.preferences, app.core.settings()).unwrap();
        assert_eq!(restored.directory, directory);
        assert_eq!(
            restored.appearance,
            notes_core::appearance::Appearance::default()
        );
        SendDlgItemMessageW(app.preferences, THEME, CB_SETCURSEL, 2, 0);
        SetDlgItemTextW(app.preferences, LATIN_FONT, wide("Georgia").as_ptr());
        SetDlgItemTextW(app.preferences, CJK_FONT, wide("微软雅黑").as_ptr());
        app.command(app.preferences, SAVE);
        assert!(app.preferences.is_null());
        assert_eq!(
            app.core.settings().appearance.theme,
            notes_core::appearance::Theme::Dark
        );
        assert_eq!(
            SettingsStore::new(&path)
                .load()
                .unwrap()
                .unwrap()
                .appearance,
            app.core.settings().appearance
        );
        assert!(app.core.status().running);
        assert_eq!(app.core.open_url().unwrap(), original_url);
        // A stopped, test-owned service may change roots; drafts still commit only on Save.
        app.core.stop().unwrap();
        let replacement = directory.join("replacement");
        std::fs::create_dir(&replacement).unwrap();
        app.settings();
        SetDlgItemTextW(app.preferences, DIRECTORY, path_wide(&replacement).as_ptr());
        assert_eq!(app.core.settings().directory, directory);
        app.command(app.preferences, SAVE);
        assert_eq!(app.core.settings().directory, replacement);
        app.core.start().unwrap();
        assert!(app.core.status().running);
        app.core.stop().unwrap();
        app.core = NotesCore::new(Some(directory.join("first-run.json"))).unwrap();
        app.open();
        assert!(
            !app.preferences.is_null(),
            "Missing-folder Open should show Settings, not launch a browser"
        );
        assert!(!app.core.status().running);
        app.command(app.preferences, CANCEL);
        let popup = menu(true);
        assert_eq!(GetMenuItemCount(popup), 5);
        DestroyMenu(popup);
        // Only windows and service created inside this test are destroyed.
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
        DestroyWindow(hwnd);
        drop(app);
        UnregisterClassW(class.as_ptr(), wc.hInstance);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
