use notes_core::{NotesCore, settings::Settings};
use std::{
    mem::{size_of, zeroed},
    path::PathBuf,
    ptr::{null, null_mut},
};
use windows_sys::Win32::{
    Foundation::*,
    Graphics::Gdi::*,
    System::{Com::*, LibraryLoader::*, Threading::*},
    UI::{Shell::*, WindowsAndMessaging::*},
};

const CLASS: &str = "RustMarkdownNotes.Owner.v2";
#[path = "native/preferences.rs"]
mod preferences;
#[cfg(test)]
#[path = "native/tests.rs"]
mod tests;
const TRAY: u32 = WM_APP + 1;
const OPEN: usize = 101;
const BROWSE: usize = 203;
const SETTINGS: usize = 103;
const FOLDER: usize = 104;
const TOGGLE: usize = 105;
const QUIT: usize = 106;
const SAVE: usize = 201;
const CANCEL: usize = 202;
const PORT: i32 = 301;
const AUTO: i32 = 302;
const BROWSER: i32 = 303;
const DIRECTORY: i32 = 304;
const THEME: i32 = 305;
const LATIN_FONT: i32 = 306;
const CJK_FONT: i32 = 307;
const NIN_KEYSELECT: u32 = NIN_SELECT | NINF_KEY;

#[link(name = "user32")]
unsafe extern "system" {
    fn GetDoubleClickTime() -> u32;
    fn SetFocus(hwnd: HWND) -> HWND;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}
fn path_wide(p: &std::path::Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    p.as_os_str().encode_wide().chain(Some(0)).collect()
}
unsafe fn message(hwnd: HWND, text: &str) {
    unsafe {
        MessageBoxW(
            hwnd,
            wide(text).as_ptr(),
            wide("Rust Markdown Notes").as_ptr(),
            MB_OK | MB_ICONINFORMATION,
        );
    }
}

struct App {
    hwnd: HWND,
    preferences: HWND,
    core: NotesCore,
    last_running: bool,
    taskbar_created: u32,
    tray_present: bool,
    tray_version4: bool,
    last_activation: Option<std::time::Instant>,
    settings_font: HFONT,
}

