using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.UI.Text;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace NotesApp.Windows;

internal static partial class AnsiTextRenderer
{
    public static void Render(RichEditBox textBox, string source, bool useColors)
    {
        bool wasReadOnly = textBox.IsReadOnly;
        if (wasReadOnly)
        {
            textBox.IsReadOnly = false;
        }
        try
        {
            RenderEditableDocument(textBox, source, useColors);
        }
        finally
        {
            if (wasReadOnly)
            {
                textBox.IsReadOnly = true;
            }
        }
    }

    private static void RenderEditableDocument(
        RichEditBox textBox,
        string source,
        bool useColors
    )
    {
        source = source.ReplaceLineEndings("\r");
        bool highContrast = IsHighContrastEnabled();
        if (!useColors || highContrast)
        {
            textBox.Document.SetText(
                TextSetOptions.None,
                AnsiExpression().Replace(source, "")
            );
            return;
        }

        StringBuilder plainText = new(source.Length);
        List<StyledSpan> spans = new();
        int cursor = 0;
        int? colorCode = null;
        bool bold = false;

        foreach (Match match in AnsiExpression().Matches(source))
        {
            AppendSpan(source[cursor..match.Index], colorCode, bold, plainText, spans);
            foreach (int code in ParseCodes(match.Groups[1].Value))
            {
                switch (code)
                {
                    case 0:
                        colorCode = null;
                        bold = false;
                        break;
                    case 1:
                        bold = true;
                        break;
                    case 22:
                        bold = false;
                        break;
                    case 30:
                    case 31:
                    case 32:
                    case 33:
                    case 34:
                    case 35:
                    case 36:
                    case 37:
                    case 39:
                    case 91:
                    case 92:
                    case 93:
                    case 94:
                    case 95:
                    case 96:
                    case 97:
                        colorCode = code == 39 ? null : code;
                        break;
                }
            }
            cursor = match.Index + match.Length;
        }
        AppendSpan(source[cursor..], colorCode, bold, plainText, spans);

        string text = plainText.ToString();
        textBox.Document.SetText(TextSetOptions.None, text);
        bool dark = textBox.ActualTheme == ElementTheme.Dark;
        foreach (StyledSpan span in spans)
        {
            ITextRange range = textBox.Document.GetRange(span.Start, span.Start + span.Length);
            if (span.ColorCode is int code)
            {
                range.CharacterFormat.ForegroundColor = ResolveColor(code, dark);
            }
            if (span.Bold)
            {
                range.CharacterFormat.Bold = FormatEffect.On;
            }
        }
    }

    private static void AppendSpan(
        string value,
        int? colorCode,
        bool bold,
        StringBuilder output,
        List<StyledSpan> spans
    )
    {
        if (value.Length == 0)
        {
            return;
        }
        int start = output.Length;
        output.Append(value);
        if (colorCode is not null || bold)
        {
            spans.Add(new StyledSpan(start, value.Length, colorCode, bold));
        }
    }

    private static IEnumerable<int> ParseCodes(string codes)
    {
        foreach (string value in (codes.Length == 0 ? "0" : codes).Split(';'))
        {
            yield return int.TryParse(value, out int code) ? code : 0;
        }
    }

    private static global::Windows.UI.Color ResolveColor(int code, bool dark)
    {
        return code switch
        {
            30 => dark ? Color(0xFF, 0xC5, 0xC5, 0xC5) : Color(0xFF, 0x3A, 0x3A, 0x3A),
            31 or 91 => dark
                ? Color(0xFF, 0xFF, 0x99, 0x99)
                : Color(0xFF, 0xB4, 0x23, 0x18),
            32 or 92 => dark
                ? Color(0xFF, 0x7D, 0xD3, 0xA5)
                : Color(0xFF, 0x0F, 0x7B, 0x3E),
            33 or 93 => dark
                ? Color(0xFF, 0xF3, 0xC8, 0x66)
                : Color(0xFF, 0x7A, 0x57, 0x00),
            34 or 94 => dark
                ? Color(0xFF, 0x82, 0xBC, 0xFF)
                : Color(0xFF, 0x00, 0x55, 0xA5),
            35 or 95 => dark
                ? Color(0xFF, 0xE0, 0xA0, 0xE8)
                : Color(0xFF, 0x83, 0x2B, 0x8F),
            36 or 96 => dark
                ? Color(0xFF, 0x64, 0xD8, 0xD0)
                : Color(0xFF, 0x00, 0x6F, 0x6A),
            _ => dark ? Color(0xFF, 0xF2, 0xF2, 0xF2) : Color(0xFF, 0x1F, 0x1F, 0x1F)
        };
    }

    private static global::Windows.UI.Color Color(byte a, byte r, byte g, byte b) =>
        global::Windows.UI.Color.FromArgb(a, r, g, b);

    private static bool IsHighContrastEnabled()
    {
        HighContrast highContrast = new()
        {
            Size = (uint)Marshal.SizeOf<HighContrast>()
        };
        if (!SystemParametersInfoW(SpiGetHighContrast, highContrast.Size, ref highContrast, 0))
        {
            throw new Win32Exception(
                Marshal.GetLastWin32Error(),
                "Windows could not read the high contrast setting."
            );
        }
        return (highContrast.Flags & HighContrastEnabled) != 0;
    }

    private sealed record StyledSpan(int Start, int Length, int? ColorCode, bool Bold);

    [StructLayout(LayoutKind.Sequential)]
    private struct HighContrast
    {
        public uint Size;
        public uint Flags;
        public IntPtr DefaultScheme;
    }

    private const uint SpiGetHighContrast = 0x0042;
    private const uint HighContrastEnabled = 0x00000001;

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SystemParametersInfoW(
        uint action,
        uint parameter,
        ref HighContrast value,
        uint update
    );

    [GeneratedRegex(@"\x1B\[([0-9;]*)m")]
    private static partial Regex AnsiExpression();
}
