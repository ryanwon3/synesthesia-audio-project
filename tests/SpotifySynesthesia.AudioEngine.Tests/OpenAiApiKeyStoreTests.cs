using System.Text;
using SpotifySynesthesia.AudioEngine.OpenAi;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class OpenAiApiKeyStoreTests
{
    [Fact]
    public async Task ProtectsLoadsReplacesAndRemovesTheApiKey()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"openai-key-{Guid.NewGuid():N}");
        string path = Path.Combine(directory, "openai-api-key.dat");
        DpapiOpenAiApiKeyStore store = new(path);
        try
        {
            await store.SaveAsync("sk-first-test-key", TestContext.Current.CancellationToken);

            byte[] protectedBytes = await File.ReadAllBytesAsync(path, TestContext.Current.CancellationToken);
            Assert.DoesNotContain(
                "sk-first-test-key",
                Encoding.UTF8.GetString(protectedBytes),
                StringComparison.Ordinal);
            Assert.Equal("sk-first-test-key", await store.LoadAsync(TestContext.Current.CancellationToken));

            await store.SaveAsync("sk-replacement-test-key", TestContext.Current.CancellationToken);
            Assert.Equal("sk-replacement-test-key", await store.LoadAsync(TestContext.Current.CancellationToken));

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

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData("sk-key with spaces")]
    [InlineData("sk-key\n")]
    public void RejectsInvalidApiKeys(string value)
    {
        Assert.False(OpenAiApiKeyValidator.IsValid(value));
    }
}
