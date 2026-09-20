using System.Text;
using System.Text.RegularExpressions;
using SpotifySynesthesia.AudioEngine.Profiles;

namespace SpotifySynesthesia.AudioEngine.LastFm;

public static partial class LastFmMatcher
{
    private static readonly string[] EditorialMarkers =
    [
        "remaster",
        "remastered",
        "explicit",
        "clean",
        "radio edit",
        "single version",
        "album version",
    ];

    public static IReadOnlyList<LastFmLookupCandidate> CreateCandidates(SongProfileIdentity identity)
    {
        ArgumentNullException.ThrowIfNull(identity);
        string? artist = identity.Artists.Select(item => item.Name).FirstOrDefault(name => !string.IsNullOrWhiteSpace(name));
        string? track = identity.Title;
        if (string.IsNullOrWhiteSpace(artist) || string.IsNullOrWhiteSpace(track))
        {
            return [];
        }

        List<LastFmLookupCandidate> candidates = [new(artist.Trim(), track.Trim())];
        string fallback = StripEditorialSuffix(track);
        if (!string.Equals(fallback, track.Trim(), StringComparison.Ordinal))
        {
            candidates.Add(new LastFmLookupCandidate(artist.Trim(), fallback));
        }

        return candidates;
    }

    public static string NormalizeLookupText(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        string normalized = value.Normalize(NormalizationForm.FormKC);
        StringBuilder builder = new(normalized.Length);
        bool priorWhitespace = false;
        foreach (char character in normalized)
        {
            char mapped = character switch
            {
                '\u2018' or '\u2019' => '\'',
                '\u2010' or '\u2011' or '\u2012' or '\u2013' or '\u2014' => '-',
                _ => character,
            };
            if (char.IsWhiteSpace(mapped))
            {
                if (!priorWhitespace && builder.Length > 0)
                {
                    builder.Append(' ');
                }

                priorWhitespace = true;
                continue;
            }

            builder.Append(char.ToLowerInvariant(mapped));
            priorWhitespace = false;
        }

        return builder.ToString().Trim();
    }

    public static LastFmMatchQuality? ValidateMatch(
        LastFmLookupCandidate candidate,
        LastFmTrackInfo match,
        long? spotifyDurationMs)
    {
        ArgumentNullException.ThrowIfNull(candidate);
        ArgumentNullException.ThrowIfNull(match);
        if (HasGrossDurationConflict(spotifyDurationMs, match.DurationMs))
        {
            return null;
        }

        if (string.Equals(candidate.Artist, match.ArtistName, StringComparison.Ordinal) &&
            string.Equals(candidate.Track, match.TrackName, StringComparison.Ordinal))
        {
            return LastFmMatchQuality.Exact;
        }

        if (string.Equals(
                NormalizeLookupText(candidate.Artist),
                NormalizeLookupText(match.ArtistName),
                StringComparison.Ordinal) &&
            string.Equals(
                NormalizeLookupText(candidate.Track),
                NormalizeLookupText(match.TrackName),
                StringComparison.Ordinal))
        {
            return LastFmMatchQuality.Normalized;
        }

        return match.Autocorrected ? LastFmMatchQuality.ProviderCorrected : null;
    }

    private static string StripEditorialSuffix(string title)
    {
        string trimmed = title.Trim();
        Match featured = FeaturedArtistSuffix().Match(trimmed);
        if (featured.Success)
        {
            return featured.Groups["title"].Value.TrimEnd();
        }

        Match unbracketedFeatured = UnbracketedFeaturedArtistSuffix().Match(trimmed);
        if (unbracketedFeatured.Success)
        {
            return unbracketedFeatured.Groups["title"].Value.TrimEnd();
        }

        Match bracketed = BracketedSuffix().Match(trimmed);
        if (bracketed.Success)
        {
            string suffix = NormalizeLookupText(bracketed.Groups["suffix"].Value);
            if (EditorialMarkers.Any(marker => suffix.Contains(marker, StringComparison.Ordinal)))
            {
                return bracketed.Groups["title"].Value.TrimEnd();
            }
        }

        Match dashed = DashedSuffix().Match(trimmed);
        if (dashed.Success)
        {
            string suffix = NormalizeLookupText(dashed.Groups["suffix"].Value);
            if (EditorialMarkers.Any(marker => suffix.Contains(marker, StringComparison.Ordinal)))
            {
                return dashed.Groups["title"].Value.TrimEnd();
            }
        }

        return trimmed;
    }

    private static bool HasGrossDurationConflict(long? spotifyDurationMs, long? lastFmDurationMs)
    {
        if (spotifyDurationMs is not > 0 || lastFmDurationMs is not > 0)
        {
            return false;
        }

        long difference = Math.Abs(spotifyDurationMs.Value - lastFmDurationMs.Value);
        double permitted = Math.Max(30_000, spotifyDurationMs.Value * 0.20);
        return difference > permitted;
    }

    [GeneratedRegex(@"^(?<title>.+?)\s*[\(\[]\s*(?:feat(?:uring)?|ft)\.?\s+.+[\)\]]\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex FeaturedArtistSuffix();

    [GeneratedRegex(@"^(?<title>.+?)\s+(?:feat(?:uring)?|ft)\.?\s+.+$", RegexOptions.IgnoreCase)]
    private static partial Regex UnbracketedFeaturedArtistSuffix();

    [GeneratedRegex(@"^(?<title>.+?)\s*[\(\[](?<suffix>[^\)\]]+)[\)\]]\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex BracketedSuffix();

    [GeneratedRegex(@"^(?<title>.+?)\s+-\s+(?<suffix>.+?)\s*$", RegexOptions.IgnoreCase)]
    private static partial Regex DashedSuffix();
}