impl App {
    unsafe fn tray(&mut self, add: bool) {
        unsafe {
            let mut data: NOTIFYICONDATAW = zeroed();
            data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
            data.hWnd = self.hwnd;
            data.uID = 1;
            data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
            data.uCallbackMessage = TRAY;
            data.hIcon = LoadImageW(
                GetModuleHandleW(null()),
                1usize as *const u16,
                IMAGE_ICON,
                GetSystemMetrics(SM_CXSMICON),
                GetSystemMetrics(SM_CYSMICON),
                LR_SHARED,
            );
            if data.hIcon.is_null() {
                eprintln!(
                    "Could not load the small Notes icon: {}",
                    std::io::Error::last_os_error()
                );
                data.hIcon = LoadIconW(null_mut(), IDI_APPLICATION);
            }
            let running = self.core.status().running;
            let status = if running { "Running" } else { "Stopped" };
            let bar = GetMenu(self.hwnd);
            if !bar.is_null() {
                let submenu = GetSubMenu(bar, 0);
                ModifyMenuW(
                    submenu,
                    TOGGLE as u32,
                    MF_BYCOMMAND | MF_STRING,
                    TOGGLE,
                    wide(if running {
                        "Stop service"
                    } else {
                        "Start service"
                    })
                    .as_ptr(),
                );
                DrawMenuBar(self.hwnd);
            }
            let tip = wide(&format!("Rust Markdown Notes — {status}"));
            data.szTip[..tip.len()].copy_from_slice(&tip);
            self.tray_present =
                Shell_NotifyIconW(if add { NIM_ADD } else { NIM_MODIFY }, &data) != 0;
            if add {
                data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
                self.tray_version4 =
                    self.tray_present && Shell_NotifyIconW(NIM_SETVERSION, &data) != 0;
            }
            if !self.tray_present {
                ShowWindow(self.hwnd, SW_SHOW);
            }
        }
    }
    unsafe fn launch(&self, target: &[u16]) {
        unsafe {
            let result = ShellExecuteW(
                self.hwnd,
                wide("open").as_ptr(),
                target.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            );
            if result as isize <= 32 {
                message(
                    self.hwnd,
                    "Windows could not open the default browser or folder.",
                );
            }
        }
    }
    unsafe fn open(&mut self) {
        unsafe {
            if !self.core.status().has_folder {
                self.settings();
                return;
            }
            match self.core.open_url() {
                Ok(url) => self.launch(&wide(&url)),
                Err(error) => message(self.hwnd, &error),
            }
            self.last_running = self.core.status().running;
            self.tray(false);
        }
    }
    unsafe fn start(&mut self) {
        unsafe {
            if !self.core.status().has_folder {
                self.settings();
                return;
            }
            if let Err(e) = self.core.start() {
                message(
                    self.hwnd,
                    &format!(
                        "Could not start notes: {e}\nChoose another folder or change the port in Settings. No existing service was attached."
                    ),
                );
            }
            self.last_running = self.core.status().running;
            self.tray(false);
        }
    }
    unsafe fn pick_folder(&self) -> Option<PathBuf> {
        unsafe {
            let title = wide("Choose the folder containing your Markdown notes");
            let mut info: BROWSEINFOW = zeroed();
            info.hwndOwner = self.preferences;
            info.lpszTitle = title.as_ptr();
            info.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
            let item = SHBrowseForFolderW(&info);
            if item.is_null() {
                return None;
            }
            let mut buffer = [0u16; 260];
            let valid = SHGetPathFromIDListW(item, buffer.as_mut_ptr()) != 0;
            CoTaskMemFree(item.cast());
            if !valid {
                message(self.hwnd, "Please select a filesystem folder.");
                return None;
            }
            use std::os::windows::ffi::OsStringExt;
            let len = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
            Some(PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len])))
        }
    }
    unsafe fn apply(&mut self, next: Settings) -> bool {
        unsafe {
            if let Err(e) = self.core.save_settings(next) {
                message(self.preferences, &e);
                return false;
            }
            self.last_running |= self.core.status().running;
            self.tray(false);
            true
        }
    }
    unsafe fn settings(&mut self) {
        unsafe {
            preferences::create(self);
        }
    }
    unsafe fn command(&mut self, hwnd: HWND, command: usize) {
        unsafe {
            match command {
                OPEN => self.open(),
                BROWSE if hwnd == self.preferences => {
                    if let Some(directory) = self.pick_folder() {
                        SetDlgItemTextW(hwnd, DIRECTORY, path_wide(&directory).as_ptr());
                    }
                }
                SETTINGS => self.settings(),
                FOLDER => {
                    if self.core.status().has_folder {
                        self.launch(&path_wide(&self.core.settings().directory));
                    } else {
                        self.settings();
                    }
                }
                TOGGLE => {
                    if self.core.status().running {
                        message(
                            hwnd,
                            "Stopping this app's service. Existing browser sessions will become stale; reopen Notes after restarting.",
                        );
                        if let Err(e) = self.core.stop() {
                            message(hwnd, &e);
                        }
                        self.last_running = false;
                    } else {
                        self.start();
                    }
                    self.tray(false);
                }
                QUIT => {
                    DestroyWindow(self.hwnd);
                }
                SAVE => {
                    let next = match preferences::read(hwnd, self.core.settings()) {
                        Ok(next) => next,
                        Err(e) => {
                            message(hwnd, &e);
                            return;
                        }
                    };
                    if self.apply(next) {
                        DestroyWindow(hwnd);
                    }
                }
                CANCEL => {
                    DestroyWindow(hwnd);
                }
                _ => {}
            }
        }
    }
}

