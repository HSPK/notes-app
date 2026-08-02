using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using WinRT.Interop;

namespace NotesApp.Windows;

internal sealed class SystemThemeWatcher : IDisposable
{
    private const uint SystemColorChanged = 0x0015;
    private const uint SettingChanged = 0x001A;
    private const uint ThemeChanged = 0x031A;
    private const nuint SubclassId = 0x5448454D;

    private readonly IntPtr windowHandle;
    private readonly DispatcherQueue dispatcherQueue;
    private readonly Action changed;
    private readonly SubclassProcedure subclassProcedure;
    private int updateQueued;
    private bool disposed;

    private SystemThemeWatcher(Window window, Action changed)
    {
        windowHandle = WindowNative.GetWindowHandle(window);
        dispatcherQueue =
            DispatcherQueue.GetForCurrentThread()
            ?? throw new InvalidOperationException("The WinUI dispatcher is unavailable.");
        this.changed = changed;
        subclassProcedure = WindowProcedure;
        if (!SetWindowSubclass(windowHandle, subclassProcedure, SubclassId, 0))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Windows could not monitor system theme changes."
            );
        }
    }

    public static SystemThemeWatcher? TryCreate(Window window, Action changed)
    {
        try
        {
            return new SystemThemeWatcher(window, changed);
        }
        catch (Win32Exception error)
        {
            Trace.WriteLine($"Unable to monitor system theme changes: {error}");
            return null;
        }
    }

    private IntPtr WindowProcedure(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        nuint subclass,
        nuint referenceData
    )
    {
        if (
            message is SystemColorChanged
                or SettingChanged
                or ThemeChanged
        )
        {
            ScheduleChange();
        }
        return DefSubclassProc(window, message, wParam, lParam);
    }

    private void ScheduleChange()
    {
        if (disposed || Interlocked.Exchange(ref updateQueued, 1) != 0)
        {
            return;
        }
        if (
            !dispatcherQueue.TryEnqueue(() =>
            {
                Volatile.Write(ref updateQueued, 0);
                if (!disposed)
                {
                    changed();
                }
            })
        )
        {
            Volatile.Write(ref updateQueued, 0);
            Trace.TraceError("Notes could not dispatch a system theme update.");
        }
    }

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        RemoveWindowSubclass(windowHandle, subclassProcedure, SubclassId);
    }

    private delegate IntPtr SubclassProcedure(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam,
        nuint subclass,
        nuint referenceData
    );

    [DllImport("comctl32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetWindowSubclass(
        IntPtr window,
        SubclassProcedure procedure,
        nuint subclass,
        nuint referenceData
    );

    [DllImport("comctl32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool RemoveWindowSubclass(
        IntPtr window,
        SubclassProcedure procedure,
        nuint subclass
    );

    [DllImport("comctl32.dll")]
    private static extern IntPtr DefSubclassProc(
        IntPtr window,
        uint message,
        IntPtr wParam,
        IntPtr lParam
    );
}
