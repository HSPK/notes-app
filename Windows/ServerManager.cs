using System.Diagnostics;
using System.Net.Sockets;
using System.Text;

namespace NotesApp.Windows;

internal enum ServerStatus
{
    Stopped,
    Starting,
    Running,
    Failed
}

internal sealed record ServerState(ServerStatus Status, bool Managed = false, string? Error = null)
{
    public string Title => Status switch
    {
        ServerStatus.Stopped => "Stopped",
        ServerStatus.Starting => "Starting…",
        ServerStatus.Running when Managed => "Running",
        ServerStatus.Running => "Running (external)",
        _ => "Server error"
    };
}

internal sealed class ServerManager : IAsyncDisposable
{
    private readonly Action<Action> postToUi;
    private readonly object sync = new();
    private readonly SemaphoreSlim configurationGate = new(1, 1);
    private readonly System.Threading.Timer healthTimer;
    private AppSettings settings;
    private ServerState state = new(ServerStatus.Stopped);
    private Task<bool>? startupTask;
    private Task? shutdownTask;
    private Process? process;
    private Task? processOutputTask;
    private StreamWriter? logWriter;
    private string? processTempDirectory;
    private CancellationTokenSource? startupCancellation;
    private TaskCompletionSource? processExitSignal;
    private int healthCheckActive;
    private int consecutiveHealthFailures;
    private long healthGeneration;
    private bool logWriteFailureReported;
    private volatile bool stopping;
    private volatile bool disposed;

    public ServerManager(AppSettings settings, Action<Action>? uiDispatcher = null)
    {
        this.settings = settings;
        if (uiDispatcher is not null)
        {
            postToUi = uiDispatcher;
        }
        else
        {
            SynchronizationContext context = SynchronizationContext.Current
                ?? throw new InvalidOperationException(
                    "ServerManager needs a UI dispatcher or synchronization context."
                );
            postToUi = action => context.Post(_ => action(), null);
        }
        healthTimer = new System.Threading.Timer(
            async _ => await RefreshHealthAsync(),
            null,
            TimeSpan.FromSeconds(2),
            TimeSpan.FromSeconds(2)
        );
    }

    public AppSettings Settings => Volatile.Read(ref settings);
    public ServerState State => Volatile.Read(ref state);
    public string WebUrl => $"http://127.0.0.1:{Settings.Port}";
    public string LogPath => Path.Combine(AppSettings.LogDirectory, "mkdocs.log");
    public event EventHandler? StateChanged;
    public event EventHandler? LogCleared;
    public event Action<string>? LogWriteFailed;

