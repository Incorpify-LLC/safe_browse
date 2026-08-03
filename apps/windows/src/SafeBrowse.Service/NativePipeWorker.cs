using System.IO.Pipes;
using System.Text.Json;
using System.Security.Principal;
using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed class NativePipeWorker(AgentState state, EventQueue events, AccessRequestQueue requests, ILogger<NativePipeWorker> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream("safe-browse-native", PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(stoppingToken);
                using var reader = new StreamReader(pipe, System.Text.Encoding.UTF8, true, 1024, leaveOpen: true);
                await using var writer = new StreamWriter(pipe, System.Text.Encoding.UTF8, 1024, leaveOpen: true) { AutoFlush = true };
                var line = await reader.ReadLineAsync(stoppingToken); if (line is null) continue;
                var message = JsonSerializer.Deserialize<NativeRequest>(line, Json); if (message is null) continue;
                if (message.Action == "emergency")
                {
                    var isAdministrator = false;
                    pipe.RunAsClient(() => isAdministrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator));
                    if (!isAdministrator) { await writer.WriteLineAsync("{\"error\":\"administrator_required\"}"); continue; }
                    var until = state.BeginEmergencyBypass();
                    events.Add(new(Guid.NewGuid(), DateTimeOffset.UtcNow, "emergency_bypass", null, null, null, $"until:{until:O}"));
                    await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, until }, Json)); continue;
                }
                var domain = DomainNormalizer.Normalize(message.Domain);
                if (message.Action == "request")
                {
                    var request = requests.Add(domain, message.Category, message.Reason);
                    await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, requestId = request.LocalId }, Json)); continue;
                }
                if (message.Action == "navigation") events.Navigation(domain, message.Browser ?? "other");
                var decision = message.Action == "recent" ? state.Recent(domain) ?? FilterDecision.Allow(domain) : state.Evaluate(domain);
                await writer.WriteLineAsync(JsonSerializer.Serialize(decision, Json));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
            catch (Exception exception) { logger.LogWarning(exception, "Native messaging request failed"); }
        }
    }
    private sealed record NativeRequest(string Action, string Domain = "", string? Browser = null, string? Category = null, string? Reason = null);
}
