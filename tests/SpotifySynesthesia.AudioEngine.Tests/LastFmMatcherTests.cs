using SpotifySynesthesia.AudioEngine.LastFm;
using SpotifySynesthesia.AudioEngine.Profiles;
using SpotifySynesthesia.AudioEngine.Spotify;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LastFmMatcherTests
{
    [Fact]
    public void CreatesOneConservativeEditorialFallback()
    {
        SongProfileIdentity identity = CreateIdentity("Beyonce\u0301", "Halo (2019 Remaster)");

        IReadOnlyList<LastFmLookupCandidate> candidates = LastFmMatcher.CreateCandidates(identity);

        Assert.Equal(2, candidates.Count);
        Assert.Equal("Halo (2019 Remaster)", candidates[0].Track);
        Assert.Equal("Halo", candidates[1].Track);
        Assert.Equal("beyonc\u00e9", LastFmMatcher.NormalizeLookupText(candidates[0].Artist));
    }

    [Theory]
    [InlineData("Song feat. Guest", "Song")]
    [InlineData("Song - Explicit", "Song")]
    [InlineData("Song - Radio Edit", "Song")]
    public void RemovesRecognizedUnbracketedEditorialSuffixes(string title, string expectedFallback)
    {
        IReadOnlyList<LastFmLookupCandidate> candidates =
            LastFmMatcher.CreateCandidates(CreateIdentity("Artist", title));

        Assert.Equal(2, candidates.Count);
        Assert.Equal(expectedFallback, candidates[1].Track);
    }

    [Theory]
    [InlineData("Song (Live)")]
    [InlineData("Song (Acoustic)")]
    [InlineData("Song - Remix")]
    public void PreservesRecordingChangingQualifiers(string title)
    {
        Assert.Single(LastFmMatcher.CreateCandidates(CreateIdentity("Artist", title)));
    }

    [Fact]
    public void UsesOnlyThePrimarySpotifyArtist()
    {
        SongProfileIdentity identity = CreateIdentity("Primary", "Song") with
        {
            Artists =
            [
                new SpotifyArtistIdentity("one", "Primary"),
                new SpotifyArtistIdentity("two", "Featured"),
            ],
        };

        LastFmLookupCandidate candidate = Assert.Single(LastFmMatcher.CreateCandidates(identity));

        Assert.Equal("Primary", candidate.Artist);
    }

    [Fact]
    public void RejectsGrossDurationConflictsAndAcceptsProviderCorrection()
    {
        LastFmLookupCandidate candidate = new("Artist", "Song");
        LastFmTrackInfo corrected = new("Corrected Song", "Corrected Artist", null, null, 181_000, true);
        LastFmTrackInfo wrongDuration = corrected with { DurationMs = 300_000 };

        Assert.Equal(
            LastFmMatchQuality.ProviderCorrected,
            LastFmMatcher.ValidateMatch(candidate, corrected, 180_000));
        Assert.Null(LastFmMatcher.ValidateMatch(candidate, wrongDuration, 180_000));
    }

    [Fact]
    public void AcceptsUnicodeCaseApostropheAndDashEquivalence()
    {
        LastFmLookupCandidate candidate = new("Beyonce\u0301", "It\u2019s Here \u2014 Tonight");
        LastFmTrackInfo match = new("IT'S HERE - TONIGHT", "BEYONC\u00c9", null, null, 180_000, false);

        Assert.Equal(
            LastFmMatchQuality.Normalized,
            LastFmMatcher.ValidateMatch(candidate, match, 180_000));
    }

    [Fact]
    public void RejectsMateriallyDifferentNamesWithoutProviderCorrection()
    {
        LastFmLookupCandidate candidate = new("AC/DC", "Song");
        LastFmTrackInfo differentArtist = new("Song", "ACDC", null, null, 180_000, false);
        LastFmTrackInfo differentTrack = new("Other Song", "AC/DC", null, null, 180_000, false);

        Assert.Null(LastFmMatcher.ValidateMatch(candidate, differentArtist, 180_000));
        Assert.Null(LastFmMatcher.ValidateMatch(candidate, differentTrack, 180_000));
    }

    private static SongProfileIdentity CreateIdentity(string artist, string title) => new(
        "track-id",
        "spotify:track:track-id",
        null,
        title,
        [new SpotifyArtistIdentity("artist-id", artist)],
        null,
        180_000,
        false);
}
