using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media;
using WinRT.Interop;
using Windows.Storage.Pickers;

namespace NotesApp.Windows;

internal sealed partial class SettingsWindow : Window
{
    private readonly Func<AppSettings, Task> saveSettingsAsync;
    private readonly SemaphoreSlim dialogGate = new(1, 1);
    private AppSettings original;
    private bool loading;
    private bool allowClose;
    private bool applyingSettings;

    public SettingsWindow()
        : this(new AppSettings(), _ => Task.CompletedTask)
    {
    }

    public SettingsWindow(
        AppSettings settings,
        Func<AppSettings, Task> saveSettingsAsync
    )
    {
        this.saveSettingsAsync = saveSettingsAsync;
        original = settings;
        InitializeComponent();

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        WindowChrome.Configure(this, "Notes Settings", 1020, 720, 560, 520);
        AppWindow.Closing += WindowClosing;

        PopulateChoices();
        LoadSettings(settings);
        Navigation.SelectedItem = GeneralNavigationItem;
        ShowPage("general");
    }

    public void ShowSettings(AppSettings settings)
    {
        if (!applyingSettings)
        {
            LoadSettings(settings);
        }
        AppWindow.Show();
        Activate();
        ResetInitialView();
    }

    public bool KeepRunningWhenHidden { get; set; } = true;

    public event Action? ExitRequested;

    public event Action<TrayCommand>? CommandRequested;

    public void EnableFallbackCommands()
    {
        KeepRunningWhenHidden = false;
        FallbackControls.Visibility = Visibility.Visible;
        CancelButton.Content = "Quit";
    }

    public void UpdateFallbackState(
        ServerState state,
        bool hasProject,
        bool buildRunning
    )
    {
        (FallbackServerButton.Content, FallbackServerButton.IsEnabled) = state.Status switch
        {
            ServerStatus.Starting => ("Starting...", false),
            ServerStatus.Running when state.Managed => ("Stop server", true),
            ServerStatus.Running => ("External server", false),
            ServerStatus.Failed when state.Managed => ("Stop server", true),
            _ => ("Start server", hasProject)
        };
        FallbackOpenSiteButton.IsEnabled = hasProject;
        FallbackOpenEditorItem.IsEnabled = hasProject;
        FallbackOpenExplorerItem.IsEnabled = hasProject;
        FallbackOpenConfigurationItem.IsEnabled = hasProject;
        FallbackBuildItem.Text = buildRunning
            ? "Checking documentation..."
            : "Check documentation";
        FallbackBuildItem.IsEnabled = hasProject && !buildRunning;
    }

    public void HideSettings()
    {
        if (applyingSettings)
        {
            return;
        }
        if (!KeepRunningWhenHidden)
        {
            ExitRequested?.Invoke();
            return;
        }
        LoadSettings(original);
        AppWindow.Hide();
    }

    public void CloseForExit()
    {
        allowClose = true;
        Close();
    }

    public async Task ShowMessageAsync(string title, string message)
    {
        AppWindow.Show();
        Activate();
        if (!RootGrid.IsLoaded)
        {
            TaskCompletionSource loaded = new(
                TaskCreationOptions.RunContinuationsAsynchronously
            );
            RoutedEventHandler? handler = null;
            handler = (_, _) =>
            {
                RootGrid.Loaded -= handler;
                loaded.TrySetResult();
            };
            RootGrid.Loaded += handler;
            await loaded.Task;
        }
        await dialogGate.WaitAsync();
        try
        {
            ContentDialog dialog = new()
            {
                XamlRoot = RootGrid.XamlRoot,
                Title = title,
                Content = message,
                CloseButtonText = "OK",
                DefaultButton = ContentDialogButton.Close
            };
            await dialog.ShowAsync();
        }
        finally
        {
            dialogGate.Release();
        }
    }

