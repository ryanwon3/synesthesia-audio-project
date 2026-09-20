using NAudio.CoreAudioApi;
using NAudio.Wave;
using System.Runtime.InteropServices;

namespace SpotifySynesthesia.TestTonePlayer.Playback;

public sealed class NAudioOutputFactory : IAudioOutputFactory
{
    private const int DesiredLatencyMilliseconds = 50;

    public IReadOnlyList<AudioOutputDevice> GetActiveRenderDevices()
    {
        using MMDeviceEnumerator enumerator = new();
        string? defaultDeviceId = null;

        try
        {
            using MMDevice defaultDevice = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            defaultDeviceId = defaultDevice.ID;
        }
        catch (COMException)
        {
            // The device list can still be useful when Windows has no multimedia default.
        }

        return enumerator
            .EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active)
            .Select(device => new AudioOutputDevice(
                device.ID,
                device.FriendlyName,
                string.Equals(device.ID, defaultDeviceId, StringComparison.Ordinal)))
            .OrderByDescending(device => device.IsDefault)
            .ThenBy(device => device.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();
    }

    public IAudioOutputSession Create(string deviceId)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(deviceId);

        using MMDeviceEnumerator enumerator = new();
        MMDevice device = enumerator.GetDevice(deviceId);

        try
        {
            return new WasapiOutputSession(device, DesiredLatencyMilliseconds);
        }
        catch
        {
            device.Dispose();
            throw;
        }
    }

    private sealed class WasapiOutputSession : IAudioOutputSession
    {
        private readonly MMDevice _device;
        private readonly WasapiOut _output;
        private bool _started;
        private bool _disposed;

        public WasapiOutputSession(MMDevice device, int desiredLatencyMilliseconds)
        {
            _device = device;
            _output = new WasapiOut(
                device,
                AudioClientShareMode.Shared,
                useEventSync: true,
                desiredLatencyMilliseconds);
        }

        public void Start(ISampleProvider source)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            ArgumentNullException.ThrowIfNull(source);

            if (_started)
            {
                throw new InvalidOperationException("The output session has already been started.");
            }

            _output.Init(source.ToWaveProvider());
            _output.Play();
            _started = true;
        }

        public void StopPlayback()
        {
            if (!_disposed && _started)
            {
                _output.Stop();
                _started = false;
            }
        }

        public ValueTask DisposeAsync()
        {
            if (_disposed)
            {
                return ValueTask.CompletedTask;
            }

            StopPlayback();
            _output.Dispose();
            _device.Dispose();
            _disposed = true;
            return ValueTask.CompletedTask;
        }
    }
}
