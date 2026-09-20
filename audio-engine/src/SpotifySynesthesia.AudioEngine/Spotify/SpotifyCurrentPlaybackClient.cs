using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace SpotifySynesthesia.AudioEngine.Spotify;

public interface ISpotifyCurrentPlaybackClient
{
    Task<SpotifyPlaybackResult> GetCurrentPlaybackAsync(
        string accessToken,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default);
}

public sealed class SpotifyCurrentPlaybackClient : ISpotifyCurrentPlaybackClient
{
    private static readonly Uri CurrentlyPlayingEndpoint = new(
        "https://api.spotify.com/v1/me/player/currently-playing");
    private readonly HttpClient _httpClient;
    private readonly TimeProvider _timeProvider;

    public SpotifyCurrentPlaybackClient(HttpClient httpClient, TimeProvider? timeProvider = null)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<SpotifyPlaybackResult> GetCurrentPlaybackAsync(
        string accessToken,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
        {
            throw new ArgumentException("An access token is required.", nameof(accessToken));
        }

        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(requestTimeout);
        using HttpRequestMessage request = new(HttpMethod.Get, CurrentlyPlayingEndpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);

        try
        {
            using HttpResponseMessage response = await _httpClient
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
                .ConfigureAwait(false);
            return await MapResponseAsync(response, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable);
        }
        catch (HttpRequestException)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable);
        }
    }

    private async Task<SpotifyPlaybackResult> MapResponseAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.StatusCode == HttpStatusCode.NoContent)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.NoPlayback);
        }

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unauthorized);
        }

        if (response.StatusCode == HttpStatusCode.Forbidden)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Forbidden);
        }

        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            return new SpotifyPlaybackResult(
                SpotifyPlaybackResultKind.RateLimited,
                RetryAfter: ReadRetryAfter(response.Headers.RetryAfter));
        }

        if (!response.IsSuccessStatusCode)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable);
        }

        await using Stream stream = await response.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        CurrentlyPlayingResponse? payload;
        try
        {
            payload = await JsonSerializer.DeserializeAsync<CurrentlyPlayingResponse>(
                stream,
                cancellationToken: cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.Unavailable);
        }

        if (payload?.Item is null)
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.NoPlayback);
        }

        TrackItem item = payload.Item;
        if (!string.Equals(payload.CurrentlyPlayingType, "track", StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(item.Type, "track", StringComparison.OrdinalIgnoreCase) ||
            item.IsLocal == true ||
            string.IsNullOrWhiteSpace(item.Id))
        {
            return new SpotifyPlaybackResult(SpotifyPlaybackResultKind.UnsupportedContent);
        }

        IReadOnlyList<SpotifyArtistIdentity> artists = item.Artists?
            .Select(artist => new SpotifyArtistIdentity(NullIfWhiteSpace(artist.Id), NullIfWhiteSpace(artist.Name)))
            .ToArray() ?? [];
        AlbumItem? album = item.Album;
        SpotifyAlbumIdentity? albumIdentity = album is null
            ? null
            : new SpotifyAlbumIdentity(
                NullIfWhiteSpace(album.Id),
                NullIfWhiteSpace(album.Name),
                album.Images?.FirstOrDefault(image => !string.IsNullOrWhiteSpace(image.Url))?.Url,
                NullIfWhiteSpace(album.ReleaseDate),
                NullIfWhiteSpace(album.ReleaseDatePrecision));
        CurrentTrack track = new(
            item.Id,
            NullIfWhiteSpace(item.Uri),
            NullIfWhiteSpace(item.ExternalIds?.Isrc),
            NullIfWhiteSpace(item.Name),
            artists,
            albumIdentity,
            item.DurationMs,
            item.Explicit,
            payload.ProgressMs,
            payload.IsPlaying,
            _timeProvider.GetUtcNow());
        return SpotifyPlaybackResult.Playing(track);
    }

    private TimeSpan? ReadRetryAfter(RetryConditionHeaderValue? retryAfter)
    {
        if (retryAfter?.Delta is { } delta)
        {
            return delta < TimeSpan.Zero ? TimeSpan.Zero : delta;
        }

        if (retryAfter?.Date is { } date)
        {
            TimeSpan duration = date - _timeProvider.GetUtcNow();
            return duration < TimeSpan.Zero ? TimeSpan.Zero : duration;
        }

        return null;
    }

    private static string? NullIfWhiteSpace(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value;

    private sealed record CurrentlyPlayingResponse(
        [property: JsonPropertyName("is_playing")] bool IsPlaying,
        [property: JsonPropertyName("progress_ms")] long? ProgressMs,
        [property: JsonPropertyName("currently_playing_type")] string? CurrentlyPlayingType,
        [property: JsonPropertyName("item")] TrackItem? Item);

    private sealed record TrackItem(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("uri")] string? Uri,
        [property: JsonPropertyName("type")] string? Type,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("duration_ms")] long? DurationMs,
        [property: JsonPropertyName("explicit")] bool? Explicit,
        [property: JsonPropertyName("is_local")] bool? IsLocal,
        [property: JsonPropertyName("artists")] ArtistItem[]? Artists,
        [property: JsonPropertyName("album")] AlbumItem? Album,
        [property: JsonPropertyName("external_ids")] ExternalIds? ExternalIds);

    private sealed record ArtistItem(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("name")] string? Name);

    private sealed record AlbumItem(
        [property: JsonPropertyName("id")] string? Id,
        [property: JsonPropertyName("name")] string? Name,
        [property: JsonPropertyName("release_date")] string? ReleaseDate,
        [property: JsonPropertyName("release_date_precision")] string? ReleaseDatePrecision,
        [property: JsonPropertyName("images")] ImageItem[]? Images);

    private sealed record ImageItem([property: JsonPropertyName("url")] string? Url);

    private sealed record ExternalIds([property: JsonPropertyName("isrc")] string? Isrc);
}
