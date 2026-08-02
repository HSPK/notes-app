using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;

namespace NotesApp.Windows;

internal sealed partial class BuildResultWindow : Window
{
    private readonly string logPath;
    private readonly string output;
    private readonly SystemThemeWatcher? themeWatcher;
    private AppSettings settings;
    private int rerenderQueued;
    private bool closed;

    public BuildResultWindow(BuildResult result, AppSettings settings)
    {
        logPath = result.LogPath;
        output = result.Output;
        this.settings = settings;
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        WindowChrome.Configure(this, "Documentation Check", 900, 640, 620, 420);
        themeWatcher = SystemThemeWatcher.TryCreate(this, QueueRerender);
        RootGrid.ActualThemeChanged += RootThemeChanged;
        ApplySettings(settings);
        Closed += OnWindowClosed;

        bool succeeded = result.ExitCode == 0;
        ResultInfo.Severity = succeeded ? InfoBarSeverity.Success : InfoBarSeverity.Error;
        ResultInfo.Title = succeeded ? "Check passed" : "Check failed";
        ResultInfo.Message = succeeded
            ? "The strict MkDocs build completed without errors."
            : $"The strict MkDocs build exited with code {result.ExitCode}.";

        OutputTextBox.Document.GetRange(0, 0).ScrollIntoView(PointOptions.None);
        ShowLogButton.IsEnabled = File.Exists(logPath);
    }

    public event Action? WindowClosed;

    public void ApplySettings(AppSettings settings)
    {
        this.settings = settings;
        WindowChrome.ApplyTheme(RootGrid, settings.Appearance);
        OutputTextBox.FontFamily = new FontFamily("Cascadia Mono");
        OutputTextBox.FontSize = settings.LogFontSize * 96D / 72D;
        AnsiTextRenderer.Render(OutputTextBox, output, settings.AnsiColors);
    }

    private void CloseClicked(object sender, RoutedEventArgs args)
    {
        Close();
    }

    private async void ShowLogClicked(object sender, RoutedEventArgs args)
    {
        try
        {
            SystemLauncher.Reveal(logPath);
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            ContentDialog dialog = new()
            {
                XamlRoot = RootGrid.XamlRoot,
                Title = "Could not show the log",
                Content = error.Message,
                CloseButtonText = "OK",
                DefaultButton = ContentDialogButton.Close
            };
            await dialog.ShowAsync();
        }
    }

    private void OnWindowClosed(object sender, WindowEventArgs args)
    {
        closed = true;
        RootGrid.ActualThemeChanged -= RootThemeChanged;
        themeWatcher?.Dispose();
        WindowClosed?.Invoke();
    }

    private void RootThemeChanged(FrameworkElement sender, object args)
    {
        QueueRerender();
    }

    private void QueueRerender()
    {
        if (closed || Interlocked.Exchange(ref rerenderQueued, 1) != 0)
        {
            return;
        }
        if (
            !RootGrid.DispatcherQueue.TryEnqueue(
                Microsoft.UI.Dispatching.DispatcherQueuePriority.Low,
                () =>
                {
                    Volatile.Write(ref rerenderQueued, 0);
                    if (!closed)
                    {
                        AnsiTextRenderer.Render(
                            OutputTextBox,
                            output,
                            settings.AnsiColors
                        );
                    }
                }
            )
        )
        {
            Volatile.Write(ref rerenderQueued, 0);
            System.Diagnostics.Trace.TraceError(
                "Notes could not rerender build output for the current theme."
            );
        }
    }
}
