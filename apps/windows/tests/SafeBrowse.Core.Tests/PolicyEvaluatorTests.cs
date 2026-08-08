using SafeBrowse.Core;
using Xunit;

namespace SafeBrowse.Core.Tests;

public sealed class PolicyEvaluatorTests
{
    private static Policy Policy(DomainRule[]? rules = null, bool paused = false) => new(1, Guid.NewGuid(), "age_10_12", "UTC", [Category.Anime], [], rules ?? [], true, true, paused, "test", DateTimeOffset.UtcNow);

    [Fact]
    public void BlocksSubdomainsAndHonorsExplicitAllow()
    {
        var lists = new Dictionary<Category, HashSet<string>> { [Category.Anime] = new(["anime.example"]) };
        Assert.True(new PolicyEvaluator(Policy(), lists).Evaluate("www.anime.example", DateTimeOffset.UtcNow).Blocked);
        var allowed = Policy([new DomainRule("anime.example", "allow", null)]);
        Assert.False(new PolicyEvaluator(allowed, lists).Evaluate("www.anime.example", DateTimeOffset.UtcNow).Blocked);
    }

    [Fact]
    public void PauseOverridesAllowRules()
    {
        var policy = Policy([new DomainRule("example.com", "allow", null)], true);
        Assert.Equal("internet_paused", new PolicyEvaluator(policy, new Dictionary<Category, HashSet<string>>()).Evaluate("example.com", DateTimeOffset.UtcNow).Reason);
    }

    [Fact]
    public void CreatesAnNxdomainResponse()
    {
        byte[] query = [0x12,0x34,0x01,0x00,0x00,0x01,0,0,0,0,0,0,7,(byte)'e',(byte)'x',(byte)'a',(byte)'m',(byte)'p',(byte)'l',(byte)'e',3,(byte)'c',(byte)'o',(byte)'m',0,0,1,0,1];
        Assert.Equal("example.com", DnsMessage.ReadQuestionName(query));
        var response = DnsMessage.CreateBlockedResponse(query);
        Assert.Equal(0x12, response[0]); Assert.Equal(3, response[3] & 0x0f);
        Assert.NotEqual(0, response[2] & 0x80); // QR bit
        Assert.NotEqual(0, response[3] & 0x80); // RA bit
    }

    [Fact]
    public void NullRulesAndCategoriesDoNotThrow()
    {
        var policy = new Policy(
            Version: 1,
            ChildId: Guid.NewGuid(),
            AgeBand: "age_10_12",
            Timezone: "UTC",
            EnabledCategories: null,
            Schedules: null,
            DomainRules: null,
            SafeSearch: false,
            YoutubeRestricted: false,
            Paused: false,
            ListVersion: "test",
            GeneratedAt: DateTimeOffset.UtcNow);
        var decision = new PolicyEvaluator(policy, new Dictionary<Category, HashSet<string>>()).Evaluate("example.com", DateTimeOffset.UtcNow);
        Assert.False(decision.Blocked);
        Assert.Equal("allowed", decision.Reason);
    }

    [Fact]
    public void CustomBlockRulesWork()
    {
        var policy = Policy([new DomainRule("blocked-test-domain.com", "block", null)]);
        var decision = new PolicyEvaluator(policy, new Dictionary<Category, HashSet<string>>()).Evaluate("blocked-test-domain.com", DateTimeOffset.UtcNow);
        Assert.True(decision.Blocked);
        Assert.Equal("custom_block", decision.Reason);
    }

    [Fact]
    public void InvalidTimezoneFallbackDoesNotThrow()
    {
        var policy = new Policy(1, Guid.NewGuid(), "age_10_12", "Invalid/Timezone_Name_That_DoesNotExist_12345", [Category.Anime], [], [], false, false, false, "test", DateTimeOffset.UtcNow);
        var evaluator = new PolicyEvaluator(policy, new Dictionary<Category, HashSet<string>>());
        var decision = evaluator.Evaluate("example.com", DateTimeOffset.UtcNow);
        Assert.False(decision.Blocked);
    }

    [Fact]
    public void DomainNormalizerThrowsOnInvalidDomain()
    {
        Assert.Throws<ArgumentException>(() => DomainNormalizer.Normalize("invalid domain with spaces"));
        Assert.Throws<ArgumentException>(() => DomainNormalizer.Normalize("http://example.com"));
        Assert.Equal("example.com", DomainNormalizer.Normalize("EXAMPLE.COM."));
    }
}
