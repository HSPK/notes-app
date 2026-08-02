using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace NotesApp.Windows;

public sealed partial class SettingRow : UserControl
{
    public static readonly DependencyProperty HeaderProperty = DependencyProperty.Register(
        nameof(Header),
        typeof(string),
        typeof(SettingRow),
        new PropertyMetadata("")
    );

    public static readonly DependencyProperty DescriptionProperty =
        DependencyProperty.Register(
            nameof(Description),
            typeof(string),
            typeof(SettingRow),
            new PropertyMetadata("")
        );

    public static readonly DependencyProperty SettingContentProperty =
        DependencyProperty.Register(
            nameof(SettingContent),
            typeof(object),
            typeof(SettingRow),
            new PropertyMetadata(null)
        );

    public SettingRow()
    {
        InitializeComponent();
    }

    public string Header
    {
        get => (string)GetValue(HeaderProperty);
        set => SetValue(HeaderProperty, value);
    }

    public string Description
    {
        get => (string)GetValue(DescriptionProperty);
        set => SetValue(DescriptionProperty, value);
    }

    public object? SettingContent
    {
        get => GetValue(SettingContentProperty);
        set => SetValue(SettingContentProperty, value);
    }
}
