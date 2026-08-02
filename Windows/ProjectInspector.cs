using System.Text.RegularExpressions;

namespace NotesApp.Windows;

internal static partial class ProjectInspector
{
    private static readonly string[] ConfigCandidates =
    {
        "mkdocs.yml",
        "mkdocs.yaml",
        Path.Combine("mkdocs", "mkdocs.yml"),
        Path.Combine("mkdocs", "mkdocs.yaml")
    };

    public static string? FindConfig(string directory)
    {
        if (string.IsNullOrWhiteSpace(directory))
        {
            return null;
        }

        return ConfigCandidates
            .Select(candidate => Path.Combine(directory, candidate))
            .FirstOrDefault(File.Exists);
    }

    public static string? FindExecutable(string directory)
    {
        string[] candidates =
        {
            Path.Combine(directory, ".venv", "Scripts", "mkdocs.exe"),
            Path.Combine(directory, ".venv", "Scripts", "mkdocs")
        };
        return candidates.FirstOrDefault(File.Exists);
    }

    public static string ThemeName(string directory)
    {
        string? config = FindConfig(directory);
        if (config is null)
        {
            return "Unknown";
        }

        string[] lines;
        try
        {
            lines = File.ReadAllLines(config);
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException
        )
        {
            return "Unknown";
        }

        int? themeIndent = null;
        foreach (string rawLine in lines)
        {
            string trimmed = rawLine.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith('#'))
            {
                continue;
            }

            int indent = rawLine.Length - rawLine.TrimStart(' ', '\t').Length;
            if (themeIndent is null)
            {
                if (!trimmed.StartsWith("theme:", StringComparison.Ordinal))
                {
                    continue;
                }

                string inlineValue = trimmed["theme:".Length..].Trim().Trim('"', '\'');
                if (inlineValue.Length > 0)
                {
                    return inlineValue;
                }
                themeIndent = indent;
                continue;
            }

            if (indent <= themeIndent)
            {
                break;
            }

            Match match = ThemeNameExpression().Match(trimmed);
            if (match.Success)
            {
                return match.Groups[1].Value.Trim().Trim('"', '\'');
            }
        }
        return "Default";
    }

    [GeneratedRegex(@"^name:\s*(.+)$")]
    private static partial Regex ThemeNameExpression();
}