unsafe fn menu(service: bool) -> HMENU {
    unsafe {
        let menu = CreatePopupMenu();
        for (id, label) in [
            (OPEN, "Open Notes"),
            (SETTINGS, "Settings…"),
            (FOLDER, "Show folder"),
            (
                TOGGLE,
                if service {
                    "Stop service"
                } else {
                    "Start service"
                },
            ),
            (QUIT, "Quit"),
        ] {
            AppendMenuW(menu, MF_STRING, id, wide(label).as_ptr());
        }
        menu
    }
}

#[derive(Debug, PartialEq)]
enum TrayAction {
    Open,
    Menu,
    None,
}

fn tray_action(version4: bool, event: u32) -> TrayAction {
    if version4 {
        match event {
            NIN_SELECT | NIN_KEYSELECT => TrayAction::Open,
            WM_CONTEXTMENU => TrayAction::Menu,
            _ => TrayAction::None,
        }
    } else {
        match event {
            WM_LBUTTONUP => TrayAction::Open,
            WM_RBUTTONUP => TrayAction::Menu,
            _ => TrayAction::None,
        }
    }
}

fn accept_activation(
    last: &mut Option<std::time::Instant>,
    now: std::time::Instant,
    interval: std::time::Duration,
) -> bool {
    if last.is_some_and(|previous| now.duration_since(previous) <= interval) {
        return false;
    }
    *last = Some(now);
    true
}

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    unsafe {
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut App;
        if ptr.is_null() {
            return DefWindowProcW(hwnd, msg, wp, lp);
        }
        let app = &mut *ptr;
        if msg == app.taskbar_created {
            app.tray(true);
            return 0;
        }
        match msg {
            WM_CTLCOLORSTATIC | WM_CTLCOLORBTN if hwnd == app.preferences => {
                preferences::label_brush(wp as HDC)
            }
            WM_DPICHANGED if hwnd == app.preferences => {
                let rect = &*(lp as *const RECT);
                SetWindowPos(
                    hwnd,
                    null_mut(),
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                preferences::layout(app, (wp & 0xffff) as u32);
                0
            }
            WM_COMMAND => {
                app.command(hwnd, wp & 0xffff);
                0
            }
            TRAY => {
                let event = if app.tray_version4 {
                    lp as u32 & 0xffff
                } else {
                    lp as u32
                };
                let action = tray_action(app.tray_version4, event);
                if action == TrayAction::Open {
                    let now = std::time::Instant::now();
                    let interval = std::time::Duration::from_millis(GetDoubleClickTime() as u64);
                    if accept_activation(&mut app.last_activation, now, interval) {
                        app.open();
                    }
                }
                if action == TrayAction::Menu {
                    let popup = menu(app.core.status().running);
                    let mut point: POINT = zeroed();
                    if app.tray_version4 {
                        point.x = (wp as u16 as i16) as i32;
                        point.y = ((wp >> 16) as u16 as i16) as i32;
                    }
                    if !app.tray_version4 || (point.x == -1 && point.y == -1) {
                        GetCursorPos(&mut point);
                    }
                    SetForegroundWindow(hwnd);
                    let command = TrackPopupMenu(
                        popup,
                        TPM_RETURNCMD | TPM_RIGHTBUTTON,
                        point.x,
                        point.y,
                        0,
                        hwnd,
                        null(),
                    );
                    DestroyMenu(popup);
                    if command != 0 {
                        app.command(hwnd, command as usize);
                    }
                    PostMessageW(hwnd, WM_NULL, 0, 0);
                }
                0
            }
            WM_TIMER => {
                if app.last_running && !app.core.status().running {
                    let _ = app.core.stop();
                    app.last_running = false;
                    app.tray(false);
                    message(
                        hwnd,
                        "The notes service stopped unexpectedly. Use Start service to retry, or Settings to change its port.",
                    );
                }
                if !app.tray_present {
                    app.tray(true);
                }
                0
            }
            WM_CLOSE => {
                DestroyWindow(hwnd);
                0
            }
            WM_QUERYENDSESSION => 1,
            WM_ENDSESSION => {
                if wp != 0 {
                    let _ = app.core.stop();
                }
                0
            }
            WM_DESTROY => {
                if hwnd == app.preferences {
                    app.preferences = null_mut();
                    if !app.settings_font.is_null() {
                        DeleteObject(app.settings_font);
                        app.settings_font = null_mut();
                    }
                } else {
                    KillTimer(hwnd, 1);
                    let mut data: NOTIFYICONDATAW = zeroed();
                    data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
                    data.hWnd = hwnd;
                    data.uID = 1;
                    Shell_NotifyIconW(NIM_DELETE, &data);
                    if let Err(e) = app.core.stop() {
                        message(hwnd, &e);
                    }
                    PostQuitMessage(0);
                }
                0
            }
            _ => DefWindowProcW(hwnd, msg, wp, lp),
        }
    }
}

