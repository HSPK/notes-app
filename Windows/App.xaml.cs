using System.ComponentModel;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;

namespace NotesApp.Windows;

public partial class App : Application
{
    private const string SingleInstanceName = @"Local\NotesApp.Windows.SingleInstance";
    private readonly SettingsStore settingsStore = new();
    private readonly BuildChecker buildChecker = new();
    private readonly SemaphoreSlim settingsApplyGate = new(1, 1);
    private AppSettings settings = new();
    private DispatcherQueue dispatcherQueue = null!;
    private ServerManager server = null!;
    private SettingsWindow settingsWindow = null!;
    private TrayIcon? trayIcon;
    private LogWindow? logWindow;
    private BuildResultWindow? buildResultWindow;
    private Mutex? instanceMutex;
    private Task? quitTask;
    private bool quitting;

    public App()
    {
        InitializeComponent();
        UnhandledException += AppUnhandledException;
    }

    protected override void OnLaunched(LaunchActivatedEventArgs args)
    {
        instanceMutex = new Mutex(
            initiallyOwned: true,
            name: SingleInstanceName,
            createdNew: out bool isFirstInstance
        );
        if (!isFirstInstance)
        {
            NativeDialog.ShowInfo(0, "Notes", "Notes is already running.");
            instanceMutex.Dispose();
            instanceMutex = null;
            Exit();
            return;
        }

        dispatcherQueue =
            DispatcherQueue.GetForCurrentThread()
            ?? throw new InvalidOperationException("The WinUI dispatcher is unavailable.");

        try
        {
            settings = settingsStore.Load();
        }
        catch (SettingsStorageException error)
        {
            settings = new AppSettings();
            NativeDialog.ShowWarning(
                0,
                "Could not read settings",
                JoinError(error.Message, error.InnerException?.Message)
            );
        }

        server = new ServerManager(settings, DispatchToUi);
        server.StateChanged += ServerStateChanged;
        server.LogWriteFailed += ServerLogWriteFailed;

        settingsWindow = new SettingsWindow(settings, SaveSettingsAsync);
        settingsWindow.ExitRequested += SettingsExitRequested;
        settingsWindow.CommandRequested += TrayCommandInvoked;

        try
        {
            trayIcon = new TrayIcon(
                WindowChrome.GetWindowHandle(settingsWindow),
                Path.Combine(AppContext.BaseDirectory, "Assets", "Notes.ico"),
                CreateTrayMenuState
            );
            trayIcon.CommandInvoked += TrayCommandInvoked;
            trayIcon.AvailabilityLost += TrayAvailabilityLost;
            settingsWindow.KeepRunningWhenHidden = true;
        }
        catch (Exception error) when (
            error is Win32Exception or FileNotFoundException
        )
        {
            settingsWindow.EnableFallbackCommands();
            NativeDialog.ShowWarning(
                WindowChrome.GetWindowHandle(settingsWindow),
                "System tray unavailable",
                $"Notes could not create its tray icon. The settings window will remain open.{Environment.NewLine}{Environment.NewLine}{error.Message}"
            );
        }

        UpdateTray();
        _ = CompleteInitialLaunchAsync();
    }

    private async Task CompleteInitialLaunchAsync()
    {
        if (settings.Directory.Length == 0 || trayIcon is null)
        {
            settingsWindow.ShowSettings(settings);
        }
        if (settings.Directory.Length == 0)
        {
            return;
        }
        if (!settings.AutoStart)
        {
            return;
        }

        bool started = await server.StartAsync();
        if (!quitting && started && settings.AutoOpenBrowser)
        {
            TryOpen(() => SystemLauncher.OpenBrowser(server.WebUrl, settings.Browser));
        }
    }

    private async Task SaveSettingsAsync(AppSettings updatedSettings)
    {
        await settingsApplyGate.WaitAsync();
        try
        {
            if (quitting)
            {
                throw new InvalidOperationException("Notes is exiting.");
            }
            settingsStore.Save(updatedSettings);
            bool serverChanged = updatedSettings.HasServerChanges(settings);
            settings = updatedSettings;
            logWindow?.ApplySettings(settings);
            buildResultWindow?.ApplySettings(settings);

            if (serverChanged)
            {
                await server.ApplyUpdatedConfigurationAsync(settings);
            }
            else
            {
                server.UpdateSettings(settings);
            }
            UpdateTray();
        }
        finally
        {
            settingsApplyGate.Release();
        }
    }

