using System.Windows;
using SpotifySynesthesia.AudioEngine.OpenAi;
using SpotifySynesthesia.AudioEngine.Lyrics;
using System.Windows.Controls;

namespace SpotifySynesthesia.Desktop;

public partial class OpenAiSettingsDialog : Window
{
    public OpenAiSettingsDialog(bool isConfigured, LyricsAnalysisSettings? settings = null)
    {
        InitializeComponent();
        RemoveButton.IsEnabled = isConfigured;
        AutomaticBox.IsChecked = settings?.Automatic ?? true;
        ModelBox.SelectedIndex = settings?.Model == "gpt-5" ? 1 : 0;
        Loaded += (_, _) => ApiKeyBox.Focus();
    }

    public string? ApiKey { get; private set; }

    public bool RemoveRequested { get; private set; }
    public LyricsAnalysisSettings Settings => new(AutomaticBox.IsChecked == true,
        (ModelBox.SelectedItem as ComboBoxItem)?.Content?.ToString() ?? "gpt-5-mini");

    private void HandleSave(object sender, RoutedEventArgs e)
    {
        string value = ApiKeyBox.Password.Trim();
        if (value.Length > 0 && !OpenAiApiKeyValidator.IsValid(value))
        {
            ValidationMessage.Text = "Enter a valid API key without spaces.";
            ApiKeyBox.Focus();
            return;
        }

        ApiKey = value.Length > 0 ? value : null;
        DialogResult = true;
    }

    private void HandleRemove(object sender, RoutedEventArgs e)
    {
        RemoveRequested = true;
        DialogResult = true;
    }
}
