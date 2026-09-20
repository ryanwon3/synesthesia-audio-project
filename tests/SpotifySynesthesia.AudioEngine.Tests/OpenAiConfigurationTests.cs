using SpotifySynesthesia.AudioEngine.OpenAi;
using SpotifySynesthesia.AudioEngine.Server;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class OpenAiConfigurationTests
{
    [Fact]
    public async Task SavingAndRemovingTheKeyPublishesOnlyConfigurationState()
    {
        await using AudioFrameWebSocketServer server = new();
        MemoryOpenAiApiKeyStore store = new();
        await using SpotifyMetadataRuntime runtime = new(
            server,
            new ValidAuthorizationService(),
            new FailingPlaybackClient(),
            new TestSongProfileRepository(),
            openAiApiKeyStore: store);

        await runtime.ConfigureOpenAiApiKeyAsync(
            "sk-test-key",
            TestContext.Current.CancellationToken);

        Assert.True(runtime.IsOpenAiConfigured);
        Assert.True(runtime.CurrentSnapshot.OpenAiConfigured);
        Assert.Equal("sk-test-key", store.ApiKey);

        await runtime.ConfigureOpenAiApiKeyAsync(null, TestContext.Current.CancellationToken);

        Assert.False(runtime.IsOpenAiConfigured);
        Assert.False(runtime.CurrentSnapshot.OpenAiConfigured);
        Assert.Null(store.ApiKey);
    }

    private sealed class MemoryOpenAiApiKeyStore : IOpenAiApiKeyStore
    {
        public string? ApiKey { get; private set; }

        public Task<string?> LoadAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult(ApiKey);

        public Task SaveAsync(string apiKey, CancellationToken cancellationToken = default)
        {
            ApiKey = apiKey;
            return Task.CompletedTask;
        }

        public Task ClearAsync(CancellationToken cancellationToken = default)
        {
            ApiKey = null;
            return Task.CompletedTask;
        }
    }
}
