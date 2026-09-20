using System.Text;

namespace SpotifySynesthesia.AudioEngine.LastFm;

public sealed class LastFmTagNormalizer
{
    private readonly LastFmOptions _options;

    public LastFmTagNormalizer(LastFmOptions? options = null)
    {
        _options = options ?? new LastFmOptions();
        _options.Validate();
    }

    public IReadOnlyList<LastFmTag> Normalize(IEnumerable<LastFmProviderTag> tags)
    {
        ArgumentNullException.ThrowIfNull(tags);
        Dictionary<string, Candidate> unique = new(StringComparer.Ordinal);
        foreach (LastFmProviderTag tag in tags)
        {
            string? name = NormalizeName(tag.Name);
            if (name is null)
            {
                continue;
            }

            if (!unique.TryGetValue(name, out Candidate? existing))
            {
                unique[name] = new Candidate(name, tag.Count, tag.Rank);
                continue;
            }

            long? count = existing.Count;
            if (tag.Count is not null && (count is null || tag.Count > count))
            {
                count = tag.Count;
            }

            unique[name] = existing with { Count = count, Rank = Math.Min(existing.Rank, tag.Rank) };
        }

        long maximum = unique.Values.Where(item => item.Count > 0).Select(item => item.Count!.Value).DefaultIfEmpty().Max();
        return unique.Values
            .Select(item => new WeightedCandidate(
                item.Name,
                item.Count is > 0 && maximum > 0
                    ? Math.Round((double)item.Count.Value / maximum, 2, MidpointRounding.AwayFromZero)
                    : null,
                item.Rank))
            .Where(item => item.Weight is null || item.Weight >= _options.MinimumNormalizedWeight)
            .OrderByDescending(item => item.Weight.HasValue)
            .ThenByDescending(item => item.Weight)
            .ThenBy(item => item.Weight.HasValue ? item.Name : string.Empty, StringComparer.Ordinal)
            .ThenBy(item => item.Rank)
            .Take(_options.MaximumTagCount)
            .Select(item => new LastFmTag(item.Name, item.Weight))
            .ToArray();
    }

    private static string? NormalizeName(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string normalized = value.Normalize(NormalizationForm.FormKC);
        if (normalized.Any(char.IsControl))
        {
            return null;
        }

        StringBuilder builder = new(normalized.Length);
        bool priorWhitespace = false;
        foreach (char character in normalized)
        {
            if (char.IsWhiteSpace(character))
            {
                if (!priorWhitespace && builder.Length > 0)
                {
                    builder.Append(' ');
                }

                priorWhitespace = true;
                continue;
            }

            builder.Append(char.ToLowerInvariant(character));
            priorWhitespace = false;
        }

        string result = builder.ToString().Trim();
        return result.Length is 0 or > 80 ? null : result;
    }

    private sealed record Candidate(string Name, long? Count, int Rank);

    private sealed record WeightedCandidate(string Name, double? Weight, int Rank);
}
