using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed class NativePipeWorker(AgentState state, EventQueue events, AccessRequestQueue requests, ILogger<NativePipeWorker> logger) : BackgroundService
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private static NamedPipeServerStream CreateServerPipe()
    {
        if (OperatingSystem.IsWindows())
        {
            var pipeSecurity = new PipeSecurity();
            pipeSecurity.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null), PipeAccessRights.ReadWrite, AccessControlType.Allow));
            pipeSecurity.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
            pipeSecurity.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));

            return NamedPipeServerStreamAcl.Create(
                "safe-browse-native",
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                inBufferSize: 1024,
                outBufferSize: 1024,
                pipeSecurity);
        }

        return new NamedPipeServerStream("safe-browse-native", PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var pipe = CreateServerPipe();
                using var cancelReg = stoppingToken.Register(() => { try { pipe.Dispose(); } catch { /* ignore */ } });
                await pipe.WaitForConnectionAsync(stoppingToken);
                using var reader = new StreamReader(pipe, System.Text.Encoding.UTF8, true, 1024, leaveOpen: true);
                await using var writer = new StreamWriter(pipe, System.Text.Encoding.UTF8, 1024, leaveOpen: true) { AutoFlush = true };
                var line = await reader.ReadLineAsync(stoppingToken); if (line is null) continue;
                var message = JsonSerializer.Deserialize<NativeRequest>(line, Json); if (message is null) continue;
                if (message.Action == "emergency")
                {
                    var isAdministrator = false;
                    if (OperatingSystem.IsWindows())
                    {
                        try
                        {
                            pipe.RunAsClient(() => isAdministrator = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator));
                        }
                        catch (Exception ex)
                        {
                            logger.LogWarning(ex, "Could not impersonate pipe client for administrator check");
                            isAdministrator = false;
                        }
                    }
                    else
                    {
                        isAdministrator = true;
                    }
                    if (!isAdministrator) { await writer.WriteLineAsync("{\"error\":\"administrator_required\"}"); continue; }
                    var until = state.BeginEmergencyBypass();
                    events.Add(new(Guid.NewGuid(), DateTimeOffset.UtcNow, "emergency_bypass", null, null, null, $"until:{until:O}"));
                    await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, until }, Json)); continue;
                }
                string domain;
                try
                {
                    domain = DomainNormalizer.Normalize(message.Domain ?? "");
                }
                catch (ArgumentException)
                {
                    await writer.WriteLineAsync("{\"error\":\"invalid_domain\"}");
                    continue;
                }
                if (message.Action == "request")
                {
                    var request = requests.Add(domain, message.Category, message.Reason);
                    await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok = true, requestId = request.LocalId }, Json)); continue;
                }
                if (message.Action == "navigation") events.Navigation(domain, message.Browser ?? "other");
                var decision = message.Action == "recent" ? state.Recent(domain) ?? FilterDecision.Allow(domain) : state.Evaluate(domain);
                await writer.WriteLineAsync(JsonSerializer.Serialize(decision, Json));
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (ObjectDisposedException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception exception) { logger.LogWarning(exception, "Native messaging request failed"); }
        }
    }
    private sealed record NativeRequest(string Action, string Domain = "", string? Browser = null, string? Category = null, string? Reason = null);
}
