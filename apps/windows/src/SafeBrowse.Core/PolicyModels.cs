using System.Text.Json;
using System.Text.Json.Serialization;

namespace SafeBrowse.Core;

/// <summary>
/// Category names on the wire match @safe-browse/contracts (lowercase).
/// Converter accepts camelCase and PascalCase for backward compatibility.
/// </summary>
[JsonConverter(typeof(CategoryJsonConverter))]
public enum Category { Threats, Adult, Gambling, Drugs, Piracy, Bypass, Anime, Social, Gaming, Streaming }

public sealed class CategoryJsonConverter : JsonConverter<Category>
{
    public override Category Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        var raw = reader.GetString() ?? throw new JsonException("Category expected string");
        if (Enum.TryParse<Category>(raw, ignoreCase: true, out var value)) return value;
        throw new JsonException($"Unknown category: {raw}");
    }

    public override void Write(Utf8JsonWriter writer, Category value, JsonSerializerOptions options)
        => writer.WriteStringValue(value.ToString().ToLowerInvariant());
}

public sealed record CategorySchedule(
    [property: JsonPropertyName("category")] Category Category,
    [property: JsonPropertyName("days")] int[] Days,
    [property: JsonPropertyName("startMinutes")] int StartMinutes,
    [property: JsonPropertyName("endMinutes")] int EndMinutes);

public sealed record DomainRule(
    [property: JsonPropertyName("domain")] string Domain,
    [property: JsonPropertyName("action")] string Action,
    [property: JsonPropertyName("expiresAt")] DateTimeOffset? ExpiresAt);

/// <summary>
/// Wire format matches packages/contracts policySchema.
/// Legacy property names (blockedCategories, schedule, rules, updatedAt) are still accepted on read.
/// </summary>
public sealed class Policy
{
    [JsonPropertyName("version")]
    public long Version { get; set; } = 1;

    [JsonPropertyName("childId")]
    public Guid ChildId { get; set; }

    [JsonPropertyName("ageBand")]
    public string AgeBand { get; set; } = "age_10_12";

    [JsonPropertyName("timezone")]
    public string Timezone { get; set; } = "UTC";

    [JsonPropertyName("enabledCategories")]
    public Category[]? EnabledCategories { get; set; }

    /// <summary>Legacy alias used by early local fixtures / older agents.</summary>
    [JsonPropertyName("blockedCategories")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public Category[]? BlockedCategoriesLegacy
    {
        get => null;
        set { if (value is not null && EnabledCategories is null) EnabledCategories = value; }
    }

    [JsonPropertyName("schedules")]
    public CategorySchedule[]? Schedules { get; set; }

    [JsonPropertyName("schedule")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public CategorySchedule[]? ScheduleLegacy
    {
        get => null;
        set { if (value is not null && Schedules is null) Schedules = value; }
    }

    [JsonPropertyName("domainRules")]
    public DomainRule[]? DomainRules { get; set; }

    [JsonPropertyName("rules")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public DomainRule[]? RulesLegacy
    {
        get => null;
        set { if (value is not null && DomainRules is null) DomainRules = value; }
    }

    [JsonPropertyName("safeSearch")]
    public bool SafeSearch { get; set; }

    [JsonPropertyName("youtubeRestricted")]
    public bool YoutubeRestricted { get; set; }

    [JsonPropertyName("paused")]
    public bool Paused { get; set; }

    [JsonPropertyName("listVersion")]
    public string ListVersion { get; set; } = "";

    [JsonPropertyName("generatedAt")]
    public DateTimeOffset GeneratedAt { get; set; }

    [JsonPropertyName("updatedAt")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public DateTimeOffset? UpdatedAtLegacy
    {
        get => null;
        set { if (value is not null && GeneratedAt == default) GeneratedAt = value.Value; }
    }

    public Policy() { }

    public Policy(
        long Version,
        Guid ChildId,
        string AgeBand,
        string Timezone,
        Category[]? EnabledCategories,
        CategorySchedule[]? Schedules,
        DomainRule[]? DomainRules,
        bool SafeSearch,
        bool YoutubeRestricted,
        bool Paused,
        string ListVersion,
        DateTimeOffset GeneratedAt)
    {
        this.Version = Version;
        this.ChildId = ChildId;
        this.AgeBand = AgeBand;
        this.Timezone = Timezone;
        this.EnabledCategories = EnabledCategories;
        this.Schedules = Schedules;
        this.DomainRules = DomainRules;
        this.SafeSearch = SafeSearch;
        this.YoutubeRestricted = YoutubeRestricted;
        this.Paused = Paused;
        this.ListVersion = ListVersion;
        this.GeneratedAt = GeneratedAt;
    }

    // Positional deconstruction helpers for existing call sites using record-style construction
    public void Deconstruct(
        out long version, out Guid childId, out string ageBand, out string timezone,
        out Category[]? enabledCategories, out CategorySchedule[]? schedules, out DomainRule[]? domainRules,
        out bool safeSearch, out bool youtubeRestricted, out bool paused, out string listVersion, out DateTimeOffset generatedAt)
    {
        version = Version; childId = ChildId; ageBand = AgeBand; timezone = Timezone;
        enabledCategories = EnabledCategories; schedules = Schedules; domainRules = DomainRules;
        safeSearch = SafeSearch; youtubeRestricted = YoutubeRestricted; paused = Paused;
        listVersion = ListVersion; generatedAt = GeneratedAt;
    }
}

public sealed record FilterDecision(bool Blocked, string Domain, Category? Category, string Reason)
{
    public static FilterDecision Allow(string domain, string reason = "allowed") => new(false, domain, null, reason);
    public static FilterDecision Block(string domain, Category? category, string reason) => new(true, domain, category, reason);
}