    private TrayMenuState CreateTrayMenuState() =>
        new(
            server.State,
            settings.Port,
            ProjectInspector.ThemeName(settings.Directory),
            settings.Directory.Length > 0,
            buildChecker.IsRunning
        );

    private async void TrayCommandInvoked(TrayCommand command)
    {
        try
        {
            switch (command)
            {
                case TrayCommand.ToggleServer:
                    await ToggleServerAsync();
                    break;
                case TrayCommand.OpenSite:
                    await OpenSiteAsync();
                    break;
                case TrayCommand.OpenEditor:
                    OpenEditor();
                    break;
                case TrayCommand.OpenExplorer:
                    OpenExplorer();
                    break;
                case TrayCommand.OpenConfiguration:
                    OpenConfiguration();
                    break;
                case TrayCommand.CheckDocumentation:
                    await CheckDocumentationAsync();
                    break;
                case TrayCommand.ViewLog:
                    ShowLog();
                    break;
                case TrayCommand.Settings:
                    settingsWindow.ShowSettings(settings);
                    break;
                case TrayCommand.Quit:
                    await QuitAsync();
                    break;
            }
        }
        catch (ObjectDisposedException) when (quitting)
        {
        }
    }

    private async Task ToggleServerAsync()
    {
        ServerState state = server.State;
        if (
            state.Managed
            && state.Status is ServerStatus.Running or ServerStatus.Failed
        )
        {
            await server.StopAsync();
        }
        else if (state.Status is ServerStatus.Stopped or ServerStatus.Failed)
        {
            await server.StartAsync();
        }
    }

    private async Task OpenSiteAsync()
    {
        bool started = await server.EnsureRunningAsync();
        if (quitting)
        {
            return;
        }
        if (!started)
        {
            await settingsWindow.ShowMessageAsync(
                "Could not open the site",
                "The MkDocs server did not start. Check the tray status or open the log."
            );
            return;
        }
        TryOpen(() => SystemLauncher.OpenBrowser(server.WebUrl, settings.Browser));
    }

    private void OpenEditor()
    {
        if (!EnsureProjectConfigured())
        {
            return;
        }
        TryOpen(() => SystemLauncher.OpenEditor(settings.Directory, settings.Editor));
    }

    private void OpenExplorer()
    {
        if (!EnsureProjectConfigured())
        {
            return;
        }
        TryOpen(() => SystemLauncher.OpenFolder(settings.Directory));
    }

    private void OpenConfiguration()
    {
        string? config = ProjectInspector.FindConfig(settings.Directory);
        if (config is null)
        {
            _ = settingsWindow.ShowMessageAsync(
                "Configuration not found",
                "Choose a valid MkDocs project in Settings."
            );
            return;
        }
        TryOpen(() => SystemLauncher.OpenEditor(config, settings.Editor));
    }

    private async Task CheckDocumentationAsync()
    {
        if (buildChecker.IsRunning)
        {
            return;
        }

        try
        {
            Task<BuildResult> check = buildChecker.RunAsync(settings);
            UpdateTray();
            BuildResult result = await check;
            if (quitting)
            {
                return;
            }

            buildResultWindow?.Close();
            BuildResultWindow resultWindow = new(result, settings);
            buildResultWindow = resultWindow;
            resultWindow.WindowClosed += () =>
            {
                if (ReferenceEquals(buildResultWindow, resultWindow))
                {
                    buildResultWindow = null;
                }
            };
            resultWindow.Activate();
        }
        catch (Exception error) when (
            error is InvalidOperationException
            or Win32Exception
            or IOException
            or UnauthorizedAccessException
        )
        {
            await settingsWindow.ShowMessageAsync(
                "Could not check documentation",
                error.Message
            );
        }
        finally
        {
            UpdateTray();
        }
    }

