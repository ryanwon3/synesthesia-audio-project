using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace SpotifySynesthesia.AudioEngine.LastFm;

public interface ILastFmApiClient
{
    Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
        string apiKey,
        string artist,
        string track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default);

    Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
        string apiKey,
        LastFmTrackInfo track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default);

    Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
        string apiKey,
        LastFmTrackInfo track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default);
}

public sealed class LastFmApiClient : ILastFmApiClient
{
    private static readonly Uri ApiEndpoint = new("https://ws.audioscrobbler.com/2.0/");
    private readonly HttpClient _httpClient;
    private readonly TimeProvider _timeProvider;

    public LastFmApiClient(HttpClient httpClient, TimeProvider? timeProvider = null)
    {
        _httpClient = httpClient ?? throw new ArgumentNullException(nameof(httpClient));
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public Task<LastFmApiResult<LastFmTrackInfo>> GetTrackInfoAsync(
        string apiKey,
        string artist,
        string track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default) => SendAsync(
            CreateUri("track.getInfo", apiKey, ("artist", artist), ("track", track), ("autocorrect", "1")),
            requestTimeout,
            ParseTrackInfo,
            cancellationToken);

    public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetTrackTopTagsAsync(
        string apiKey,
        LastFmTrackInfo track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default)
    {
        // Use the canonical names returned by track.getInfo. Last.fm's MBID tag
        // lookup can fail even when that same track has tags under its name.
        Uri uri = CreateUri(
                "track.getTopTags",
                apiKey,
                ("artist", track.ArtistName),
                ("track", track.TrackName),
                ("autocorrect", "1"));
        return SendAsync(uri, requestTimeout, ParseTopTags, cancellationToken);
    }

    public Task<LastFmApiResult<IReadOnlyList<LastFmProviderTag>>> GetArtistTopTagsAsync(
        string apiKey,
        LastFmTrackInfo track,
        TimeSpan requestTimeout,
        CancellationToken cancellationToken = default)
    {
        Uri uri = CreateUri("artist.getTopTags", apiKey, ("artist", track.ArtistName), ("autocorrect", "1"));
        return SendAsync(uri, requestTimeout, ParseTopTags, cancellationToken);
    }

    private async Task<LastFmApiResult<T>> SendAsync<T>(
        Uri uri,
        TimeSpan requestTimeout,
        Func<JsonElement, T?> parser,
        CancellationToken cancellationToken)
    {
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(requestTimeout);
        using HttpRequestMessage request = new(HttpMethod.Get, uri);
        try
        {
            using HttpResponseMessage response = await _httpClient
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token)
                .ConfigureAwait(false);
            TimeSpan? retryAfter = ReadRetryAfter(response.Headers.RetryAfter);
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
            {
                return new LastFmApiResult<T>(
                    LastFmApiResultKind.RateLimited,
                    ErrorCategory: LastFmErrorCategory.RateLimit,
                    RetryAfter: retryAfter);
            }

            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            {
                return new LastFmApiResult<T>(
                    LastFmApiResultKind.InvalidCredentials,
                    ErrorCategory: LastFmErrorCategory.InvalidApiKey);
            }

            if (response.StatusCode == HttpStatusCode.NotFound)
            {
                return new LastFmApiResult<T>(
                    LastFmApiResultKind.NoMatch,
                    ErrorCategory: LastFmErrorCategory.NoMatch);
            }

            if ((int)response.StatusCode >= 500)
            {
                return new LastFmApiResult<T>(
                    LastFmApiResultKind.Unavailable,
                    ErrorCategory: LastFmErrorCategory.ServerError,
                    RetryAfter: retryAfter);
            }

            await using Stream stream = await response.Content.ReadAsStreamAsync(timeout.Token).ConfigureAwait(false);
            JsonDocument document;
            try
            {
                document = await JsonDocument.ParseAsync(stream, cancellationToken: timeout.Token).ConfigureAwait(false);
            }
            catch (JsonException)
            {
                return new LastFmApiResult<T>(
                    LastFmApiResultKind.Error,
                    ErrorCategory: response.IsSuccessStatusCode
                        ? LastFmErrorCategory.MalformedResponse
                        : LastFmErrorCategory.UnexpectedResponse);
            }

            using (document)
            {
                LastFmApiResult<T>? providerError = ReadProviderError<T>(document.RootElement, retryAfter);
                if (providerError is not null)
                {
                    return providerError;
                }

                if (!response.IsSuccessStatusCode)
                {
                    return new LastFmApiResult<T>(
                        LastFmApiResultKind.Error,
                        ErrorCategory: LastFmErrorCategory.UnexpectedResponse);
                }

                T? value;
                try
                {
                    value = parser(document.RootElement);
                }
                catch (InvalidOperationException)
                {
                    return new LastFmApiResult<T>(
                        LastFmApiResultKind.Error,
                        ErrorCategory: LastFmErrorCategory.MalformedResponse);
                }

                return value is null
                    ? new LastFmApiResult<T>(
                        LastFmApiResultKind.Error,
                        ErrorCategory: LastFmErrorCategory.MalformedResponse)
                    : new LastFmApiResult<T>(LastFmApiResultKind.Success, value);
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new LastFmApiResult<T>(
                LastFmApiResultKind.Unavailable,
                ErrorCategory: LastFmErrorCategory.Timeout);
        }
        catch (HttpRequestException)
        {
            return new LastFmApiResult<T>(
                LastFmApiResultKind.Unavailable,
                ErrorCategory: LastFmErrorCategory.Network);
        }
    }

    private static LastFmTrackInfo? ParseTrackInfo(JsonElement root)
    {
        if (!root.TryGetProperty("track", out JsonElement track) || track.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        string? trackName = ReadString(track, "name");
        if (!track.TryGetProperty("artist", out JsonElement artist) || artist.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        string? artistName = ReadString(artist, "name");
        if (string.IsNullOrWhiteSpace(trackName) || string.IsNullOrWhiteSpace(artistName))
        {
            return null;
        }

        bool autocorrected = track.TryGetProperty("@attr", out JsonElement attributes) &&
            string.Equals(ReadString(attributes, "corrected"), "1", StringComparison.Ordinal);
        return new LastFmTrackInfo(
            trackName,
            artistName,
            NormalizeMusicBrainzId(ReadString(track, "mbid")),
            NormalizeMusicBrainzId(ReadString(artist, "mbid")),
            ReadInt64(track, "duration"),
            autocorrected);
    }

    private static IReadOnlyList<LastFmProviderTag>? ParseTopTags(JsonElement root)
    {
        if (!root.TryGetProperty("toptags", out JsonElement topTags) || topTags.ValueKind != JsonValueKind.Object)
        {
            return null;
        }

        if (!topTags.TryGetProperty("tag", out JsonElement tags) || tags.ValueKind is JsonValueKind.Null)
        {
            return [];
        }

        List<LastFmProviderTag> result = [];
        if (tags.ValueKind == JsonValueKind.Array)
        {
            int rank = 0;
            foreach (JsonElement tag in tags.EnumerateArray())
            {
                AddTag(tag, rank++, result);
            }

            return result;
        }

        if (tags.ValueKind == JsonValueKind.Object)
        {
            AddTag(tags, 0, result);
            return result;
        }

        return null;
    }

    private static void AddTag(JsonElement tag, int rank, List<LastFmProviderTag> tags)
    {
        if (tag.ValueKind == JsonValueKind.Object)
        {
            tags.Add(new LastFmProviderTag(ReadString(tag, "name"), ReadInt64(tag, "count"), rank));
        }
    }

    private static LastFmApiResult<T>? ReadProviderError<T>(JsonElement root, TimeSpan? retryAfter)
    {
        if (!root.TryGetProperty("error", out JsonElement error))
        {
            return null;
        }

        int? code = error.ValueKind switch
        {
            JsonValueKind.Number when error.TryGetInt32(out int numeric) => numeric,
            JsonValueKind.String when int.TryParse(error.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int text) => text,
            _ => null,
        };
        return code switch
        {
            4 or 10 => new LastFmApiResult<T>(
                LastFmApiResultKind.InvalidCredentials,
                ErrorCategory: LastFmErrorCategory.InvalidApiKey),
            26 => new LastFmApiResult<T>(
                LastFmApiResultKind.InvalidCredentials,
                ErrorCategory: LastFmErrorCategory.SuspendedApiKey),
            29 => new LastFmApiResult<T>(
                LastFmApiResultKind.RateLimited,
                ErrorCategory: LastFmErrorCategory.RateLimit,
                RetryAfter: retryAfter),
            // Last.fm uses error 6 for missing tracks and tag collections even though its
            // generic documentation describes the code as "invalid parameters". All public
            // calls in this client supply their required parameters, so it is a no-match here.
            6 or 7 => new LastFmApiResult<T>(
                LastFmApiResultKind.NoMatch,
                ErrorCategory: LastFmErrorCategory.NoMatch),
            8 => new LastFmApiResult<T>(
                LastFmApiResultKind.Unavailable,
                ErrorCategory: LastFmErrorCategory.ServerError,
                RetryAfter: retryAfter),
            11 or 16 => new LastFmApiResult<T>(
                LastFmApiResultKind.Unavailable,
                ErrorCategory: LastFmErrorCategory.ServiceOffline,
                RetryAfter: retryAfter),
            _ => new LastFmApiResult<T>(
                LastFmApiResultKind.Error,
                ErrorCategory: LastFmErrorCategory.UnexpectedResponse),
        };
    }

    private static Uri CreateUri(string method, string apiKey, params (string Name, string? Value)[] values)
    {
        if (string.IsNullOrWhiteSpace(apiKey))
        {
            throw new ArgumentException("A Last.fm API key is required.", nameof(apiKey));
        }

        IEnumerable<(string Name, string Value)> parameters =
            new[] { ("method", method), ("api_key", apiKey), ("format", "json") }
                .Concat(values.Where(item => !string.IsNullOrWhiteSpace(item.Value))
                    .Select(item => (item.Name, item.Value!)));
        string query = string.Join(
            "&",
            parameters.Select(item => $"{Uri.EscapeDataString(item.Name)}={Uri.EscapeDataString(item.Value)}"));
        return new UriBuilder(ApiEndpoint) { Query = query }.Uri;
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

    private static string? ReadString(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out JsonElement value))
        {
            return null;
        }

        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString(),
            JsonValueKind.Number => value.GetRawText(),
            _ => null,
        };
    }

    private static long? ReadInt64(JsonElement parent, string name)
    {
        if (!parent.TryGetProperty(name, out JsonElement value))
        {
            return null;
        }

        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long numeric))
        {
            return numeric;
        }

        return value.ValueKind == JsonValueKind.String &&
            long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out long text)
            ? text
            : null;
    }

    private static string? NormalizeMusicBrainzId(string? value) =>
        Guid.TryParse(value, out Guid id) ? id.ToString("D", CultureInfo.InvariantCulture) : null;
}
