using System.Text;
using SpotifySynesthesia.AudioEngine.LastFm;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LastFmApiKeyStoreTests
{
    [Fact]
    public async Task ProtectsLoadsReplacesAndRemovesTheApiKey()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"lastfm-key-{Guid.NewGuid():N}");
        string path = Path.Combine(directory, "lastfm-api-key.dat");
        DpapiLastFmApiKeyStore store = new(path);
        try
        {
            await store.SaveAsync("first-test-key", TestContext.Current.CancellationToken);

            byte[] protectedBytes = await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken);
            Assert.DoesNotContain(
                "first-test-key",
                Encoding.UTF8.GetString(protectedBytes),
                StringComparison.Ordinal);
            Assert.Equal("first-test-key", await store.LoadAsync(TestContext.Current.CancellationToken));

            await store.SaveAsync("replacement-test-key", TestContext.Current.CancellationToken);
            Assert.Equal("replacement-test-key", await store.LoadAsync(TestContext.Current.CancellationToken));

            await store.ClearAsync(TestContext.Current.CancellationToken);
            Assert.False(File.Exists(path));
        }
        finally
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }

            if (Directory.Exists(directory))
            {
                Directory.Delete(directory);
            }
        }
    }
}
