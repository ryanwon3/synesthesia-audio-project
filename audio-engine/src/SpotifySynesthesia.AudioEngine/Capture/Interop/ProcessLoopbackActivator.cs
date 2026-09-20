using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Wasapi.CoreAudioApi.Interfaces;

namespace SpotifySynesthesia.AudioEngine.Capture.Interop;

internal static class ProcessLoopbackActivator
{
    private const string ProcessLoopbackDevice = "VAD\\Process_Loopback";
    private const ushort VariantTypeBlob = 65;

    public static async Task<AudioClient> ActivateAsync(
        ProcessLoopbackCaptureOptions options,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(options);
        cancellationToken.ThrowIfCancellationRequested();

        AudioClientActivationParameters activationParameters = new()
        {
            ActivationType = AudioClientActivationType.ProcessLoopback,
            ProcessLoopbackParameters = new AudioClientProcessLoopbackParameters
            {
                TargetProcessId = checked((uint)options.TargetProcessId),
                ProcessLoopbackMode = options.IncludeProcessTree
                    ? ProcessLoopbackMode.IncludeTargetProcessTree
                    : ProcessLoopbackMode.ExcludeTargetProcessTree,
            },
        };

        IntPtr activationParametersPointer = IntPtr.Zero;
        IntPtr propertyVariantPointer = IntPtr.Zero;
        IActivateAudioInterfaceAsyncOperation? operation = null;

        try
        {
            activationParametersPointer = Marshal.AllocCoTaskMem(
                Marshal.SizeOf<AudioClientActivationParameters>());
            Marshal.StructureToPtr(activationParameters, activationParametersPointer, fDeleteOld: false);

            PropertyVariant propertyVariant = new()
            {
                VariantType = VariantTypeBlob,
                Blob = new PropertyVariantBlob
                {
                    Size = checked((uint)Marshal.SizeOf<AudioClientActivationParameters>()),
                    Data = activationParametersPointer,
                },
            };

            propertyVariantPointer = Marshal.AllocCoTaskMem(Marshal.SizeOf<PropertyVariant>());
            Marshal.StructureToPtr(propertyVariant, propertyVariantPointer, fDeleteOld: false);

            ActivationCompletionHandler completionHandler = new();
            Guid audioClientInterfaceId = typeof(IAudioClient).GUID;
            int result = NativeMethods.ActivateAudioInterfaceAsync(
                ProcessLoopbackDevice,
                ref audioClientInterfaceId,
                propertyVariantPointer,
                completionHandler,
                out operation);
            Marshal.ThrowExceptionForHR(result);

            IAudioClient audioClientInterface = await completionHandler.Completion.ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return new AudioClient(audioClientInterface);
        }
        finally
        {
            if (operation is not null && Marshal.IsComObject(operation))
            {
                _ = Marshal.ReleaseComObject(operation);
            }

            if (propertyVariantPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(propertyVariantPointer);
            }

            if (activationParametersPointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(activationParametersPointer);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct AudioClientProcessLoopbackParameters
    {
        public uint TargetProcessId;

        public ProcessLoopbackMode ProcessLoopbackMode;
    }

    private enum ProcessLoopbackMode
    {
        IncludeTargetProcessTree = 0,
        ExcludeTargetProcessTree = 1,
    }

    private enum AudioClientActivationType
    {
        Default = 0,
        ProcessLoopback = 1,
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct AudioClientActivationParameters
    {
        [FieldOffset(0)]
        public AudioClientActivationType ActivationType;

        [FieldOffset(4)]
        public AudioClientProcessLoopbackParameters ProcessLoopbackParameters;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyVariantBlob
    {
        public uint Size;

        public IntPtr Data;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyVariant
    {
        public ushort VariantType;
        public ushort Reserved1;
        public ushort Reserved2;
        public ushort Reserved3;
        public PropertyVariantBlob Blob;
    }

    [ComVisible(true)]
    [ClassInterface(ClassInterfaceType.None)]
    private sealed class ActivationCompletionHandler :
        IActivateAudioInterfaceCompletionHandler,
        IAgileObject
    {
        private readonly TaskCompletionSource<IAudioClient> _completion =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task<IAudioClient> Completion => _completion.Task;

        public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation activateOperation)
        {
            try
            {
                activateOperation.GetActivateResult(out int activateResult, out object activateInterface);
                Marshal.ThrowExceptionForHR(activateResult);

                if (activateInterface is not IAudioClient audioClient)
                {
                    throw new InvalidCastException("Windows did not return an IAudioClient for process loopback.");
                }

                _completion.TrySetResult(audioClient);
            }
            catch (Exception exception)
            {
                _completion.TrySetException(exception);
            }
        }
    }

    [ComImport]
    [Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAgileObject
    {
    }

    private static class NativeMethods
    {
        [DllImport("Mmdevapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
        internal static extern int ActivateAudioInterfaceAsync(
            string deviceInterfacePath,
            ref Guid interfaceId,
            IntPtr activationParameters,
            [MarshalAs(UnmanagedType.Interface)] IActivateAudioInterfaceCompletionHandler completionHandler,
            [MarshalAs(UnmanagedType.Interface)] out IActivateAudioInterfaceAsyncOperation asyncOperation);
    }
}
