using System.Text.Json;
using System.Text.Json.Serialization;
using SpotifySynesthesia.AudioEngine.Database;
using SpotifySynesthesia.AudioEngine.LastFm;

namespace SpotifySynesthesia.AudioEngine.Profiles;

public sealed record SongProfileMetadataEnvelope
{
    [JsonPropertyName("lastFm")]
    public LastFmEnrichment? LastFm { get; init; }

    [JsonExtensionData]
    public IDictionary<string, JsonElement>? AdditionalData { get; init; }
}

public static class SongProfileMetadata
{
    public static LastFmEnrichment? GetLastFm(SongProfile profile)
    {
        ArgumentNullException.ThrowIfNull(profile);
        return Deserialize(profile.Reserved.Metadata).LastFm;
    }

    public static JsonElement MergeLastFm(JsonElement? metadata, LastFmEnrichment enrichment)
    {
        ArgumentNullException.ThrowIfNull(enrichment);
        SongProfileMetadataEnvelope current = Deserialize(metadata);
        return JsonSerializer.SerializeToElement(current with { LastFm = enrichment }, SongProfileJson.Options);
    }

    private static SongProfileMetadataEnvelope Deserialize(JsonElement? metadata)
    {
        if (metadata is null || metadata.Value.ValueKind != JsonValueKind.Object)
        {
            return new SongProfileMetadataEnvelope();
        }

        try
        {
            return metadata.Value.Deserialize<SongProfileMetadataEnvelope>(SongProfileJson.Options) ??
                new SongProfileMetadataEnvelope();
        }
        catch (JsonException)
        {
            return new SongProfileMetadataEnvelope();
        }
    }
}
