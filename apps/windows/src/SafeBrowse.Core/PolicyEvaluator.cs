namespace SafeBrowse.Core;

public sealed class PolicyEvaluator
{
    private readonly Policy _policy;
    private readonly IReadOnlyDictionary<Category, HashSet<string>> _lists;
    private readonly TimeZoneInfo _timeZone;

    public PolicyEvaluator(Policy policy, IReadOnlyDictionary<Category, HashSet<string>> lists)
    {
        _policy = policy;
        _lists = lists;
        try
        {
            _timeZone = TimeZoneInfo.FindSystemTimeZoneById(string.IsNullOrWhiteSpace(policy.Timezone) ? "UTC" : policy.Timezone);
        }
        catch
        {
            _timeZone = TimeZoneInfo.Utc;
        }
    }

    public FilterDecision Evaluate(string input, DateTimeOffset now)
    {
        var domain = DomainNormalizer.Normalize(input);
        if (_policy.Paused) return FilterDecision.Block(domain, null, "internet_paused");

        var rules = _policy.DomainRules ?? Array.Empty<DomainRule>();
        var matchingRule = rules
            .Where(rule => rule != null && !string.IsNullOrWhiteSpace(rule.Domain) && (rule.ExpiresAt is null || rule.ExpiresAt > now))
            .FirstOrDefault(rule => DomainNormalizer.Suffixes(domain).Contains(DomainNormalizer.Normalize(rule.Domain)));
        if (matchingRule is not null)
            return string.Equals(matchingRule.Action, "allow", StringComparison.OrdinalIgnoreCase)
                ? FilterDecision.Allow(domain, "custom_allow")
                : FilterDecision.Block(domain, null, "custom_block");

        var categories = _policy.EnabledCategories ?? Array.Empty<Category>();
        foreach (var category in categories)
        {
            if (!_lists.TryGetValue(category, out var entries) || entries is null) continue;
            if (!DomainNormalizer.Suffixes(domain).Any(entries.Contains)) continue;
            if (IsInsideAllowedWindow(category, now)) continue;
            return FilterDecision.Block(domain, category, "category");
        }
        return FilterDecision.Allow(domain);
    }

    private bool IsInsideAllowedWindow(Category category, DateTimeOffset now)
    {
        var schedules = (_policy.Schedules ?? Array.Empty<CategorySchedule>())
            .Where(schedule => schedule != null && schedule.Category == category && schedule.Days != null)
            .ToArray();
        if (schedules.Length == 0) return false;
        var local = TimeZoneInfo.ConvertTime(now, _timeZone);
        var day = (int)local.DayOfWeek;
        var minutes = local.Hour * 60 + local.Minute;
        return schedules.Any(schedule => schedule.Days != null && schedule.Days.Contains(day) && minutes >= schedule.StartMinutes && minutes < schedule.EndMinutes);
    }
}