pub fn run() {
    unsafe {
        let mutex = CreateMutexW(
            null(),
            0,
            wide("Local\\RustMarkdownNotes.Native.v2").as_ptr(),
        );
        if mutex.is_null() {
            message(
                null_mut(),
                "Could not create the application instance lock.",
            );
            return;
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            message(
                null_mut(),
                "Rust Markdown Notes is already running. Use its notification-area icon (it may be under hidden icons).",
            );
            CloseHandle(mutex);
            return;
        }
        let com = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32);
        if com < 0 {
            message(null_mut(), "Could not initialize Windows shell dialogs.");
            CloseHandle(mutex);
            return;
        }
        run_inner();
        CoUninitialize();
        CloseHandle(mutex);
    }
}

unsafe fn run_inner() {
    unsafe {
        let core = match NotesCore::new(None) {
            Ok(core) => core,
            Err(e) => {
                message(null_mut(), &e);
                return;
            }
        };
        let class = wide(CLASS);
        let instance = GetModuleHandleW(null());
        let mut wc: WNDCLASSW = zeroed();
        wc.lpfnWndProc = Some(wndproc);
        wc.hInstance = instance;
        wc.lpszClassName = class.as_ptr();
        wc.hCursor = LoadCursorW(null_mut(), IDC_ARROW);
        wc.hIcon = LoadIconW(instance, 1usize as *const u16);
        wc.hbrBackground = (COLOR_WINDOW + 1) as HBRUSH;
        if RegisterClassW(&wc) == 0 {
            message(null_mut(), "Could not register the Notes window.");
            return;
        }
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            wide("Rust Markdown Notes — use the Notes menu").as_ptr(),
            WS_OVERLAPPEDWINDOW,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            560,
            180,
            null_mut(),
            null_mut(),
            instance,
            null(),
        );
        if hwnd.is_null() {
            message(null_mut(), "Could not create the Notes window.");
            return;
        }
        let mut app = Box::new(App {
            hwnd,
            preferences: null_mut(),
            core,
            last_running: false,
            taskbar_created: RegisterWindowMessageW(wide("TaskbarCreated").as_ptr()),
            tray_present: false,
            tray_version4: false,
            last_activation: None,
            settings_font: null_mut(),
        });
        SetWindowLongPtrW(hwnd, GWLP_USERDATA, &mut *app as *mut App as isize);
        let bar = CreateMenu();
        AppendMenuW(bar, MF_POPUP, menu(false) as usize, wide("Notes").as_ptr());
        SetMenu(hwnd, bar);
        app.tray(true);
        if app.core.is_first_run() || !app.core.status().has_folder {
            app.settings();
        } else {
            if app.core.settings().auto_start {
                app.start();
            }
            if app.core.settings().auto_open_browser && app.core.status().running {
                app.open();
            }
        }
        SetTimer(hwnd, 1, 2000, None);
        let mut msg: MSG = zeroed();
        loop {
            let result = GetMessageW(&mut msg, null_mut(), 0, 0);
            if result <= 0 {
                break;
            }
            if app.preferences.is_null() || IsDialogMessageW(app.preferences, &msg) == 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if IsWindow(hwnd) != 0 {
            DestroyWindow(hwnd);
        }
    }
}