    private void ShowLog()
    {
        if (logWindow is null)
        {
            LogWindow window = new(server, settings);
            logWindow = window;
            window.WindowClosed += () =>
            {
                if (ReferenceEquals(logWindow, window))
                {
                    logWindow = null;
                }
            };
        }
        logWindow.ShowLog(settings);
    }

    private bool EnsureProjectConfigured()
    {
        if (settings.Directory.Length > 0)
        {
            return true;
        }
        settingsWindow.ShowSettings(settings);
        return false;
    }

    private void TryOpen(Action action)
    {
        try
        {
            action();
        }
        catch (Exception error) when (
            error is InvalidOperationException or Win32Exception or UriFormatException
        )
        {
            _ = settingsWindow.ShowMessageAsync("Could not open the item", error.Message);
        }
    }

    private void ServerStateChanged(object? sender, EventArgs args)
    {
        UpdateTray();
    }

    private void ServerLogWriteFailed(string message)
    {
        if (!quitting)
        {
            _ = settingsWindow.ShowMessageAsync("Server log unavailable", message);
        }
    }

    private void UpdateTray()
    {
        if (quitting)
        {
            return;
        }
        settingsWindow.UpdateFallbackState(
            server.State,
            settings.Directory.Length > 0,
            buildChecker.IsRunning
        );
        if (trayIcon is null)
        {
            return;
        }
        string tooltip = $"Notes - {server.State.Title} - port {settings.Port}";
        trayIcon.UpdateTooltip(tooltip.Length <= 63 ? tooltip : tooltip[..63]);
    }

    private void DispatchToUi(Action action)
    {
        if (dispatcherQueue.HasThreadAccess)
        {
            action();
            return;
        }
        if (!dispatcherQueue.TryEnqueue(() => action()) && !quitting)
        {
            System.Diagnostics.Trace.TraceError(
                "Notes could not dispatch a server update to the UI thread."
            );
        }
    }

    private void SettingsExitRequested()
    {
        _ = QuitAsync();
    }

    private void TrayAvailabilityLost(string message)
    {
        if (
            !dispatcherQueue.TryEnqueue(() =>
            {
                if (quitting || trayIcon is null)
                {
                    return;
                }
                trayIcon.Dispose();
                trayIcon = null;
                settingsWindow.EnableFallbackCommands();
                UpdateTray();
                settingsWindow.ShowSettings(settings);
                NativeDialog.ShowWarning(
                    WindowChrome.GetWindowHandle(settingsWindow),
                    "System tray unavailable",
                    $"Windows could not restore the Notes tray icon. The settings window will remain open.{Environment.NewLine}{Environment.NewLine}{message}"
                );
            })
            && !quitting
        )
        {
            System.Diagnostics.Trace.TraceError(
                "Notes could not activate its tray fallback controls."
            );
        }
    }

    private Task QuitAsync()
    {
        return quitTask ??= QuitCoreAsync();
    }

    private async Task QuitCoreAsync()
    {
        quitting = true;
        trayIcon?.Dispose();
        trayIcon = null;
        buildChecker.Dispose();
        await settingsApplyGate.WaitAsync();
        try
        {
            await server.ShutdownAsync();
        }
        finally
        {
            settingsApplyGate.Release();
        }

        logWindow?.Close();
        buildResultWindow?.Close();
        settingsWindow.CloseForExit();
        instanceMutex?.Dispose();
        instanceMutex = null;
        Exit();
    }

    private static string JoinError(string message, string? detail) =>
        string.IsNullOrWhiteSpace(detail)
            ? message
            : $"{message}{Environment.NewLine}{Environment.NewLine}{detail}";

    private static void AppUnhandledException(
        object sender,
        Microsoft.UI.Xaml.UnhandledExceptionEventArgs args
    )
    {
        try
        {
            System.IO.Directory.CreateDirectory(AppSettings.LogDirectory);
            File.WriteAllText(
                Path.Combine(AppSettings.LogDirectory, "crash.log"),
                args.Exception.ToString()
            );
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException
        )
        {
            System.Diagnostics.Trace.TraceError(
                $"Notes could not write its crash log: {error.Message}"
            );
        }
    }

}
