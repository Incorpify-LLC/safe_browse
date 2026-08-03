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
        _timeZone = TimeZoneInfo.FindSystemTimeZoneById(policy.Timezone);
    }

    public FilterDecision Evaluate(string input, DateTimeOffset now)
    {
        var domain = DomainNormalizer.Normalize(input);
        if (_policy.Paused) return FilterDecision.Block(domain, null, "internet_paused");

        var matchingRule = _policy.DomainRules
            .Where(rule => rule.ExpiresAt is null || rule.ExpiresAt > now)
            .FirstOrDefault(rule => DomainNormalizer.Suffixes(domain).Contains(DomainNormalizer.Normalize(rule.Domain)));
        if (matchingRule is not null)
            return matchingRule.Action.Equals("allow", StringComparison.OrdinalIgnoreCase)
                ? FilterDecision.Allow(domain, "custom_allow")
                : FilterDecision.Block(domain, null, "custom_block");

        foreach (var category in _policy.EnabledCategories)
        {
            if (!_lists.TryGetValue(category, out var entries)) continue;
            if (!DomainNormalizer.Suffixes(domain).Any(entries.Contains)) continue;
            if (IsInsideAllowedWindow(category, now)) continue;
            return FilterDecision.Block(domain, category, "category");
        }
        return FilterDecision.Allow(domain);
    }

    private bool IsInsideAllowedWindow(Category category, DateTimeOffset now)
    {
        var schedules = _policy.Schedules.Where(schedule => schedule.Category == category).ToArray();
        if (schedules.Length == 0) return false;
        var local = TimeZoneInfo.ConvertTime(now, _timeZone);
        var day = (int)local.DayOfWeek;
        var minutes = local.Hour * 60 + local.Minute;
        return schedules.Any(schedule => schedule.Days.Contains(day) && minutes >= schedule.StartMinutes && minutes < schedule.EndMinutes);
    }
}
