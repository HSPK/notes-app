using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;
using System.Runtime.InteropServices;
using WinRT.Interop;

namespace NotesApp.Windows;

internal static class WindowChrome
{
    public static void Configure(
        Window window,
        string title,
        int width,
        int height,
        int minimumWidth,
        int minimumHeight
    )
    {
        AppWindow appWindow = window.AppWindow;
        appWindow.Title = title;
        appWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "Notes.ico"));

        double scale = GetDpiForWindow(GetWindowHandle(window)) / 96D;
        DisplayArea display = DisplayArea.GetFromWindowId(
            appWindow.Id,
            DisplayAreaFallback.Primary
        );
        global::Windows.Graphics.RectInt32 workArea = display.WorkArea;
        int edgeMargin = Scale(64, scale);
        int availableWidth = Math.Max(1, workArea.Width - edgeMargin);
        int availableHeight = Math.Max(1, workArea.Height - edgeMargin);
        int windowWidth = Math.Min(Scale(width, scale), availableWidth);
        int windowHeight = Math.Min(Scale(height, scale), availableHeight);
        appWindow.Resize(
            new global::Windows.Graphics.SizeInt32(windowWidth, windowHeight)
        );

        if (appWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.IsResizable = true;
            presenter.IsMaximizable = true;
        }
        UpdateMinimumSize(window, minimumWidth, minimumHeight, scale);
        TrackDpiChanges(window, minimumWidth, minimumHeight);

        appWindow.Move(new global::Windows.Graphics.PointInt32(
            workArea.X + Math.Max(0, (workArea.Width - windowWidth) / 2),
            workArea.Y + Math.Max(0, (workArea.Height - windowHeight) / 2)
        ));

        if (AppWindowTitleBar.IsCustomizationSupported())
        {
            appWindow.TitleBar.BackgroundColor = Microsoft.UI.Colors.Transparent;
            appWindow.TitleBar.InactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
            appWindow.TitleBar.ButtonBackgroundColor = Microsoft.UI.Colors.Transparent;
            appWindow.TitleBar.ButtonInactiveBackgroundColor = Microsoft.UI.Colors.Transparent;
        }
    }

    public static IntPtr GetWindowHandle(Window window) =>
        WindowNative.GetWindowHandle(window);

    private static int Scale(int value, double scale) =>
        (int)Math.Round(value * scale, MidpointRounding.AwayFromZero);

    private static void TrackDpiChanges(
        Window window,
        int minimumWidth,
        int minimumHeight
    )
    {
        if (window.Content is not FrameworkElement root)
        {
            return;
        }

        XamlRoot? trackedRoot = null;
        void AttachXamlRoot()
        {
            XamlRoot? currentRoot = root.XamlRoot;
            if (ReferenceEquals(trackedRoot, currentRoot))
            {
                return;
            }
            if (trackedRoot is not null)
            {
                trackedRoot.Changed -= XamlRootChanged;
            }
            trackedRoot = currentRoot;
            if (trackedRoot is not null)
            {
                trackedRoot.Changed += XamlRootChanged;
                UpdateMinimumSize(
                    window,
                    minimumWidth,
                    minimumHeight,
                    trackedRoot.RasterizationScale
                );
            }
        }

        void XamlRootChanged(XamlRoot sender, XamlRootChangedEventArgs args)
        {
            UpdateMinimumSize(
                window,
                minimumWidth,
                minimumHeight,
                sender.RasterizationScale
            );
        }

        void RootLoaded(object sender, RoutedEventArgs args) => AttachXamlRoot();

        void WindowClosed(object sender, WindowEventArgs args)
        {
            root.Loaded -= RootLoaded;
            if (trackedRoot is not null)
            {
                trackedRoot.Changed -= XamlRootChanged;
            }
            window.Closed -= WindowClosed;
        }

        root.Loaded += RootLoaded;
        window.Closed += WindowClosed;
        AttachXamlRoot();
    }

    private static void UpdateMinimumSize(
        Window window,
        int minimumWidth,
        int minimumHeight,
        double scale
    )
    {
        AppWindow appWindow = window.AppWindow;
        if (appWindow.Presenter is not OverlappedPresenter presenter)
        {
            return;
        }

        DisplayArea display = DisplayArea.GetFromWindowId(
            appWindow.Id,
            DisplayAreaFallback.Primary
        );
        int edgeMargin = Scale(64, scale);
        presenter.PreferredMinimumWidth = Math.Min(
            Scale(minimumWidth, scale),
            Math.Max(1, display.WorkArea.Width - edgeMargin)
        );
        presenter.PreferredMinimumHeight = Math.Min(
            Scale(minimumHeight, scale),
            Math.Max(1, display.WorkArea.Height - edgeMargin)
        );
    }

    public static void ApplyTheme(FrameworkElement root, AppearanceChoice appearance)
    {
        root.RequestedTheme = appearance switch
        {
            AppearanceChoice.Light => ElementTheme.Light,
            AppearanceChoice.Dark => ElementTheme.Dark,
            _ => ElementTheme.Default
        };
    }

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr window);
}
