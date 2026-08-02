using System.Diagnostics;
using System.Text;

namespace NotesApp.Windows;

internal sealed record BuildResult(int ExitCode, string Output, string LogPath);

internal sealed class BuildChecker : IDisposable
{
    private const int MaximumCapturedCharacters = 4 * 1024 * 1024;
    private readonly object sync = new();
    private Process? activeProcess;
    private bool running;
    private bool disposed;

    public bool IsRunning
    {
        get
        {
            lock (sync)
            {
                return running;
            }
        }
    }

    public string LogPath => Path.Combine(AppSettings.LogDirectory, "build-check.log");

    public async Task<BuildResult> RunAsync(AppSettings settings)
    {
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            if (running)
            {
                throw new InvalidOperationException("A documentation check is already running.");
            }
            running = true;
        }

        try
        {
            return await RunCoreAsync(settings);
        }
        finally
        {
            lock (sync)
            {
                running = false;
            }
        }
    }

    private async Task<BuildResult> RunCoreAsync(AppSettings settings)
    {
        string? executable = ProjectInspector.FindExecutable(settings.Directory);
        string? config = ProjectInspector.FindConfig(settings.Directory);
        if (executable is null || config is null)
        {
            const string message =
                "The MkDocs executable or project configuration could not be found.";
            await SaveOutputAsync(message);
            return new BuildResult(1, message, LogPath);
        }

        ProcessStartInfo startInfo = new()
        {
            FileName = executable,
            WorkingDirectory = settings.Directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add("build");
        startInfo.ArgumentList.Add("-f");
        startInfo.ArgumentList.Add(config);
        startInfo.ArgumentList.Add("--strict");

        Process process = new() { StartInfo = startInfo };
        object outputLock = new();
        BoundedTextBuffer output = new(MaximumCapturedCharacters);
        StreamWriter? fullLog = null;
        Exception? logWriteError = null;

        void AppendText(string text)
        {
            lock (outputLock)
            {
                output.Append(text);
                if (logWriteError is not null)
                {
                    return;
                }
                try
                {
                    fullLog!.Write(text);
                }
                catch (Exception error) when (
                    error is IOException or UnauthorizedAccessException
                )
                {
                    logWriteError = error;
                }
            }
        }

        try
        {
            System.IO.Directory.CreateDirectory(AppSettings.LogDirectory);
            fullLog = new StreamWriter(
                new FileStream(
                    LogPath,
                    FileMode.Create,
                    FileAccess.Write,
                    FileShare.Read
                ),
                new UTF8Encoding(false)
            )
            {
                AutoFlush = true
            };
            AppendText(
                $"$ mkdocs build -f \"{config}\" --strict{Environment.NewLine}{Environment.NewLine}"
            );

            process.Start();
            lock (sync)
            {
                if (disposed)
                {
                    ProcessLifecycle.TryKillTree(
                        process,
                        "the documentation build process tree"
                    );
                    throw new ObjectDisposedException(nameof(BuildChecker));
                }
                activeProcess = process;
            }
            Task outputPump = PumpOutputAsync(process.StandardOutput, AppendText);
            Task errorPump = PumpOutputAsync(process.StandardError, AppendText);
            await process.WaitForExitAsync();
            await Task.WhenAll(outputPump, errorPump);
            string outputText;
            Exception? writeError;
            lock (outputLock)
            {
                outputText = output.GetText();
                writeError = logWriteError;
            }
            if (writeError is not null)
            {
                throw new IOException(
                    "Notes could not write the documentation check log.",
                    writeError
                );
            }
            return new BuildResult(process.ExitCode, outputText, LogPath);
        }
        finally
        {
            lock (sync)
            {
                if (ReferenceEquals(activeProcess, process))
                {
                    activeProcess = null;
                }
            }
            process.Dispose();
            try
            {
                fullLog?.Dispose();
            }
            catch (IOException error)
            {
                Trace.WriteLine($"Unable to close the documentation check log: {error}");
            }
        }
    }

    public void Dispose()
    {
        Process? process;
        lock (sync)
        {
            if (disposed)
            {
                return;
            }
            disposed = true;
            process = activeProcess;
        }

        if (process is null)
        {
            return;
        }
        ProcessLifecycle.TryKillTree(process, "the documentation build process tree");
    }

    private async Task SaveOutputAsync(string output)
    {
        System.IO.Directory.CreateDirectory(AppSettings.LogDirectory);
        await File.WriteAllTextAsync(LogPath, output, new UTF8Encoding(false));
    }

    private static async Task PumpOutputAsync(
        StreamReader reader,
        Action<string> append
    )
    {
        char[] buffer = new char[16 * 1024];
        while (true)
        {
            int read = await reader.ReadAsync(buffer.AsMemory()).ConfigureAwait(false);
            if (read == 0)
            {
                return;
            }
            append(new string(buffer, 0, read));
        }
    }

    private sealed class BoundedTextBuffer
    {
        private readonly int maximumCharacters;
        private readonly Queue<string> lines = new();
        private int characterCount;
        private bool truncated;

        public BoundedTextBuffer(int maximumCharacters)
        {
            this.maximumCharacters = maximumCharacters;
        }

        public void Append(string value)
        {
            if (value.Length >= maximumCharacters)
            {
                lines.Clear();
                string suffix = value[^maximumCharacters..];
                lines.Enqueue(suffix);
                characterCount = suffix.Length;
                truncated = true;
                return;
            }

            lines.Enqueue(value);
            characterCount += value.Length;
            while (characterCount > maximumCharacters)
            {
                characterCount -= lines.Dequeue().Length;
                truncated = true;
            }
        }

        public string GetText()
        {
            string text = string.Concat(lines);
            return truncated
                ? $"...showing the latest 4 MB only...{Environment.NewLine}{text}"
                : text;
        }
    }
}
