using System.Text.Json.Serialization;

namespace SafeBrowse.Core;

[JsonConverter(typeof(JsonStringEnumConverter<Category>))]
public enum Category { Threats, Adult, Gambling, Drugs, Piracy, Bypass, Anime, Social, Gaming, Streaming }

public sealed record CategorySchedule(
    [property: JsonPropertyName("category")] Category Category,
    [property: JsonPropertyName("days")] int[] Days,
    [property: JsonPropertyName("startMinutes")] int StartMinutes,
    [property: JsonPropertyName("endMinutes")] int EndMinutes);

public sealed record DomainRule(
    [property: JsonPropertyName("domain")] string Domain,
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("expiresAt")] DateTimeOffset? ExpiresAt);

public sealed record Policy(
    [property: JsonPropertyName("version")] long Version = 1,
    [property: JsonPropertyName("childId")] Guid ChildId = default,
    [property: JsonPropertyName("ageBand")] string AgeBand = "age_10_12",
    [property: JsonPropertyName("timezone")] string Timezone = "UTC",
    [property: JsonPropertyName("blockedCategories")] Category[]? EnabledCategories = null,
    [property: JsonPropertyName("schedule")] CategorySchedule[]? Schedules = null,
    [property: JsonPropertyName("rules")] DomainRule[]? DomainRules = null,
    [property: JsonPropertyName("safeSearch")] bool SafeSearch = false,
    [property: JsonPropertyName("youtubeRestricted")] bool YoutubeRestricted = false,
    [property: JsonPropertyName("paused")] bool Paused = false,
    [property: JsonPropertyName("listVersion")] string ListVersion = "",
    [property: JsonPropertyName("updatedAt")] DateTimeOffset GeneratedAt = default);

public sealed record FilterDecision(bool Blocked, string Domain, Category? Category, string Reason)
{
    public static FilterDecision Allow(string domain, string reason = "allowed") => new(false, domain, null, reason);
    public static FilterDecision Block(string domain, Category? category, string reason) => new(true, domain, category, reason);
}
