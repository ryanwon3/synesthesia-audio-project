# Process Loopback Probe

`ProcessCaptureProbe` captures only the render stream belonging to one Windows
process and its child processes. It uses Windows application loopback rather than
the endpoint-wide system mix.

Build the solution, start TestTonePlayer, begin a continuous tone, and note its
displayed process ID. Then run:

```powershell
dotnet run --project tools/ProcessCaptureProbe -- \
  --pid 12345 \
  --duration 3 \
  --expect signal \
  --expected-frequency 440
```

The probe prints typed JSON containing packet/frame counts, RMS, peak, channel
RMS, discontinuities, non-silent ratio, and a simple zero-crossing frequency
estimate. Exit code `0` means the requested expectation passed; `1` means capture
ran but the expectation failed; `2` means command-line arguments were invalid.

For isolation validation, run a 440 Hz TestTonePlayer as the target and a second
TestTonePlayer at 1000 Hz. The target probe must remain near 440 Hz. Then stop the
target while leaving the second instance audible and run with `--expect silence`.
The second process must not create a captured signal.
