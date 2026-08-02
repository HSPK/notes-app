using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace NotesApp.Windows;

internal enum TrayCommand
{
    ToggleServer,
    OpenSite,
    OpenEditor,
    OpenExplorer,
    OpenConfiguration,
    CheckDocumentation,
    ViewLog,
    Settings,
    Quit
}

internal sealed record TrayMenuState(
    ServerState Server,
    int Port,
    string Theme,
    bool HasProject,
    bool BuildRunning
);

internal sealed class TrayIcon : IDisposable
{
    private const uint WmApp = 0x8000;
    private const uint WmNull = 0x0000;
    private const uint WmContextMenu = 0x007B;
    private const uint WmRightButtonUp = 0x0205;
    private const uint WmLeftButtonDoubleClick = 0x0203;
    private const uint NinSelect = 0x0400;
    private const uint NinKeySelect = 0x0401;
    private const uint TrayCallbackMessage = WmApp + 42;
    private const uint NotifyIconVersion4 = 4;

    private const uint NimAdd = 0;
    private const uint NimModify = 1;
    private const uint NimDelete = 2;
    private const uint NimSetVersion = 4;
    private const uint NifMessage = 1;
    private const uint NifIcon = 2;
    private const uint NifTip = 4;

    private const uint MfString = 0;
    private const uint MfDisabled = 0x00000002;
    private const uint MfGrayed = 0x00000001;
    private const uint MfSeparator = 0x00000800;
    private const uint TpmLeftAlign = 0;
    private const uint TpmRightButton = 0x0002;
    private const uint TpmBottomAlign = 0x0020;
    private const uint TpmReturnCommand = 0x0100;
    private const uint TpmNoNotify = 0x0080;

    private const uint ImageIcon = 1;
    private const uint LrLoadFromFile = 0x0010;
    private const int SmCxSmallIcon = 49;
    private const int SmCySmallIcon = 50;
    private const nuint SubclassId = 0x4E4F5445;

    private const int CommandToggle = 1001;
    private const int CommandOpenSite = 1002;
    private const int CommandOpenEditor = 1003;
    private const int CommandOpenExplorer = 1004;
    private const int CommandOpenConfiguration = 1005;
    private const int CommandBuild = 1006;
    private const int CommandLog = 1007;
    private const int CommandSettings = 1008;
    private const int CommandQuit = 1009;

    private readonly IntPtr windowHandle;
    private readonly Func<TrayMenuState> stateProvider;
    private readonly SubclassProcedure subclassProcedure;
    private readonly uint taskbarCreatedMessage;
    private NotifyIconData iconData;
    private IntPtr iconHandle;
    private bool disposed;

