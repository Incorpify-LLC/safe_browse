using System.Collections.Concurrent;
using System.Text.Json;
using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed record AgentEvent(Guid Id, DateTimeOffset OccurredAt, string Kind, string? Domain, string? Category, string? Browser, string? Detail);

public sealed class EventQueue
{
    private readonly ConcurrentQueue<AgentEvent> _events = new();
    public void Navigation(string domain, string browser) => Add(new(Guid.NewGuid(), DateTimeOffset.UtcNow, "navigation", DomainNormalizer.Normalize(domain), null, browser, null));
    public void Blocked(FilterDecision decision) => Add(new(Guid.NewGuid(), DateTimeOffset.UtcNow, "blocked", decision.Domain, decision.Category?.ToString().ToLowerInvariant(), null, decision.Reason));
    public void Add(AgentEvent item) { _events.Enqueue(item); while (_events.Count > 50_000) _events.TryDequeue(out _); }
    public AgentEvent[] Peek(int count) => _events.Take(count).ToArray();
    public void Remove(int count) { for (var i = 0; i < count; i++) _events.TryDequeue(out _); }
}

public sealed record PendingAccessRequest(Guid LocalId, string Domain, string? Category, string? Reason);
public sealed class AccessRequestQueue
{
    private readonly ConcurrentQueue<PendingAccessRequest> _requests = new();
    public PendingAccessRequest Add(string domain, string? category, string? reason) { var item = new PendingAccessRequest(Guid.NewGuid(), DomainNormalizer.Normalize(domain), category, reason); _requests.Enqueue(item); return item; }
    public PendingAccessRequest? Peek() => _requests.TryPeek(out var item) ? item : null;
    public void Remove() => _requests.TryDequeue(out _);
}
