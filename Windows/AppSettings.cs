namespace NotesApp.Windows;

internal enum BrowserChoice
{
    System,
    Chrome,
    Edge,
    Firefox
}

internal enum EditorChoice
{
    System,
    VisualStudioCode,
    Cursor,
    Zed,
    Obsidian
}

internal enum AppearanceChoice
{
    System,
    Light,
    Dark
}

internal sealed record AppSettings
{
    private static readonly float[] SupportedLogFontSizes =
        { 10, 11, 12, 13, 14, 16, 18, 20 };

    public string Directory { get; init; } = "";
    public int Port { get; init; } = 8123;
    public bool AutoStart { get; init; } = true;
    public bool AutoOpenBrowser { get; init; }
    public BrowserChoice Browser { get; init; } = BrowserChoice.System;
    public EditorChoice Editor { get; init; } = EditorChoice.VisualStudioCode;
    public bool LiveReload { get; init; } = true;
    public bool DirtyReload { get; init; }
    public bool StrictMode { get; init; }
    public int StartupTimeout { get; init; } = 15;
    public AppearanceChoice Appearance { get; init; } = AppearanceChoice.System;
    public bool AnsiColors { get; init; } = true;
    public float LogFontSize { get; init; } = 12;

    public static string DataDirectory =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "NotesApp"
        );

    public static string SettingsPath => Path.Combine(DataDirectory, "settings.json");
    public static string LogDirectory => Path.Combine(DataDirectory, "Logs");

    public AppSettings Normalize()
    {
        float fontSize = SupportedLogFontSizes.Contains(LogFontSize) ? LogFontSize : 12;
        return this with
        {
            Directory = Directory?.Trim() ?? "",
            Port = Port is >= 1 and <= 65535 ? Port : 8123,
            StartupTimeout = StartupTimeout is >= 5 and <= 60 ? StartupTimeout : 15,
            Browser = Enum.IsDefined(Browser) ? Browser : BrowserChoice.System,
            Editor = Enum.IsDefined(Editor) ? Editor : EditorChoice.VisualStudioCode,
            Appearance = Enum.IsDefined(Appearance)
                ? Appearance
                : AppearanceChoice.System,
            LogFontSize = fontSize
        };
    }

    public bool HasServerChanges(AppSettings other) =>
        Directory != other.Directory
        || Port != other.Port
        || LiveReload != other.LiveReload
        || DirtyReload != other.DirtyReload
        || StrictMode != other.StrictMode
        || StartupTimeout != other.StartupTimeout;
}