    public TrayIcon(
        IntPtr windowHandle,
        string iconPath,
        Func<TrayMenuState> stateProvider
    )
    {
        this.windowHandle = windowHandle;
        this.stateProvider = stateProvider;
        subclassProcedure = WindowProcedure;
        taskbarCreatedMessage = RegisterWindowMessageW("TaskbarCreated");

        uint dpi = GetDpiForWindow(windowHandle);
        int width = GetSystemMetricsForDpi(SmCxSmallIcon, dpi);
        int height = GetSystemMetricsForDpi(SmCySmallIcon, dpi);
        iconHandle = LoadImageW(
            IntPtr.Zero,
            iconPath,
            ImageIcon,
            width,
            height,
            LrLoadFromFile
        );
        if (iconHandle == IntPtr.Zero)
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Windows could not load the Notes tray icon."
            );
        }

        if (!SetWindowSubclass(windowHandle, subclassProcedure, SubclassId, 0))
        {
            DestroyIcon(iconHandle);
            iconHandle = IntPtr.Zero;
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Windows could not initialize the Notes tray icon."
            );
        }

        AddIcon();
    }

    public event Action<TrayCommand>? CommandInvoked;

    public event Action<string>? AvailabilityLost;

    public void UpdateTooltip(string text)
    {
        if (disposed)
        {
            return;
        }
        iconData.szTip = text.Length <= 127 ? text : text[..127];
        iconData.uFlags = NifTip;
        ShellNotifyIconW(NimModify, ref iconData);
    }

    private void AddIcon()
    {
        iconData = new NotifyIconData
        {
            cbSize = (uint)Marshal.SizeOf<NotifyIconData>(),
            hWnd = windowHandle,
            uID = 1,
            uFlags = NifMessage | NifIcon | NifTip,
            uCallbackMessage = TrayCallbackMessage,
            hIcon = iconHandle,
            szTip = "Notes",
            szInfo = "",
            szInfoTitle = ""
        };
        if (!ShellNotifyIconW(NimAdd, ref iconData))
        {
            RemoveWindowSubclass(windowHandle, subclassProcedure, SubclassId);
            DestroyIcon(iconHandle);
            iconHandle = IntPtr.Zero;
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Windows could not add the Notes tray icon."
            );
        }

        iconData.uVersion = NotifyIconVersion4;
        ShellNotifyIconW(NimSetVersion, ref iconData);
    }

    private IntPtr WindowProcedure(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        nuint subclass,
        nuint referenceData
    )
    {
        if (message == taskbarCreatedMessage)
        {
            try
            {
                AddIcon();
            }
            catch (Win32Exception error)
            {
                Trace.WriteLine($"Unable to restore the Notes tray icon: {error}");
                AvailabilityLost?.Invoke(error.Message);
            }
            return IntPtr.Zero;
        }
        if (message != TrayCallbackMessage)
        {
            return DefSubclassProc(window, message, wParam, lParam);
        }

        uint notification = (uint)(lParam.ToInt64() & 0xFFFF);
        if (notification is WmContextMenu or WmRightButtonUp)
        {
            int x = unchecked((short)(wParam.ToInt64() & 0xFFFF));
            int y = unchecked((short)((wParam.ToInt64() >> 16) & 0xFFFF));
            if (x == -1 && y == -1 || x == 0 && y == 0)
            {
                GetCursorPos(out Point point);
                x = point.X;
                y = point.Y;
            }
            ShowMenu(x, y);
        }
        else if (notification is WmLeftButtonDoubleClick or NinSelect or NinKeySelect)
        {
            CommandInvoked?.Invoke(TrayCommand.OpenSite);
        }
        return IntPtr.Zero;
    }

    private void ShowMenu(int x, int y)
    {
        TrayMenuState state = stateProvider();
        IntPtr menu = CreatePopupMenu();
        if (menu == IntPtr.Zero)
        {
            return;
        }

        try
        {
            AddInfo(menu, $"Status: {state.Server.Title}");
            AddInfo(menu, $"Port: {state.Port}");
            AddInfo(menu, $"Theme: {state.Theme}");
            if (state.Server.Status == ServerStatus.Failed && state.Server.Error is not null)
            {
                AddInfo(menu, $"Reason: {state.Server.Error}");
            }
            AddSeparator(menu);

            string toggleText;
            bool toggleEnabled;
            switch (state.Server.Status)
            {
                case ServerStatus.Starting:
                    toggleText = "Starting…";
                    toggleEnabled = false;
                    break;
                case ServerStatus.Running when state.Server.Managed:
                    toggleText = "Stop server";
                    toggleEnabled = true;
                    break;
                case ServerStatus.Running:
                    toggleText = "External server is running";
                    toggleEnabled = false;
                    break;
                case ServerStatus.Failed when state.Server.Managed:
                    toggleText = "Stop server";
                    toggleEnabled = true;
                    break;
                default:
                    toggleText = "Start server";
                    toggleEnabled = state.HasProject;
                    break;
            }

            AddCommand(menu, CommandToggle, toggleText, toggleEnabled);
            AddCommand(menu, CommandOpenSite, "Open site", state.HasProject);
            AddCommand(menu, CommandOpenEditor, "Open in editor", state.HasProject);
            AddCommand(menu, CommandOpenExplorer, "Open in File Explorer", state.HasProject);
            AddCommand(
                menu,
                CommandOpenConfiguration,
                "Open MkDocs configuration",
                state.HasProject
            );
            AddSeparator(menu);
            AddCommand(
                menu,
                CommandBuild,
                state.BuildRunning ? "Checking documentation…" : "Check documentation",
                state.HasProject && !state.BuildRunning
            );
            AddCommand(menu, CommandLog, "View log", true);
            AddSeparator(menu);
            AddCommand(menu, CommandSettings, "Settings…", true);
            AddSeparator(menu);
            AddCommand(menu, CommandQuit, "Quit Notes", true);

            SetForegroundWindow(windowHandle);
            int command = TrackPopupMenu(
                menu,
                TpmReturnCommand
                | TpmNoNotify
                | TpmRightButton
                | TpmBottomAlign
                | TpmLeftAlign,
                x,
                y,
                0,
                windowHandle,
                IntPtr.Zero
            );
            PostMessageW(windowHandle, WmNull, IntPtr.Zero, IntPtr.Zero);
            Dispatch(command);
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    private static void AddInfo(IntPtr menu, string text) =>
        AppendMenuW(menu, MfString | MfDisabled | MfGrayed, IntPtr.Zero, text);

    private static void AddSeparator(IntPtr menu) =>
        AppendMenuW(menu, MfSeparator, IntPtr.Zero, null);

    private static void AddCommand(IntPtr menu, int id, string text, bool enabled)
    {
        uint flags = MfString;
        if (!enabled)
        {
            flags |= MfDisabled | MfGrayed;
        }
        AppendMenuW(menu, flags, (IntPtr)id, text);
    }

    private void Dispatch(int command)
    {
        TrayCommand? action = command switch
        {
            CommandToggle => TrayCommand.ToggleServer,
            CommandOpenSite => TrayCommand.OpenSite,
            CommandOpenEditor => TrayCommand.OpenEditor,
            CommandOpenExplorer => TrayCommand.OpenExplorer,
            CommandOpenConfiguration => TrayCommand.OpenConfiguration,
            CommandBuild => TrayCommand.CheckDocumentation,
            CommandLog => TrayCommand.ViewLog,
            CommandSettings => TrayCommand.Settings,
            CommandQuit => TrayCommand.Quit,
            _ => null
        };
        if (action is not null)
        {
            CommandInvoked?.Invoke(action.Value);
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        ShellNotifyIconW(NimDelete, ref iconData);
        RemoveWindowSubclass(windowHandle, subclassProcedure, SubclassId);
        if (iconHandle != IntPtr.Zero)
        {
            DestroyIcon(iconHandle);
            iconHandle = IntPtr.Zero;
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NotifyIconData
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)]
        public string szTip;

        public uint dwState;
        public uint dwStateMask;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;

        public uint uVersion;

        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;

        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Point
    {
        public int X;
        public int Y;
    }

    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate IntPtr SubclassProcedure(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        nuint subclass,
        nuint referenceData
    );

    [DllImport(
        "shell32.dll",
        EntryPoint = "Shell_NotifyIconW",
        CharSet = CharSet.Unicode
    )]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ShellNotifyIconW(uint message, ref NotifyIconData data);

    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowSubclass(
        IntPtr window,
        SubclassProcedure procedure,
        nuint subclass,
        nuint referenceData
    );

    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RemoveWindowSubclass(
        IntPtr window,
        SubclassProcedure procedure,
        nuint subclass
    );

    [DllImport("comctl32.dll")]
    private static extern IntPtr DefSubclassProc(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern uint RegisterWindowMessageW(string message);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadImageW(
        IntPtr instance,
        string name,
        uint type,
        int desiredWidth,
        int desiredHeight,
        uint load
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AppendMenuW(
        IntPtr menu,
        uint flags,
        IntPtr item,
        string? text
    );

    [DllImport("user32.dll")]
    private static extern int TrackPopupMenu(
        IntPtr menu,
        uint flags,
        int x,
        int y,
        int reserved,
        IntPtr window,
        IntPtr rectangle
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyMenu(IntPtr menu);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetForegroundWindow(IntPtr window);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PostMessageW(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam
    );

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorPos(out Point point);
}
