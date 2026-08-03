using System.Globalization;

namespace SafeBrowse.Core;

public static class DomainNormalizer
{
    private static readonly IdnMapping Idn = new();

    public static string Normalize(string value)
    {
        var candidate = value.Trim().TrimEnd('.').ToLowerInvariant();
        if (candidate.Length is 0 or > 253 || candidate.Contains('/') || candidate.Contains(':'))
            throw new ArgumentException("Invalid domain", nameof(value));
        var labels = candidate.Split('.');
        if (labels.Any(label => label.Length is 0 or > 63)) throw new ArgumentException("Invalid domain", nameof(value));
        return string.Join('.', labels.Select(label => Idn.GetAscii(label))).ToLowerInvariant();
    }

    public static IEnumerable<string> Suffixes(string domain)
    {
        var current = Normalize(domain);
        while (true)
        {
            yield return current;
            var dot = current.IndexOf('.');
            if (dot < 0) yield break;
            current = current[(dot + 1)..];
        }
    }
}
