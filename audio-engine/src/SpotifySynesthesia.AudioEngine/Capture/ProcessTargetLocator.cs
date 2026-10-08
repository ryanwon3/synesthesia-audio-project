using System.Diagnostics;

namespace SpotifySynesthesia.AudioEngine.Capture;

public static class ProcessTargetLocator
{
    public static ProcessTarget? FindOldestExactMatch(string processName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(processName);
        string normalizedName = Path.GetFileNameWithoutExtension(processName);
        List<ProcessTarget> candidates = [];

        foreach (Process process in Process.GetProcessesByName(normalizedName))
        {
            using (process)
            {
                try
                {
                    if (process.HasExited)
                    {
                        continue;
                    }

                    candidates.Add(new ProcessTarget(
                        process.Id,
                        process.ProcessName,
                        process.StartTime.ToUniversalTime()));
                }
                catch (Exception exception) when (
                    exception is InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    // Processes can exit or become inaccessible during enumeration.
                }
            }
        }

        return candidates
            .OrderBy(candidate => candidate.StartedAtUtc)
            .ThenBy(candidate => candidate.ProcessId)
            .FirstOrDefault();
    }

    public static bool IsAlive(int processId)
    {
        if (processId <= 0)
        {
            return false;
        }

        try
        {
            using Process process = Process.GetProcessById(processId);
            return !process.HasExited;
        }
        catch (Exception exception) when (
            exception is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // The process is gone or cannot be inspected.
            return false;
        }
    }
}

public sealed record ProcessTarget(
    int ProcessId,
    string ProcessName,
    DateTime StartedAtUtc);
