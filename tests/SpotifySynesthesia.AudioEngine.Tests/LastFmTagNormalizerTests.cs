using SpotifySynesthesia.AudioEngine.LastFm;

namespace SpotifySynesthesia.AudioEngine.Tests;

public sealed class LastFmTagNormalizerTests
{
    [Fact]
    public void NormalizesDeduplicatesWeightsSortsAndLimitsTags()
    {
        LastFmTagNormalizer normalizer = new(new LastFmOptions
        {
            MaximumTagCount = 3,
            MinimumNormalizedWeight = 0.10,
        });
        LastFmProviderTag[] tags =
        [
            new(" Dream Pop ", 100, 0),
            new("dream   pop", 80, 1),
            new("Atmospheric", 50, 2),
            new("indie", 9, 3),
            new("Melancholic", 25, 4),
            new("bad\u0001tag", 90, 5),
        ];

        IReadOnlyList<LastFmTag> normalized = normalizer.Normalize(tags);

        Assert.Equal(["dream pop", "atmospheric", "melancholic"], normalized.Select(tag => tag.Name));
        Assert.Equal([1.0, 0.5, 0.25], normalized.Select(tag => tag.Weight));
    }

    [Fact]
    public void PreservesProviderOrderWhenCountsAreAbsent()
    {
        LastFmTagNormalizer normalizer = new();

        IReadOnlyList<LastFmTag> normalized = normalizer.Normalize(
        [
            new LastFmProviderTag("Second alphabetically", null, 0),
            new LastFmProviderTag("First alphabetically", null, 1),
        ]);

        Assert.Equal(["second alphabetically", "first alphabetically"], normalized.Select(tag => tag.Name));
        Assert.All(normalized, tag => Assert.Null(tag.Weight));
    }

    [Fact]
    public void RejectsOversizedAndControlNamesAndCapsTheDefaultCollection()
    {
        LastFmProviderTag[] tags = Enumerable.Range(0, 25)
            .Select(index => new LastFmProviderTag($"Tag {index:D2}", 100 - index, index))
            .Append(new LastFmProviderTag(new string('x', 81), 1000, 26))
            .Append(new LastFmProviderTag("bad\u0001tag", 1000, 27))
            .ToArray();

        IReadOnlyList<LastFmTag> normalized = new LastFmTagNormalizer().Normalize(tags);

        Assert.Equal(20, normalized.Count);
        Assert.DoesNotContain(normalized, tag => tag.Name.Length > 80 || tag.Name.Contains('\u0001'));
    }
}