    private void PopulateChoices()
    {
        BrowserCombo.ItemsSource = new[]
        {
            new Choice<BrowserChoice>("System default", BrowserChoice.System),
            new Choice<BrowserChoice>("Google Chrome", BrowserChoice.Chrome),
            new Choice<BrowserChoice>("Microsoft Edge", BrowserChoice.Edge),
            new Choice<BrowserChoice>("Firefox", BrowserChoice.Firefox)
        };
        EditorCombo.ItemsSource = new[]
        {
            new Choice<EditorChoice>("System default", EditorChoice.System),
            new Choice<EditorChoice>("Visual Studio Code", EditorChoice.VisualStudioCode),
            new Choice<EditorChoice>("Cursor", EditorChoice.Cursor),
            new Choice<EditorChoice>("Zed", EditorChoice.Zed),
            new Choice<EditorChoice>("Obsidian", EditorChoice.Obsidian)
        };
        ThemeCombo.ItemsSource = new[]
        {
            new Choice<AppearanceChoice>("Use system setting", AppearanceChoice.System),
            new Choice<AppearanceChoice>("Light", AppearanceChoice.Light),
            new Choice<AppearanceChoice>("Dark", AppearanceChoice.Dark)
        };
        FontSizeCombo.ItemsSource = new[]
        {
            new Choice<float>("10 pt", 10),
            new Choice<float>("11 pt", 11),
            new Choice<float>("12 pt", 12),
            new Choice<float>("13 pt", 13),
            new Choice<float>("14 pt", 14),
            new Choice<float>("16 pt", 16),
            new Choice<float>("18 pt", 18),
            new Choice<float>("20 pt", 20)
        };
    }

    private void LoadSettings(AppSettings settings)
    {
        original = settings;
        loading = true;
        DirectoryTextBox.Text = settings.Directory;
        SelectChoice(BrowserCombo, settings.Browser);
        SelectChoice(EditorCombo, settings.Editor);
        AutoStartToggle.IsOn = settings.AutoStart;
        AutoOpenBrowserToggle.IsOn = settings.AutoOpenBrowser;
        AutoOpenBrowserToggle.IsEnabled = settings.AutoStart;
        PortNumberBox.Value = settings.Port;
        TimeoutNumberBox.Value = settings.StartupTimeout;
        LiveReloadToggle.IsOn = settings.LiveReload;
        DirtyReloadToggle.IsOn = settings.DirtyReload;
        StrictModeToggle.IsOn = settings.StrictMode;
        SelectChoice(ThemeCombo, settings.Appearance);
        AnsiColorsToggle.IsOn = settings.AnsiColors;
        SelectChoice(FontSizeCombo, settings.LogFontSize);
        loading = false;
        ValidationInfo.IsOpen = false;
        SaveProgress.Visibility = Visibility.Collapsed;
        SaveButton.IsEnabled = true;
        ApplyThemePreview();
        UpdateDirectoryStatus();
    }

    private void WindowClosing(
        Microsoft.UI.Windowing.AppWindow sender,
        Microsoft.UI.Windowing.AppWindowClosingEventArgs args
    )
    {
        if (allowClose)
        {
            return;
        }
        args.Cancel = true;
        HideSettings();
    }

    private void NavigationSelectionChanged(
        NavigationView sender,
        NavigationViewSelectionChangedEventArgs args
    )
    {
        if (args.SelectedItemContainer?.Tag is string tag)
        {
            ShowPage(tag);
            if (Navigation.ActualWidth < Navigation.ExpandedModeThresholdWidth)
            {
                Navigation.IsPaneOpen = false;
            }
        }
    }

    private void NavigationSizeChanged(object sender, SizeChangedEventArgs args)
    {
        Navigation.IsPaneOpen =
            args.NewSize.Width >= Navigation.ExpandedModeThresholdWidth;
    }

    private void NavigationLoaded(object sender, RoutedEventArgs args)
    {
        Navigation.IsPaneOpen =
            Navigation.ActualWidth >= Navigation.ExpandedModeThresholdWidth;
        ResetInitialView();
    }

    private void ResetInitialView()
    {
        if (
            !RootGrid.DispatcherQueue.TryEnqueue(
                Microsoft.UI.Dispatching.DispatcherQueuePriority.Low,
                () =>
                {
                    Navigation.Focus(FocusState.Programmatic);
                    GeneralPage.ChangeView(null, 0, null, disableAnimation: true);
                }
            )
        )
        {
            System.Diagnostics.Trace.TraceError(
                "Notes could not reset the settings window view."
            );
        }
    }

