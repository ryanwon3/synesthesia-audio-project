using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;

namespace SpotifySynesthesia.Desktop;

public partial class App : Application, IDisposable
{
    private const string SingleInstanceMutexName = "Local\\SpotifySynesthesia.Desktop.v1";
    private Mutex? _singleInstanceMutex;
    private bool _ownsSingleInstanceMutex;

    protected override void OnStartup(StartupEventArgs e)
    {
        _singleInstanceMutex = new Mutex(initiallyOwned: true, name: SingleInstanceMutexName, out bool createdNew);
        _ownsSingleInstanceMutex = createdNew;
        if (!createdNew)
        {
            // A normal second launch is an activation request, not a server error.
            ExistingInstanceActivator.TryActivate();
            Shutdown();
            return;
        }

        base.OnStartup(e);
        MainWindow window = new();
        MainWindow = window;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        Dispose();
        base.OnExit(e);
    }

    public void Dispose()
    {
        if (_ownsSingleInstanceMutex)
        {
            _singleInstanceMutex?.ReleaseMutex();
            _ownsSingleInstanceMutex = false;
        }

        _singleInstanceMutex?.Dispose();
        _singleInstanceMutex = null;
        GC.SuppressFinalize(this);
    }

    private static class ExistingInstanceActivator
    {
        private const int RestoreWindow = 9;

        public static void TryActivate()
        {
            string currentPath = Environment.ProcessPath ?? string.Empty;
            int currentId = Environment.ProcessId;
            // The first instance can still be creating its window when a user double-clicks.
            for (int attempt = 0; attempt < 20; attempt++)
            {
                foreach (Process process in Process.GetProcessesByName("SpotifySynesthesia.Desktop"))
                {
                    using (process)
                    {
                        if (process.Id == currentId || !IsSameExecutable(process, currentPath))
                        {
                            continue;
                        }

                        IntPtr window = process.MainWindowHandle;
                        if (window == IntPtr.Zero)
                        {
                            continue;
                        }

                        ShowWindow(window, RestoreWindow);
                        SetForegroundWindow(window);
                        return;
                    }
                }

                Thread.Sleep(50);
            }
        }

        private static bool IsSameExecutable(Process process, string currentPath)
        {
            try
            {
                return string.Equals(process.MainModule?.FileName, currentPath, StringComparison.OrdinalIgnoreCase);
            }
            catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                return false;
            }
        }

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool ShowWindow(IntPtr windowHandle, int command);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetForegroundWindow(IntPtr windowHandle);
    }
}
