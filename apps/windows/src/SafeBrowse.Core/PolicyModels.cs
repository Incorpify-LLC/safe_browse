using System.Text.Json.Serialization;

namespace SafeBrowse.Core;

[JsonConverter(typeof(JsonStringEnumConverter<Category>))]
public enum Category { Threats, Adult, Gambling, Drugs, Piracy, Bypass, Anime, Social, Gaming, Streaming }

public sealed record CategorySchedule(Category Category, int[] Days, int StartMinutes, int EndMinutes);
public sealed record DomainRule(string Domain, string Action, DateTimeOffset? ExpiresAt);
public sealed record Policy(
    long Version,
    Guid ChildId,
    string AgeBand,
    string Timezone,
    Category[] EnabledCategories,
    CategorySchedule[] Schedules,
    DomainRule[] DomainRules,
    bool SafeSearch,
    bool YoutubeRestricted,
    bool Paused,
    string ListVersion,
    DateTimeOffset GeneratedAt);

public sealed record FilterDecision(bool Blocked, string Domain, Category? Category, string Reason)
{
    public static FilterDecision Allow(string domain, string reason = "allowed") => new(false, domain, null, reason);
    public static FilterDecision Block(string domain, Category? category, string reason) => new(true, domain, category, reason);
}