    public Task<bool> StartAsync()
    {
        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            return StartLocked();
        }
    }

    private Task<bool> StartLocked()
    {
        if (State.Status == ServerStatus.Running)
        {
            return Task.FromResult(true);
        }
        if (startupTask is { IsCompleted: false })
        {
            return startupTask;
        }
        if (process is not null)
        {
            SetState(new ServerState(
                ServerStatus.Failed,
                Managed: IsProcessRunning(process),
                Error: "The previous MkDocs process is still shutting down"
            ));
            return Task.FromResult(false);
        }

        stopping = false;
        CancellationTokenSource cancellation = new(
            TimeSpan.FromSeconds(Settings.StartupTimeout)
        );
        startupCancellation?.Dispose();
        startupCancellation = cancellation;
        startupTask = StartCoreAsync(Settings, cancellation);
        return startupTask;
    }

    private async Task<bool> StartCoreAsync(
        AppSettings launchSettings,
        CancellationTokenSource cancellation
    )
    {
        try
        {
            cancellation.Token.ThrowIfCancellationRequested();
            string? validationError = ValidateConfiguration(launchSettings);
            if (validationError is not null)
            {
                SetState(new ServerState(ServerStatus.Failed, Error: validationError));
                return false;
            }

            if (!CanContinueStartup(cancellation))
            {
                return EndCancelledStartup(cancellation);
            }
            SetState(new ServerState(ServerStatus.Starting));
            if (await IsPortOpenAsync(launchSettings.Port, cancellation.Token))
            {
                if (!CanContinueStartup(cancellation))
                {
                    return EndCancelledStartup(cancellation);
                }
                SetState(new ServerState(ServerStatus.Running, Managed: false));
                return true;
            }

            if (!CanContinueStartup(cancellation))
            {
                return EndCancelledStartup(cancellation);
            }
            return await LaunchAsync(launchSettings, cancellation);
        }
        catch (OperationCanceledException)
        {
            return EndCancelledStartup(cancellation);
        }
        finally
        {
            ReleaseStartupCancellation(cancellation);
        }
    }

    public async Task<bool> EnsureRunningAsync()
    {
        return State.Status == ServerStatus.Running || await StartAsync();
    }

    public async Task StopAsync()
    {
        Task stopTask = GetStopCompletion(RequestStop(force: false));
        try
        {
            await stopTask.WaitAsync(TimeSpan.FromSeconds(1));
        }
        catch (TimeoutException)
        {
            stopTask = GetStopCompletion(RequestStop(force: true));
            try
            {
                await stopTask.WaitAsync(TimeSpan.FromSeconds(4));
            }
            catch (TimeoutException)
            {
                SetState(new ServerState(
                    ServerStatus.Failed,
                    Error: "Timed out while waiting for MkDocs to stop"
                ));
                return;
            }
        }
        stopping = false;
        SetState(new ServerState(ServerStatus.Stopped));
    }

    public async Task RestartAsync()
    {
        await StopAsync();
        Task<bool> restartTask;
        lock (sync)
        {
            if (disposed || State.Status == ServerStatus.Failed)
            {
                return;
            }
            restartTask = StartLocked();
        }
        await restartTask;
    }

    public void UpdateSettings(AppSettings settings)
    {
        lock (sync)
        {
            Volatile.Write(ref this.settings, settings);
            Interlocked.Increment(ref healthGeneration);
        }
    }

    public async Task ApplyUpdatedConfigurationAsync(AppSettings settings)
    {
        await configurationGate.WaitAsync();
        try
        {
            bool shouldStart;
            lock (sync)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                shouldStart =
                    startupTask is { IsCompleted: false }
                    || process is not null && IsProcessRunning(process)
                    || settings.AutoStart;
            }

            await StopAsync();
            lock (sync)
            {
                Volatile.Write(ref this.settings, settings);
                Interlocked.Increment(ref healthGeneration);
            }
            if (shouldStart)
            {
                await StartAsync();
            }
        }
        finally
        {
            configurationGate.Release();
        }
    }

    public void ClearLog()
    {
        System.IO.Directory.CreateDirectory(AppSettings.LogDirectory);
        StreamWriter? previousWriter;
        lock (sync)
        {
            previousWriter = logWriter;
            FileStream? stream = null;
            StreamWriter? replacementWriter = null;
            try
            {
                previousWriter?.Flush();
                stream = new FileStream(
                    LogPath,
                    FileMode.OpenOrCreate,
                    FileAccess.Write,
                    FileShare.ReadWrite
                );
                bool keepLogging = process is not null && IsProcessRunning(process);
                if (keepLogging)
                {
                    replacementWriter = CreateLogWriter(stream);
                    stream = null;
                    replacementWriter.BaseStream.Seek(0, SeekOrigin.Begin);
                    replacementWriter.BaseStream.SetLength(0);
                }
                else
                {
                    stream.SetLength(0);
                }

                logWriter = replacementWriter;
                replacementWriter = null;
                if (keepLogging)
                {
                    logWriteFailureReported = false;
                }
            }
            finally
            {
                DisposeWriter(replacementWriter);
                stream?.Dispose();
            }
        }
        DisposeWriter(previousWriter);
        PostToUi(() => LogCleared?.Invoke(this, EventArgs.Empty));
    }

    private static string? ValidateConfiguration(AppSettings settings)
    {
        if (!System.IO.Directory.Exists(settings.Directory))
        {
            return "The project folder does not exist";
        }
        if (ProjectInspector.FindConfig(settings.Directory) is null)
        {
            return "No MkDocs configuration was found";
        }
        if (ProjectInspector.FindExecutable(settings.Directory) is null)
        {
            return @".venv\Scripts\mkdocs.exe was not found; create the virtual environment first";
        }
        if (settings.Port is < 1 or > 65535)
        {
            return "The port must be between 1 and 65535";
        }
        return null;
    }

    private async Task<bool> LaunchAsync(
        AppSettings launchSettings,
        CancellationTokenSource cancellation
    )
    {
        cancellation.Token.ThrowIfCancellationRequested();
        string executable = ProjectInspector.FindExecutable(launchSettings.Directory)!;
        string config = ProjectInspector.FindConfig(launchSettings.Directory)!;
        string tempDirectory = Path.Combine(
            AppSettings.DataDirectory,
            "Temp",
            $"server-{Guid.NewGuid():N}"
        );
        StreamWriter? writer = null;
        try
        {
            System.IO.Directory.CreateDirectory(AppSettings.LogDirectory);
            System.IO.Directory.CreateDirectory(tempDirectory);
            FileStream logStream = new(
                LogPath,
                FileMode.OpenOrCreate,
                FileAccess.Write,
                FileShare.ReadWrite
            );
            logStream.Seek(0, SeekOrigin.End);
            writer = CreateLogWriter(logStream);
            await writer.WriteLineAsync(
                $"\n=== {DateTimeOffset.Now:O} · 127.0.0.1:{launchSettings.Port} ==="
            );
            cancellation.Token.ThrowIfCancellationRequested();
        }
        catch (Exception error) when (
            error is IOException
            or UnauthorizedAccessException
            or OperationCanceledException
        )
        {
            DisposeWriter(writer);
            CleanupTempDirectory(tempDirectory);
            if (error is OperationCanceledException)
            {
                return EndCancelledStartup(cancellation);
            }
            SetState(new ServerState(
                ServerStatus.Failed,
                Error: $"Could not prepare the log: {error.Message}"
            ));
            return false;
        }

        ProcessStartInfo startInfo = new()
        {
            FileName = executable,
            WorkingDirectory = launchSettings.Directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.Environment["TEMP"] = tempDirectory;
        startInfo.Environment["TMP"] = tempDirectory;
        startInfo.Environment["TMPDIR"] = tempDirectory;
        startInfo.Environment["PYTHONUNBUFFERED"] = "1";
        startInfo.ArgumentList.Add("serve");
        startInfo.ArgumentList.Add("-f");
        startInfo.ArgumentList.Add(config);
        startInfo.ArgumentList.Add("--dev-addr");
        startInfo.ArgumentList.Add($"127.0.0.1:{launchSettings.Port}");
        if (!launchSettings.LiveReload)
        {
            startInfo.ArgumentList.Add("--no-livereload");
        }
        if (launchSettings.DirtyReload)
        {
            startInfo.ArgumentList.Add("--dirty");
        }
        if (launchSettings.StrictMode)
        {
            startInfo.ArgumentList.Add("--strict");
        }

        Process launchedProcess = new() { StartInfo = startInfo };

        bool started = false;
        try
        {
            bool cancelled;
            lock (sync)
            {
                cancelled =
                    disposed
                    || stopping
                    || cancellation.IsCancellationRequested
                    || !ReferenceEquals(startupCancellation, cancellation);
                if (!cancelled)
                {
                    started = launchedProcess.Start();
                    if (!started)
                    {
                        throw new InvalidOperationException("Windows could not start MkDocs.");
                    }
                    process = launchedProcess;
                    logWriter = writer;
                    processOutputTask = Task.WhenAll(
                        PumpProcessOutputAsync(launchedProcess.StandardOutput),
                        PumpProcessOutputAsync(launchedProcess.StandardError)
                    );
                    processTempDirectory = tempDirectory;
                    logWriteFailureReported = false;
                    processExitSignal = new TaskCompletionSource(
                        TaskCreationOptions.RunContinuationsAsynchronously
                    );
                }
            }
            if (cancelled)
            {
                launchedProcess.Dispose();
                DisposeWriter(writer);
                CleanupTempDirectory(tempDirectory);
                return EndCancelledStartup(cancellation);
            }
            launchedProcess.Exited += ProcessExited;
            launchedProcess.EnableRaisingEvents = true;
        }
        catch (Exception error) when (
            error is InvalidOperationException or System.ComponentModel.Win32Exception
        )
        {
            if (started)
            {
                await CleanupStartupProcessAsync(launchedProcess, terminate: true);
            }
            else
            {
                launchedProcess.Dispose();
                DisposeWriter(writer);
                CleanupTempDirectory(tempDirectory);
            }
            SetState(new ServerState(ServerStatus.Failed, Error: error.Message));
            return false;
        }

        try
        {
            while (!cancellation.IsCancellationRequested)
            {
                if (launchedProcess.HasExited)
                {
                    await CleanupStartupProcessAsync(
                        launchedProcess,
                        terminate: false
                    );
                    if (stopping)
                    {
                        return false;
                    }
                    SetState(new ServerState(
                        ServerStatus.Failed,
                        Error: "MkDocs exited; check the log for details"
                    ));
                    return false;
                }
                if (await IsPortOpenAsync(launchSettings.Port, cancellation.Token))
                {
                    lock (sync)
                    {
                        if (
                            ReferenceEquals(process, launchedProcess)
                            && !disposed
                            && !stopping
                            && !cancellation.IsCancellationRequested
                        )
                        {
                            SetState(new ServerState(ServerStatus.Running, Managed: true));
                            return true;
                        }
                    }
                    break;
                }
                await Task.Delay(350, cancellation.Token);
            }
        }
        catch (OperationCanceledException)
        {
            // The timeout or an explicit stop cancelled startup.
        }
        catch (Exception error) when (
            error is InvalidOperationException or ObjectDisposedException
        )
        {
            if (!stopping && State.Status != ServerStatus.Failed)
            {
                SetState(new ServerState(
                    ServerStatus.Failed,
                    Error: "MkDocs exited; check the log for details"
                ));
            }
            return false;
        }

        if (!stopping)
        {
            SetState(new ServerState(
                ServerStatus.Failed,
                Error: "The server did not become ready before the startup timeout"
            ));
            await CleanupStartupProcessAsync(launchedProcess, terminate: true);
        }
        else
        {
            await CleanupStartupProcessAsync(launchedProcess, terminate: true);
        }
        return false;
    }

    private async Task PumpProcessOutputAsync(StreamReader reader)
    {
        char[] buffer = new char[16 * 1024];
        try
        {
            while (true)
            {
                int read = await reader
                    .ReadAsync(buffer.AsMemory())
                    .ConfigureAwait(false);
                if (read == 0)
                {
                    return;
                }
                WriteLogChunk(buffer.AsMemory(0, read));
            }
        }
        catch (Exception error) when (
            error is IOException or ObjectDisposedException
        )
        {
            Trace.WriteLine($"Unable to read MkDocs output: {error}");
        }
    }

    private void WriteLogChunk(ReadOnlyMemory<char> text)
    {
        if (text.IsEmpty)
        {
            return;
        }

        StreamWriter? failedWriter = null;
        string? failureMessage = null;
        lock (sync)
        {
            if (logWriter is null)
            {
                return;
            }
            try
            {
                logWriter.Write(text.Span);
            }
            catch (Exception error) when (
                error is IOException
                or UnauthorizedAccessException
                or ObjectDisposedException
            )
            {
                failedWriter = logWriter;
                logWriter = null;
                if (!logWriteFailureReported)
                {
                    logWriteFailureReported = true;
                    failureMessage = $"Notes can no longer write the server log: {error.Message}";
                }
            }
        }

        DisposeWriter(failedWriter);
        if (failureMessage is not null)
        {
            PostToUi(() => LogWriteFailed?.Invoke(failureMessage));
        }
    }

    private async void ProcessExited(object? sender, EventArgs args)
    {
        if (sender is not Process exitedProcess)
        {
            return;
        }

        Task? outputTask;
        lock (sync)
        {
            if (!ReferenceEquals(process, exitedProcess))
            {
                return;
            }
            outputTask = processOutputTask;
        }
        await DrainOutputAsync(outputTask).ConfigureAwait(false);

        bool wasStopping;
        TaskCompletionSource? exitSignal;
        string? tempDirectory;
        StreamWriter? writer;
        lock (sync)
        {
            if (!ReferenceEquals(process, exitedProcess))
            {
                return;
            }
            wasStopping = stopping;
            process = null;
            processOutputTask = null;
            writer = logWriter;
            logWriter = null;
            tempDirectory = processTempDirectory;
            processTempDirectory = null;
            exitSignal = processExitSignal;
            processExitSignal = null;
        }
        DisposeWriter(writer);
        exitedProcess.Dispose();
        CleanupTempDirectory(tempDirectory);
        exitSignal?.TrySetResult();

        if (!wasStopping && State.Status != ServerStatus.Failed)
        {
            SetState(new ServerState(
                ServerStatus.Failed,
                Error: "MkDocs exited; check the log for details"
            ));
        }
    }

    private async Task RefreshHealthAsync()
    {
        if (
            disposed
            || Interlocked.Exchange(ref healthCheckActive, 1) != 0
        )
        {
            return;
        }

        try
        {
            long generation;
            int port;
            lock (sync)
            {
                if (
                    disposed
                    || stopping
                    || State.Status is ServerStatus.Starting or ServerStatus.Failed
                )
                {
                    return;
                }
                generation = Volatile.Read(ref healthGeneration);
                port = Settings.Port;
            }

            bool reachable = await IsPortOpenAsync(port, CancellationToken.None);
            lock (sync)
            {
                if (
                    disposed
                    || stopping
                    || generation != Volatile.Read(ref healthGeneration)
                    || port != Settings.Port
                )
                {
                    return;
                }

                ServerState currentState = State;
                if (currentState.Status == ServerStatus.Running && !reachable)
                {
                    if (!currentState.Managed || !IsManagedProcessRunning())
                    {
                        SetState(new ServerState(ServerStatus.Stopped));
                    }
                    else if (Interlocked.Increment(ref consecutiveHealthFailures) >= 3)
                    {
                        SetState(new ServerState(
                            ServerStatus.Failed,
                            Managed: true,
                            Error: "MkDocs is running but no longer accepting connections"
                        ));
                    }
                }
                else if (currentState.Status == ServerStatus.Stopped && reachable)
                {
                    Volatile.Write(ref consecutiveHealthFailures, 0);
                    SetState(new ServerState(ServerStatus.Running, Managed: false));
                }
                else if (reachable)
                {
                    Volatile.Write(ref consecutiveHealthFailures, 0);
                }
            }
        }
        finally
        {
            Volatile.Write(ref healthCheckActive, 0);
        }
    }

    private static async Task<bool> IsPortOpenAsync(
        int port,
        CancellationToken cancellationToken
    )
    {
        using TcpClient client = new();
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken
        );
        timeout.CancelAfter(TimeSpan.FromMilliseconds(800));
        try
        {
            await client.ConnectAsync("127.0.0.1", port, timeout.Token);
            return true;
        }
        catch (Exception error) when (
            error is SocketException or OperationCanceledException or ArgumentOutOfRangeException
        )
        {
            return false;
        }
    }

    private void SetState(ServerState state)
    {
        lock (sync)
        {
            if (state.Status != ServerStatus.Running)
            {
                Volatile.Write(ref consecutiveHealthFailures, 0);
            }
            Volatile.Write(ref this.state, state);
            Interlocked.Increment(ref healthGeneration);
        }
        PostToUi(() => StateChanged?.Invoke(this, EventArgs.Empty));
    }

    private void PostToUi(Action action)
    {
        postToUi(action);
    }

    private async Task CleanupStartupProcessAsync(Process target, bool terminate)
    {
        TaskCompletionSource? exitSignal = null;
        string? tempDirectory = null;
        StreamWriter? writer = null;
        bool exited = false;
        try
        {
            if (terminate && !target.HasExited)
            {
                ProcessLifecycle.TryKillTree(target, "the Notes server process tree");
            }
            if (target.HasExited)
            {
                exited = true;
            }
            else
            {
                await target
                    .WaitForExitAsync()
                    .WaitAsync(TimeSpan.FromSeconds(5))
                    .ConfigureAwait(false);
                exited = true;
            }
        }
        catch (TimeoutException)
        {
            exited = false;
        }
        catch (Exception error) when (
            error is InvalidOperationException or ObjectDisposedException
        )
        {
            // The process has already exited.
            exited = true;
        }
        catch (System.ComponentModel.Win32Exception error)
        {
            Trace.WriteLine($"Unable to terminate the Notes server process: {error}");
            exited = !IsProcessRunning(target);
        }

        if (!exited)
        {
            return;
        }

        Task? outputTask;
        lock (sync)
        {
            outputTask = ReferenceEquals(process, target) ? processOutputTask : null;
        }
        await DrainOutputAsync(outputTask).ConfigureAwait(false);

        lock (sync)
        {
            if (ReferenceEquals(process, target))
            {
                process = null;
                processOutputTask = null;
                writer = logWriter;
                logWriter = null;
                tempDirectory = processTempDirectory;
                processTempDirectory = null;
                exitSignal = processExitSignal;
                processExitSignal = null;
            }
        }
        DisposeWriter(writer);
        target.Dispose();
        CleanupTempDirectory(tempDirectory);
        exitSignal?.TrySetResult();
    }

    private static async Task DrainOutputAsync(Task? outputTask)
    {
        if (outputTask is null)
        {
            return;
        }
        try
        {
            await outputTask
                .WaitAsync(TimeSpan.FromSeconds(5))
                .ConfigureAwait(false);
        }
        catch (Exception error) when (
            error is TimeoutException or IOException or ObjectDisposedException
        )
        {
            Trace.WriteLine($"Unable to drain MkDocs output: {error}");
        }
    }

    private Task RequestStop(bool force)
    {
        CancellationTokenSource? cancellation;
        Process? runningProcess;
        Task exitTask;
        lock (sync)
        {
            stopping = true;
            cancellation = startupCancellation;
            runningProcess = process;
            exitTask = processExitSignal?.Task ?? Task.CompletedTask;
        }
        try
        {
            cancellation?.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Startup completed while the stop request was being prepared.
        }

        if (runningProcess is not null)
        {
            try
            {
                if (
                    !runningProcess.HasExited
                    && (
                        force
                        || !runningProcess.CloseMainWindow()
                    )
                )
                {
                    ProcessLifecycle.TryKillTree(
                        runningProcess,
                        "the Notes server process tree"
                    );
                }
            }
            catch (Exception error) when (
                error is InvalidOperationException
                or ObjectDisposedException
                or System.ComponentModel.Win32Exception
            )
            {
                // The process exited or was disposed between the state check and kill request.
            }
        }
        return exitTask;
    }

    private Task GetStopCompletion(Task processExitTask)
    {
        lock (sync)
        {
            return startupTask is { IsCompleted: false }
                ? Task.WhenAll(processExitTask, startupTask)
                : processExitTask;
        }
    }

    private bool CanContinueStartup(CancellationTokenSource cancellation)
    {
        lock (sync)
        {
            return
                !disposed
                && !stopping
                && !cancellation.IsCancellationRequested
                && ReferenceEquals(startupCancellation, cancellation);
        }
    }

    private bool EndCancelledStartup(CancellationTokenSource cancellation)
    {
        bool timedOut;
        lock (sync)
        {
            timedOut =
                !disposed
                && !stopping
                && cancellation.IsCancellationRequested
                && ReferenceEquals(startupCancellation, cancellation);
        }
        if (timedOut)
        {
            SetState(new ServerState(
                ServerStatus.Failed,
                Error: "The server did not become ready before the startup timeout"
            ));
        }
        return false;
    }

    private static void DisposeWriter(StreamWriter? writer)
    {
        if (writer is null)
        {
            return;
        }
        try
        {
            writer.Dispose();
        }
        catch (Exception error) when (
            error is IOException or ObjectDisposedException
        )
        {
            Trace.WriteLine($"Unable to close the Notes server log: {error}");
        }
    }

    private static void CleanupTempDirectory(string? tempDirectory)
    {
        if (string.IsNullOrEmpty(tempDirectory))
        {
            return;
        }

        try
        {
            if (System.IO.Directory.Exists(tempDirectory))
            {
                System.IO.Directory.Delete(tempDirectory, recursive: true);
            }
        }
        catch (Exception error) when (
            error is IOException or UnauthorizedAccessException
        )
        {
            Trace.WriteLine(
                $"Unable to clean Notes server temporary directory '{tempDirectory}': {error}"
            );
        }
    }

    private bool IsManagedProcessRunning()
    {
        lock (sync)
        {
            return process is not null && IsProcessRunning(process);
        }
    }

    private static bool IsProcessRunning(Process target)
    {
        try
        {
            return !target.HasExited;
        }
        catch (Exception error) when (
            error is InvalidOperationException or ObjectDisposedException
        )
        {
            return false;
        }
    }

    private static StreamWriter CreateLogWriter(FileStream stream) =>
        new(stream, new UTF8Encoding(false)) { AutoFlush = true };

    private void ReleaseStartupCancellation(CancellationTokenSource cancellation)
    {
        lock (sync)
        {
            if (ReferenceEquals(startupCancellation, cancellation))
            {
                startupCancellation = null;
            }
        }
        cancellation.Dispose();
    }

    public Task ShutdownAsync()
    {
        lock (sync)
        {
            if (shutdownTask is not null)
            {
                return shutdownTask;
            }
            disposed = true;
            healthTimer.Dispose();
            shutdownTask = ShutdownCoreAsync();
            return shutdownTask;
        }
    }

    private async Task ShutdownCoreAsync()
    {
        await configurationGate.WaitAsync();
        try
        {
            await StopForShutdownAsync();
        }
        finally
        {
            configurationGate.Release();
        }
    }

    private async Task StopForShutdownAsync()
    {
        Task stopTask = GetStopCompletion(RequestStop(force: false));
        try
        {
            await stopTask.WaitAsync(TimeSpan.FromSeconds(1));
        }
        catch (TimeoutException)
        {
            stopTask = GetStopCompletion(RequestStop(force: true));
            try
            {
                await stopTask.WaitAsync(TimeSpan.FromSeconds(4));
            }
            catch (TimeoutException error)
            {
                Trace.WriteLine($"Timed out while shutting down the Notes server: {error}");
            }
        }

        CancellationTokenSource? cancellation;
        StreamWriter? writer = null;
        lock (sync)
        {
            cancellation = startupCancellation;
            startupCancellation = null;
            if (process is null)
            {
                writer = logWriter;
                logWriter = null;
            }
        }
        cancellation?.Dispose();
        DisposeWriter(writer);
    }

    public async ValueTask DisposeAsync()
    {
        await ShutdownAsync();
    }
}
