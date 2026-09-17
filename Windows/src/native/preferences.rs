use super::*;
use notes_core::appearance::Theme;
use std::collections::BTreeSet;
use windows_sys::Win32::UI::Controls::EM_SETLIMITTEXT;
use windows_sys::Win32::UI::HiDpi::{
    AdjustWindowRectExForDpi, GetDpiForWindow, SystemParametersInfoForDpi,
};

const STYLE: u32 = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
const EX_STYLE: u32 = WS_EX_DLGMODALFRAME | WS_EX_CONTROLPARENT;
const CONTROLS: &[(&str, &str, i32, i32, i32, i32, i32, u32)] = &[
    ("STATIC", "Notes folder", 401, 20, 18, 610, 23, 0),
    (
        "EDIT",
        "",
        DIRECTORY,
        20,
        46,
        508,
        28,
        WS_BORDER | ES_AUTOHSCROLL as u32 | WS_TABSTOP,
    ),
    (
        "BUTTON",
        "Browse…",
        BROWSE as i32,
        540,
        45,
        100,
        30,
        WS_TABSTOP,
    ),
    ("STATIC", "Service port", 402, 20, 100, 175, 25, 0),
    (
        "EDIT",
        "",
        PORT,
        210,
        96,
        130,
        28,
        WS_BORDER | ES_NUMBER as u32 | WS_TABSTOP,
    ),
    ("STATIC", "Editor theme", 403, 20, 150, 175, 25, 0),
    (
        "COMBOBOX",
        "",
        THEME,
        210,
        145,
        430,
        160,
        CBS_DROPDOWNLIST as u32 | WS_VSCROLL | WS_TABSTOP,
    ),
    ("STATIC", "English font", 404, 20, 200, 175, 25, 0),
    (
        "COMBOBOX",
        "",
        LATIN_FONT,
        210,
        195,
        430,
        280,
        CBS_DROPDOWN as u32 | CBS_AUTOHSCROLL as u32 | WS_VSCROLL | WS_TABSTOP,
    ),
    ("STATIC", "Chinese font", 405, 20, 250, 175, 25, 0),
    (
        "COMBOBOX",
        "",
        CJK_FONT,
        210,
        245,
        430,
        280,
        CBS_DROPDOWN as u32 | CBS_AUTOHSCROLL as u32 | WS_VSCROLL | WS_TABSTOP,
    ),
    (
        "BUTTON",
        "Start service when this app opens",
        AUTO,
        20,
        300,
        620,
        28,
        BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
    ),
    (
        "BUTTON",
        "Open browser when this app starts",
        BROWSER,
        20,
        336,
        620,
        28,
        BS_AUTOCHECKBOX as u32 | WS_TABSTOP,
    ),
    (
        "STATIC",
        "Appearance changes apply immediately after Save.\nStop the service before changing its folder or port.",
        406,
        20,
        379,
        620,
        48,
        0,
    ),
    (
        "BUTTON",
        "Save",
        SAVE as i32,
        430,
        442,
        100,
        32,
        BS_DEFPUSHBUTTON as u32 | WS_TABSTOP,
    ),
    (
        "BUTTON",
        "Cancel",
        CANCEL as i32,
        540,
        442,
        100,
        32,
        WS_TABSTOP,
    ),
];

unsafe extern "system" fn font_family(
    font: *const LOGFONTW,
    _: *const TEXTMETRICW,
    _: u32,
    parameter: LPARAM,
) -> i32 {
    unsafe {
        let face = &(*font).lfFaceName;
        let length = face.iter().position(|&c| c == 0).unwrap_or(face.len());
        let name = String::from_utf16_lossy(&face[..length]);
        if !name.is_empty() && !name.starts_with('@') {
            (*(parameter as *mut BTreeSet<String>)).insert(name);
        }
        1
    }
}

unsafe fn font_families(hwnd: HWND) -> BTreeSet<String> {
    unsafe {
        let mut families = BTreeSet::from([
            "Segoe UI".into(),
            "Arial".into(),
            "Georgia".into(),
            "Microsoft YaHei".into(),
            "Microsoft JhengHei".into(),
            "SimSun".into(),
        ]);
        let dc = GetDC(hwnd);
        if !dc.is_null() {
            let mut font: LOGFONTW = zeroed();
            font.lfCharSet = DEFAULT_CHARSET;
            EnumFontFamiliesExW(
                dc,
                &font,
                Some(font_family),
                &mut families as *mut _ as LPARAM,
                0,
            );
            ReleaseDC(hwnd, dc);
        }
        families
    }
}

