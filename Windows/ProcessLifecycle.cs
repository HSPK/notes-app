using System.Diagnostics;

namespace NotesApp.Windows;

internal static class ProcessLifecycle
{
    public static void TryKillTree(Process process, string description)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception error) when (
            error is InvalidOperationException
            or ObjectDisposedException
            or System.ComponentModel.Win32Exception
            or AggregateException
        )
        {
            Trace.WriteLine($"Unable to terminate {description}: {error}");
        }
    }
}
