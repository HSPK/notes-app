using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace NotesApp.Windows;

internal sealed partial class LogWindow : Window
{
    private const int MaximumBytes = 4 * 1024 * 1024;
    private readonly ServerManager server;
    private readonly DispatcherTimer refreshTimer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly SystemThemeWatcher? themeWatcher;
    private AppSettings settings;
    private long lastLength = -1;
    private DateTime lastWriteTime;
    private int reloadActive;
    private bool closed;

    public LogWindow(ServerManager server, AppSettings settings)
    {
        this.server = server;
        this.settings = settings;
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        WindowChrome.Configure(this, "Notes Log", 980, 680, 620, 420);
        themeWatcher = SystemThemeWatcher.TryCreate(this, SystemAppearanceChanged);
        PathText.Text = server.LogPath;

        refreshTimer.Tick += RefreshTimerTick;
        server.LogCleared += ServerLogCleared;
        RootGrid.ActualThemeChanged += RootThemeChanged;
        Closed += OnWindowClosed;
        Activated += WindowActivated;
        ApplySettings(settings);
    }

    public event Action? WindowClosed;

    public void ShowLog(AppSettings updatedSettings)
    {
        ApplySettings(updatedSettings);
        AppWindow.Show();
        Activate();
        _ = ReloadAsync(force: true);
    }

    public void ApplySettings(AppSettings updatedSettings)
    {
        bool rerender =
            settings.AnsiColors != updatedSettings.AnsiColors
            || settings.Appearance != updatedSettings.Appearance;
        settings = updatedSettings;
        LogTextBox.FontFamily = new FontFamily("Cascadia Mono");
        LogTextBox.FontSize = settings.LogFontSize * 96D / 72D;
        WindowChrome.ApplyTheme(RootGrid, settings.Appearance);
        if (rerender && RootGrid.IsLoaded)
        {
            _ = ReloadAsync(force: true);
        }
    }

    private void WindowActivated(object sender, WindowActivatedEventArgs args)
    {
        refreshTimer.Start();
        _ = ReloadAsync(force: true);
    }

    private void OnWindowClosed(object sender, WindowEventArgs args)
    {
        closed = true;
        refreshTimer.Stop();
        server.LogCleared -= ServerLogCleared;
        RootGrid.ActualThemeChanged -= RootThemeChanged;
        themeWatcher?.Dispose();
        WindowClosed?.Invoke();
    }

    private void RefreshTimerTick(object? sender, object args)
    {
        _ = ReloadAsync();
    }

    private async void ReloadClicked(object sender, RoutedEventArgs args)
    {
        await ReloadAsync(force: true);
    }

    private async Task ReloadAsync(bool force = false)
    {
        if (closed || Interlocked.Exchange(ref reloadActive, 1) != 0)
        {
            return;
        }
        try
        {
            FileInfo file = new(server.LogPath);
            if (!file.Exists)
            {
                LogTextBox.Document.SetText(TextSetOptions.None, "");
                StatusText.Text = "No log yet";
                lastLength = -1;
                return;
            }
            file.Refresh();
            if (!force && file.Length == lastLength && file.LastWriteTimeUtc == lastWriteTime)
            {
                return;
            }
            lastLength = file.Length;
            lastWriteTime = file.LastWriteTimeUtc;

            LogSnapshot snapshot = await ReadSnapshotAsync(server.LogPath);
            if (closed)
            {
                return;
            }
            string text = snapshot.Truncated
                ? "…showing the latest 4 MB only…" + Environment.NewLine + snapshot.Text
                : snapshot.Text;
            AnsiTextRenderer.Render(LogTextBox, text, settings.AnsiColors);
            StatusText.Text = $"File size  {FormatBytes(file.Length)}";
            if (AutoScrollToggle.IsOn)
            {
                ScrollToEnd();
            }
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException
        )
        {
            StatusText.Text = $"The log is temporarily unavailable: {error.Message}";
            lastLength = -1;
        }
        finally
        {
            Volatile.Write(ref reloadActive, 0);
        }
    }

    private static async Task<LogSnapshot> ReadSnapshotAsync(string path)
    {
        await using FileStream stream = new(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite,
            bufferSize: 64 * 1024,
            useAsync: true
        );
        long endpoint = stream.Length;
        long start = Math.Max(0, endpoint - MaximumBytes);
        bool truncated = start > 0;
        stream.Seek(start, SeekOrigin.Begin);

        int maximumRead = checked((int)(endpoint - start));
        byte[] buffer = GC.AllocateUninitializedArray<byte>(maximumRead);
        int totalRead = 0;
        while (totalRead < maximumRead)
        {
            int read = await stream.ReadAsync(
                buffer.AsMemory(totalRead, maximumRead - totalRead)
            );
            if (read == 0)
            {
                break;
            }
            totalRead += read;
        }
        using MemoryStream snapshot = new(buffer, 0, totalRead, writable: false);
        using StreamReader reader = new(snapshot, detectEncodingFromByteOrderMarks: true);
        return new LogSnapshot(await reader.ReadToEndAsync(), truncated);
    }

    private async void ClearClicked(object sender, RoutedEventArgs args)
    {
        ContentDialog dialog = new()
        {
            XamlRoot = RootGrid.XamlRoot,
            Title = "Clear log?",
            Content = "This removes the current server log. New output will continue to appear.",
            PrimaryButtonText = "Clear",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary)
        {
            return;
        }

        try
        {
            server.ClearLog();
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException
        )
        {
            StatusText.Text = $"The log could not be cleared: {error.Message}";
        }
    }

    private void ServerLogCleared(object? sender, EventArgs args)
    {
        _ = ReloadAsync(force: true);
    }

    private void RootThemeChanged(FrameworkElement sender, object args)
    {
        SystemAppearanceChanged();
    }

    private void SystemAppearanceChanged()
    {
        if (!closed)
        {
            _ = ReloadAsync(force: true);
        }
    }

    private void ScrollToEnd()
    {
        if (
            !RootGrid.DispatcherQueue.TryEnqueue(
                Microsoft.UI.Dispatching.DispatcherQueuePriority.Low,
                () =>
                {
                    if (closed || !AutoScrollToggle.IsOn)
                    {
                        return;
                    }
                    ScrollViewer? scrollViewer = FindDescendant<ScrollViewer>(LogTextBox);
                    if (scrollViewer is not null)
                    {
                        scrollViewer.ChangeView(
                            null,
                            scrollViewer.ScrollableHeight,
                            null,
                            disableAnimation: true
                        );
                    }
                }
            )
        )
        {
            System.Diagnostics.Trace.TraceError(
                "Notes could not queue the log auto-scroll operation."
            );
        }
    }

    private static T? FindDescendant<T>(DependencyObject parent)
        where T : DependencyObject
    {
        int count = VisualTreeHelper.GetChildrenCount(parent);
        for (int index = 0; index < count; index++)
        {
            DependencyObject child = VisualTreeHelper.GetChild(parent, index);
            if (child is T match)
            {
                return match;
            }
            T? descendant = FindDescendant<T>(child);
            if (descendant is not null)
            {
                return descendant;
            }
        }
        return null;
    }

    private static string FormatBytes(long value)
    {
        string[] units = { "B", "KB", "MB", "GB" };
        double size = value;
        int unit = 0;
        while (size >= 1024 && unit < units.Length - 1)
        {
            size /= 1024;
            unit++;
        }
        return $"{size:0.##} {units[unit]}";
    }

    private sealed record LogSnapshot(string Text, bool Truncated);
}
