using System.Runtime.InteropServices;

namespace NotesApp.Windows;

internal static class NativeDialog
{
    private const uint MbOk = 0x00000000;
    private const uint MbIconInformation = 0x00000040;
    private const uint MbIconWarning = 0x00000030;

    public static void ShowInformation(string title, string message)
    {
        ShowInfo(IntPtr.Zero, title, message);
    }

    public static void ShowInfo(IntPtr owner, string title, string message) =>
        MessageBoxW(owner, message, title, MbOk | MbIconInformation);

    public static void ShowWarning(IntPtr owner, string title, string message) =>
        MessageBoxW(owner, message, title, MbOk | MbIconWarning);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(
        IntPtr window,
        string text,
        string caption,
        uint type
    );
}
