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
    }
}