    private void ShowPage(string tag)
    {
        GeneralPage.Visibility = tag == "general" ? Visibility.Visible : Visibility.Collapsed;
        ServerPage.Visibility = tag == "server" ? Visibility.Visible : Visibility.Collapsed;
        AppearancePage.Visibility =
            tag == "appearance" ? Visibility.Visible : Visibility.Collapsed;

        (PageTitle.Text, PageDescription.Text) = tag switch
        {
            "server" => ("Server", "Configure the local MkDocs server"),
            "appearance" => ("Appearance & logs", "Personalize the app and log output"),
            _ => ("General", "Choose the project location and default apps")
        };
    }

    private async void BrowseClicked(object sender, RoutedEventArgs args)
    {
        FolderPicker picker = new();
        picker.FileTypeFilter.Add("*");
        InitializeWithWindow.Initialize(picker, WindowChrome.GetWindowHandle(this));
        global::Windows.Storage.StorageFolder? folder = await picker.PickSingleFolderAsync();
        if (folder is not null)
        {
            DirectoryTextBox.Text = folder.Path;
        }
    }

    private async void SaveClicked(object sender, RoutedEventArgs args)
    {
        if (applyingSettings)
        {
            return;
        }
        string directory = DirectoryTextBox.Text.Trim();
        if (!System.IO.Directory.Exists(directory))
        {
            ShowValidationError("Choose an existing project folder.");
            return;
        }
        if (ProjectInspector.FindConfig(directory) is null)
        {
            ShowValidationError(
                "No mkdocs.yml or mkdocs.yaml file was found in this folder."
            );
            return;
        }

        AppSettings updated = new AppSettings
        {
            Directory = directory,
            Browser = SelectedValue<BrowserChoice>(BrowserCombo),
            Editor = SelectedValue<EditorChoice>(EditorCombo),
            AutoStart = AutoStartToggle.IsOn,
            AutoOpenBrowser = AutoStartToggle.IsOn && AutoOpenBrowserToggle.IsOn,
            Port = (int)PortNumberBox.Value,
            StartupTimeout = (int)TimeoutNumberBox.Value,
            LiveReload = LiveReloadToggle.IsOn,
            DirtyReload = DirtyReloadToggle.IsOn,
            StrictMode = StrictModeToggle.IsOn,
            Appearance = SelectedValue<AppearanceChoice>(ThemeCombo),
            AnsiColors = AnsiColorsToggle.IsOn,
            LogFontSize = SelectedValue<float>(FontSizeCombo)
        }.Normalize();

        SetApplyingSettings(true);
        ValidationInfo.IsOpen = false;
        try
        {
            await saveSettingsAsync(updated);
            original = updated;
            if (KeepRunningWhenHidden)
            {
                AppWindow.Hide();
            }
            else
            {
                ValidationInfo.Title = "Settings saved";
                ValidationInfo.Message = "The updated settings are now in use.";
                ValidationInfo.Severity = InfoBarSeverity.Success;
                ValidationInfo.IsOpen = true;
            }
        }
        catch (SettingsStorageException error)
        {
            ShowSaveError(error.Message, error.InnerException?.Message);
        }
        catch (InvalidOperationException error)
        {
            ShowSaveError("The settings could not be applied.", error.Message);
        }
        finally
        {
            SetApplyingSettings(false);
        }
    }

    private void SetApplyingSettings(bool applying)
    {
        applyingSettings = applying;
        SaveProgress.Visibility = applying ? Visibility.Visible : Visibility.Collapsed;
        SaveButton.IsEnabled = !applying;
        CancelButton.IsEnabled = !applying;
        GeneralPage.IsEnabled = !applying;
        ServerPage.IsEnabled = !applying;
        AppearancePage.IsEnabled = !applying;
        FallbackControls.IsHitTestVisible = !applying;
        FallbackControls.Opacity = applying ? 0.6 : 1;
    }

    private void ShowValidationError(string message)
    {
        Navigation.SelectedItem = GeneralNavigationItem;
        ShowPage("general");
        ValidationInfo.Title = "Check the project folder";
        ValidationInfo.Message = message;
        ValidationInfo.Severity = InfoBarSeverity.Error;
        ValidationInfo.IsOpen = true;
        DirectoryTextBox.Focus(FocusState.Programmatic);
    }

