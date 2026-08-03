using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed class AgentState
{
    private readonly object _gate = new();
    private PolicyEvaluator? _evaluator;
    private Policy? _policy;
    private DateTimeOffset? _emergencyUntil;
    private readonly Dictionary<string, FilterDecision> _recent = new(StringComparer.OrdinalIgnoreCase);

    public Policy? Policy { get { lock (_gate) return _policy; } }
    public void Update(Policy policy, IReadOnlyDictionary<Category, HashSet<string>> lists)
    {
        lock (_gate) { _policy = policy; _evaluator = new PolicyEvaluator(policy, lists); }
    }
    public FilterDecision Evaluate(string domain)
    {
        lock (_gate)
        {
            if (_emergencyUntil > DateTimeOffset.UtcNow) return FilterDecision.Allow(domain, "emergency_bypass");
            var decision = _evaluator?.Evaluate(domain, DateTimeOffset.UtcNow) ?? FilterDecision.Block(domain, null, "policy_unavailable");
            _recent[domain] = decision;
            if (_recent.Count > 512) _recent.Remove(_recent.Keys.First());
            return decision;
        }
    }
    public FilterDecision? Recent(string domain) { lock (_gate) return _recent.GetValueOrDefault(domain); }
    public DateTimeOffset BeginEmergencyBypass() { lock (_gate) { _emergencyUntil = DateTimeOffset.UtcNow.AddMinutes(15); return _emergencyUntil.Value; } }
}
