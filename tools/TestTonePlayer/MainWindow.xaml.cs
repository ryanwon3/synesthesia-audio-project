using System.Windows;
using SpotifySynesthesia.TestTonePlayer.Ui;

namespace SpotifySynesthesia.TestTonePlayer;

public partial class MainWindow : Window, IAsyncDisposable
{
    private readonly TestTonePlayerViewModel _viewModel;

    public MainWindow()
    {
        InitializeComponent();
        _viewModel = new TestTonePlayerViewModel();
        DataContext = _viewModel;
    }

    protected override void OnClosed(EventArgs e)
    {
        DisposeAsync().AsTask().GetAwaiter().GetResult();
        base.OnClosed(e);
    }

    public async ValueTask DisposeAsync()
    {
        await _viewModel.DisposeAsync();
        GC.SuppressFinalize(this);
    }
}