    private void ShowSaveError(string title, string? detail)
    {
        ValidationInfo.Title = title;
        ValidationInfo.Message = string.IsNullOrWhiteSpace(detail) ? "" : detail;
        ValidationInfo.Severity = InfoBarSeverity.Error;
        ValidationInfo.IsOpen = true;
    }

    private void CancelClicked(object sender, RoutedEventArgs args)
    {
        HideSettings();
    }

    private void FallbackServerClicked(object sender, RoutedEventArgs args) =>
        RequestCommand(TrayCommand.ToggleServer);

    private void FallbackOpenSiteClicked(object sender, RoutedEventArgs args) =>
        RequestCommand(TrayCommand.OpenSite);

    private void FallbackViewLogClicked(object sender, RoutedEventArgs args) =>
        RequestCommand(TrayCommand.ViewLog);

    private void FallbackOpenEditorClicked(object sender, RoutedEventArgs args) =>
        RequestCommand(TrayCommand.OpenEditor);

    private void FallbackOpenExplorerClicked(object sender, RoutedEventArgs args) =>
        RequestCommand(TrayCommand.OpenExplorer);

    private void FallbackOpenConfigurationClicked(object sender, RoutedEventArgs args) =>
        RequestCommand(TrayCommand.OpenConfiguration);

    private void FallbackBuildClicked(object sender, RoutedEventArgs args) =>
        RequestCommand(TrayCommand.CheckDocumentation);

    private void RequestCommand(TrayCommand command)
    {
        if (!applyingSettings)
        {
            CommandRequested?.Invoke(command);
        }
    }

    private void DirectoryTextChanged(object sender, TextChangedEventArgs args)
    {
        if (!loading)
        {
            ValidationInfo.IsOpen = false;
            UpdateDirectoryStatus();
        }
    }

    private void AutoStartToggled(object sender, RoutedEventArgs args)
    {
        AutoOpenBrowserToggle.IsEnabled = AutoStartToggle.IsOn;
        if (!AutoStartToggle.IsOn)
        {
            AutoOpenBrowserToggle.IsOn = false;
        }
    }

    private void ThemeSelectionChanged(object sender, SelectionChangedEventArgs args)
    {
        if (!loading)
        {
            ApplyThemePreview();
        }
    }

    private void ApplyThemePreview()
    {
        AppearanceChoice appearance =
            ThemeCombo.SelectedItem is Choice<AppearanceChoice> choice
                ? choice.Value
                : original.Appearance;
        WindowChrome.ApplyTheme(RootGrid, appearance);
    }

    private void UpdateDirectoryStatus()
    {
        string directory = DirectoryTextBox.Text.Trim();
        if (directory.Length == 0)
        {
            DirectoryStatus.Text = "Choose a folder containing mkdocs.yml or mkdocs.yaml.";
            return;
        }
        if (!System.IO.Directory.Exists(directory))
        {
            DirectoryStatus.Text = "This folder does not exist.";
            return;
        }
        string? config = ProjectInspector.FindConfig(directory);
        if (config is null)
        {
            DirectoryStatus.Text = "No MkDocs configuration was found.";
            return;
        }
        if (ProjectInspector.FindExecutable(directory) is null)
        {
            DirectoryStatus.Text =
                $"Found {Path.GetFileName(config)}, but .venv\\Scripts\\mkdocs.exe is missing.";
            return;
        }
        DirectoryStatus.Text =
            $"Found {Path.GetFileName(config)} and the project virtual environment.";
    }

    private static void SelectChoice<T>(ComboBox box, T value)
    {
        for (int index = 0; index < box.Items.Count; index++)
        {
            if (
                box.Items[index] is Choice<T> choice
                && EqualityComparer<T>.Default.Equals(choice.Value, value)
            )
            {
                box.SelectedIndex = index;
                return;
            }
        }
        box.SelectedIndex = 0;
    }

    private static T SelectedValue<T>(ComboBox box) =>
        box.SelectedItem is Choice<T> choice
            ? choice.Value
            : throw new InvalidOperationException("The settings option is not initialized.");

    private sealed record Choice<T>(string Title, T Value)
    {
        public override string ToString() => Title;
    }
}