pub(super) unsafe fn layout(app: &mut App, dpi: u32) {
    unsafe {
        let scale = |n: i32| ((i64::from(n) * i64::from(dpi) + 48) / 96) as i32;
        let mut metrics: NONCLIENTMETRICSW = zeroed();
        metrics.cbSize = size_of::<NONCLIENTMETRICSW>() as u32;
        let font = if SystemParametersInfoForDpi(
            SPI_GETNONCLIENTMETRICS,
            metrics.cbSize,
            &mut metrics as *mut _ as _,
            0,
            dpi,
        ) != 0
        {
            CreateFontIndirectW(&metrics.lfMessageFont)
        } else {
            null_mut()
        };
        for &(_, _, id, x, y, width, height, _) in CONTROLS {
            let control = GetDlgItem(app.preferences, id);
            SetWindowPos(
                control,
                null_mut(),
                scale(x),
                scale(y),
                scale(width),
                scale(height),
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            SendMessageW(
                control,
                WM_SETFONT,
                if font.is_null() {
                    GetStockObject(DEFAULT_GUI_FONT)
                } else {
                    font
                } as usize,
                1,
            );
        }
        if !app.settings_font.is_null() {
            DeleteObject(app.settings_font);
        }
        app.settings_font = font;
    }
}

pub(super) unsafe fn create(app: &mut App) {
    unsafe {
        if !app.preferences.is_null() {
            SetForegroundWindow(app.preferences);
            return;
        }
        let dpi = GetDpiForWindow(app.hwnd).max(96);
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: (660 * dpi / 96) as i32,
            bottom: (494 * dpi / 96) as i32,
        };
        AdjustWindowRectExForDpi(&mut rect, STYLE, 0, EX_STYLE, dpi);
        app.preferences = CreateWindowExW(
            EX_STYLE,
            wide(CLASS).as_ptr(),
            wide("Notes settings").as_ptr(),
            STYLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            rect.right - rect.left,
            rect.bottom - rect.top,
            app.hwnd,
            null_mut(),
            GetModuleHandleW(null()),
            null(),
        );
        if app.preferences.is_null() {
            message(app.hwnd, "Windows could not create the Settings window.");
            return;
        }
        SetWindowLongPtrW(app.preferences, GWLP_USERDATA, app as *mut App as isize);
        for &(class, text, id, _, _, _, _, style) in CONTROLS {
            let control = CreateWindowExW(
                0,
                wide(class).as_ptr(),
                wide(text).as_ptr(),
                WS_CHILD | WS_VISIBLE | style,
                0,
                0,
                0,
                0,
                app.preferences,
                id as usize as HMENU,
                GetModuleHandleW(null()),
                null(),
            );
            if control.is_null() {
                message(
                    app.preferences,
                    "Windows could not create a Settings control.",
                );
                DestroyWindow(app.preferences);
                return;
            }
        }
        layout(app, dpi);
        SetDlgItemTextW(
            app.preferences,
            DIRECTORY,
            path_wide(&app.core.settings().directory).as_ptr(),
        );
        SetDlgItemTextW(
            app.preferences,
            PORT,
            wide(&app.core.settings().port.to_string()).as_ptr(),
        );
        SendDlgItemMessageW(app.preferences, PORT, EM_SETLIMITTEXT, 5, 0);
        for (id, checked) in [
            (AUTO, app.core.settings().auto_start),
            (BROWSER, app.core.settings().auto_open_browser),
        ] {
            SendDlgItemMessageW(app.preferences, id, BM_SETCHECK, checked as usize, 0);
        }
        for theme in ["System", "Light", "Dark"] {
            SendDlgItemMessageW(
                app.preferences,
                THEME,
                CB_ADDSTRING,
                0,
                wide(theme).as_ptr() as LPARAM,
            );
        }
        let index = match app.core.settings().appearance.theme {
            Theme::System => 0,
            Theme::Light => 1,
            Theme::Dark => 2,
        };
        SendDlgItemMessageW(app.preferences, THEME, CB_SETCURSEL, index, 0);
        let families = font_families(app.preferences);
        for (id, selected) in [
            (LATIN_FONT, &app.core.settings().appearance.latin_font),
            (CJK_FONT, &app.core.settings().appearance.cjk_font),
        ] {
            for family in &families {
                SendDlgItemMessageW(
                    app.preferences,
                    id,
                    CB_ADDSTRING,
                    0,
                    wide(family).as_ptr() as LPARAM,
                );
            }
            SendDlgItemMessageW(app.preferences, id, CB_LIMITTEXT, 128, 0);
            SetDlgItemTextW(app.preferences, id, wide(selected).as_ptr());
        }
        ShowWindow(app.preferences, SW_SHOW);
        SetFocus(GetDlgItem(app.preferences, DIRECTORY));
    }
}

unsafe fn text(hwnd: HWND, id: i32) -> Vec<u16> {
    unsafe {
        let control = GetDlgItem(hwnd, id);
        let mut buffer = vec![0u16; GetWindowTextLengthW(control) as usize + 1];
        let len = GetWindowTextW(control, buffer.as_mut_ptr(), buffer.len() as i32);
        buffer.truncate(len as usize);
        buffer
    }
}

pub(super) unsafe fn read(hwnd: HWND, original: &Settings) -> Result<Settings, String> {
    unsafe {
        use std::os::windows::ffi::OsStringExt;
        let mut next = original.clone();
        next.directory = PathBuf::from(std::ffi::OsString::from_wide(&text(hwnd, DIRECTORY)));
        next.port = String::from_utf16_lossy(&text(hwnd, PORT))
            .parse::<u16>()
            .map_err(|_| "Enter a port between 1 and 65535.")?;
        next.auto_start = SendDlgItemMessageW(hwnd, AUTO, BM_GETCHECK, 0, 0) == 1;
        next.auto_open_browser = SendDlgItemMessageW(hwnd, BROWSER, BM_GETCHECK, 0, 0) == 1;
        next.appearance.theme = match SendDlgItemMessageW(hwnd, THEME, CB_GETCURSEL, 0, 0) {
            0 => Theme::System,
            1 => Theme::Light,
            2 => Theme::Dark,
            _ => return Err("Select System, Light, or Dark theme.".into()),
        };
        next.appearance.latin_font = String::from_utf16_lossy(&text(hwnd, LATIN_FONT))
            .trim()
            .into();
        next.appearance.cjk_font = String::from_utf16_lossy(&text(hwnd, CJK_FONT))
            .trim()
            .into();
        Ok(next)
    }
}

pub(super) unsafe fn label_brush(dc: HDC) -> LRESULT {
    unsafe {
        SetBkMode(dc, TRANSPARENT as i32);
        SetTextColor(dc, GetSysColor(COLOR_WINDOWTEXT));
        SetBkColor(dc, GetSysColor(COLOR_WINDOW));
        GetSysColorBrush(COLOR_WINDOW) as LRESULT
    }
}
