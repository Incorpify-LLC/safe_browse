using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;
using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed class ProtectionWorker(AgentState state, PolicyStore policies, ListArtifactStore artifacts, CredentialStore credentials, EventQueue events, AccessRequestQueue accessRequests, IHttpClientFactory clients, IOptions<AgentOptions> options, ILogger<ProtectionWorker> logger, ILoggerFactory loggerFactory) : BackgroundService
{
    private readonly AgentOptions _options = options.Value;
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var cached = policies.Load(); if (cached is not null) state.Update(cached, policies.LoadLists());
        var dnsTask = RunDns(stoppingToken);
        var syncTask = RunSync(stoppingToken);
        await Task.WhenAll(dnsTask, syncTask);
    }

    private async Task RunDns(CancellationToken token)
    {
        var proxy = new DnsProxy(state, events, clients, loggerFactory.CreateLogger<DnsProxy>());
        await proxy.RunAsync(token);
    }

    private async Task RunSync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(60));
        do { await SyncOnce(token); } while (await timer.WaitForNextTickAsync(token));
    }

    private async Task SyncOnce(CancellationToken token)
    {
        var credential = credentials.Read(); if (credential is null) { logger.LogWarning("Device is not enrolled"); return; }
        var client = clients.CreateClient("api"); client.DefaultRequestHeaders.Authorization = new("Bearer", credential);
        try
        {
            var current = state.Policy;
            using var sync = await client.GetAsync($"sync?policyVersion={current?.Version ?? -1}&listVersion={Uri.EscapeDataString(current?.ListVersion ?? "")}", token);
            if (sync.IsSuccessStatusCode)
            {
                var envelope = await sync.Content.ReadFromJsonAsync<PolicyEnvelope>(cancellationToken: token);
                if (envelope?.Policy is not null)
                {
                    if (envelope.Policy.ListVersion != "bootstrap") await artifacts.SyncAsync(client, envelope.Policy.ListVersion, token);
                    policies.Save(envelope.Policy); state.Update(envelope.Policy, policies.LoadLists());
                }
            }
            await UploadEvents(client, token);
            await UploadAccessRequests(client, token);
            var policy = state.Policy;
            await client.PostAsJsonAsync("heartbeat", new { agentVersion = _options.AgentVersion, policyVersion = policy?.Version ?? 0, listVersion = policy?.ListVersion ?? "", status = "healthy", detail = (string?)null }, token);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException) { logger.LogWarning(exception, "Cloud sync failed; cached protection remains active"); }
    }
    private async Task UploadAccessRequests(HttpClient client, CancellationToken token)
    {
        while (accessRequests.Peek() is { } item)
        {
            using var response = await client.PostAsJsonAsync("access-requests", new { domain = item.Domain, category = item.Category, reason = item.Reason }, token);
            if (!response.IsSuccessStatusCode) return;
            accessRequests.Remove();
        }
    }
    private async Task UploadEvents(HttpClient client, CancellationToken token)
    {
        var batch = events.Peek(100); if (batch.Length == 0) return;
        using var request = new HttpRequestMessage(HttpMethod.Post, "events") { Content = JsonContent.Create(new { events = batch }) };
        request.Headers.Add("Idempotency-Key", Guid.NewGuid().ToString());
        using var response = await client.SendAsync(request, token); if (response.IsSuccessStatusCode) events.Remove(batch.Length);
    }
    private sealed record PolicyEnvelope(Policy Policy);
}
