using System.Windows;
using SpotifySynesthesia.AudioEngine.LastFm;

namespace SpotifySynesthesia.Desktop;

public partial class LastFmSettingsDialog : Window
{
    public LastFmSettingsDialog(bool isConfigured)
    {
        InitializeComponent();
        RemoveButton.IsEnabled = isConfigured;
        Loaded += (_, _) => ApiKeyBox.Focus();
    }

    public string? ApiKey { get; private set; }

    public bool RemoveRequested { get; private set; }

    private void HandleSave(object sender, RoutedEventArgs e)
    {
        string value = ApiKeyBox.Password.Trim();
        if (!LastFmApiKeyValidator.IsValid(value))
        {
            ValidationMessage.Text = "Enter a valid API key without spaces.";
            ApiKeyBox.Focus();
            return;
        }

        ApiKey = value;
        DialogResult = true;
    }

    private void HandleRemove(object sender, RoutedEventArgs e)
    {
        RemoveRequested = true;
        DialogResult = true;
    }
}
