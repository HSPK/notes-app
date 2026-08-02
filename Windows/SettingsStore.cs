using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace NotesApp.Windows;

internal sealed class SettingsStore
{
    private static readonly JsonSerializerOptions SerializerOptions = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() }
    };

    public AppSettings Load()
    {
        if (!File.Exists(AppSettings.SettingsPath))
        {
            return new AppSettings();
        }

        try
        {
            return (
                JsonSerializer.Deserialize<AppSettings>(
                    File.ReadAllText(AppSettings.SettingsPath),
                    SerializerOptions
                ) ?? new AppSettings()
            ).Normalize();
        }
        catch (Exception error) when (
            error is JsonException or IOException or UnauthorizedAccessException
        )
        {
            throw new SettingsStorageException(
                "Settings could not be read. Default values will be used.",
                error
            );
        }
    }

    public void Save(AppSettings settings)
    {
        string temporaryPath = AppSettings.SettingsPath + ".tmp";
        try
        {
            System.IO.Directory.CreateDirectory(AppSettings.DataDirectory);
            string json = JsonSerializer.Serialize(settings.Normalize(), SerializerOptions);
            File.WriteAllText(temporaryPath, json, new UTF8Encoding(false));
            File.Move(temporaryPath, AppSettings.SettingsPath, overwrite: true);
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException
        )
        {
            TryDeleteTemporaryFile(temporaryPath);
            throw new SettingsStorageException("Settings could not be saved.", error);
        }
    }

    private static void TryDeleteTemporaryFile(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException
        )
        {
            // Preserve the original save error; a stale temporary file is safe to overwrite later.
        }
    }
}

internal sealed class SettingsStorageException : Exception
{
    public SettingsStorageException(string message, Exception innerException)
        : base(message, innerException)
    {
    }
}
