using System.Diagnostics;

namespace NotesApp.Windows;

internal static class SystemLauncher
{
    public static void OpenBrowser(string url, BrowserChoice browser)
    {
        if (browser == BrowserChoice.System)
        {
            ShellOpen(url);
            return;
        }

        string[] candidates = browser switch
        {
            BrowserChoice.Chrome => new[]
            {
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Google",
                    "Chrome",
                    "Application",
                    "chrome.exe"
                ),
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    "Google",
                    "Chrome",
                    "Application",
                    "chrome.exe"
                )
            },
            BrowserChoice.Edge => new[]
            {
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    "Microsoft",
                    "Edge",
                    "Application",
                    "msedge.exe"
                ),
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Microsoft",
                    "Edge",
                    "Application",
                    "msedge.exe"
                )
            },
            _ => new[]
            {
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Mozilla Firefox",
                    "firefox.exe"
                ),
                Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    "Mozilla Firefox",
                    "firefox.exe"
                )
            }
        };
        StartKnownApplication(candidates, url, "The selected browser could not be found.");
    }

    public static void OpenEditor(string path, EditorChoice editor)
    {
        if (editor == EditorChoice.System)
        {
            ShellOpen(path);
            return;
        }
        if (editor == EditorChoice.Obsidian)
        {
            ShellOpen($"obsidian://open?path={Uri.EscapeDataString(path)}");
            return;
        }

        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string[] candidates = editor switch
        {
            EditorChoice.VisualStudioCode => new[]
            {
                Path.Combine(local, "Programs", "Microsoft VS Code", "Code.exe"),
                Path.Combine(programs, "Microsoft VS Code", "Code.exe")
            },
            EditorChoice.Cursor => new[]
            {
                Path.Combine(local, "Programs", "cursor", "Cursor.exe"),
                Path.Combine(programs, "Cursor", "Cursor.exe")
            },
            _ => new[]
            {
                Path.Combine(local, "Programs", "Zed", "Zed.exe"),
                Path.Combine(programs, "Zed", "Zed.exe")
            }
        };
        StartKnownApplication(candidates, path, "The selected editor could not be found.");
    }

    public static void OpenFolder(string path) => ShellOpen(path);

    public static void Reveal(string path)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = "explorer.exe",
            Arguments = $"/select,\"{path}\"",
            UseShellExecute = true
        });
    }

    private static void StartKnownApplication(
        IEnumerable<string> candidates,
        string argument,
        string errorMessage
    )
    {
        string? executable = candidates.FirstOrDefault(File.Exists);
        if (executable is null)
        {
            throw new InvalidOperationException(errorMessage);
        }
        Process.Start(new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            ArgumentList = { argument }
        });
    }

    private static void ShellOpen(string target)
    {
        Process.Start(new ProcessStartInfo
        {
            FileName = target,
            UseShellExecute = true
        });
    }
}
