using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Net.Http.Headers;
using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed class DnsProxy(AgentState state, EventQueue events, IHttpClientFactory clients, ILogger<DnsProxy> logger)
{
    private static readonly TimeSpan UpstreamTimeout = TimeSpan.FromSeconds(3);
    private static readonly IPEndPoint FallbackDns = new(IPAddress.Parse("1.1.1.1"), 53);

    public async Task RunAsync(CancellationToken cancellationToken)
    {
        using var udp4 = new UdpClient(new IPEndPoint(IPAddress.Loopback, 53));
        using var udp6 = new UdpClient(new IPEndPoint(IPAddress.IPv6Loopback, 53));
        var tcp4 = new TcpListener(IPAddress.Loopback, 53);
        var tcp6 = new TcpListener(IPAddress.IPv6Loopback, 53);
        tcp4.Start();
        tcp6.Start();

        await using var reg = cancellationToken.Register(() =>
        {
            try { udp4.Dispose(); } catch { /* ignore */ }
            try { udp6.Dispose(); } catch { /* ignore */ }
            try { tcp4.Stop(); } catch { /* ignore */ }
            try { tcp6.Stop(); } catch { /* ignore */ }
        });

        try
        {
            await Task.WhenAll(
                RunUdp(udp4, cancellationToken),
                RunUdp(udp6, cancellationToken),
                RunTcp(tcp4, cancellationToken),
                RunTcp(tcp6, cancellationToken));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (SocketException) when (cancellationToken.IsCancellationRequested)
        {
        }
        finally
        {
            try { tcp4.Stop(); } catch { /* ignore */ }
            try { tcp6.Stop(); } catch { /* ignore */ }
        }
    }

    private async Task RunUdp(UdpClient udp, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var request = await udp.ReceiveAsync(token);
                _ = HandleUdp(udp, request, token).ContinueWith(
                    task => logger.LogError(task.Exception, "DNS UDP request failed"),
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted,
                    TaskScheduler.Default);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (ObjectDisposedException) when (token.IsCancellationRequested) { break; }
            catch (SocketException) when (token.IsCancellationRequested) { break; }
        }
    }

    private async Task HandleUdp(UdpClient udp, UdpReceiveResult request, CancellationToken token)
    {
        var response = await Resolve(request.Buffer, token);
        await udp.SendAsync(response, request.RemoteEndPoint, token);
    }

    private async Task RunTcp(TcpListener listener, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            try
            {
                var client = await listener.AcceptTcpClientAsync(token);
                _ = HandleTcp(client, token).ContinueWith(
                    task => logger.LogError(task.Exception, "DNS TCP request failed"),
                    CancellationToken.None,
                    TaskContinuationOptions.OnlyOnFaulted,
                    TaskScheduler.Default);
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested) { break; }
            catch (ObjectDisposedException) when (token.IsCancellationRequested) { break; }
            catch (SocketException) when (token.IsCancellationRequested) { break; }
        }
    }

    private async Task HandleTcp(TcpClient client, CancellationToken token)
    {
        await using var stream = client.GetStream();
        using (client)
        {
            var lengthBytes = new byte[2];
            await stream.ReadExactlyAsync(lengthBytes, token);
            var query = new byte[BinaryPrimitives.ReadUInt16BigEndian(lengthBytes)];
            await stream.ReadExactlyAsync(query, token);
            var response = await Resolve(query, token);
            BinaryPrimitives.WriteUInt16BigEndian(lengthBytes, checked((ushort)response.Length));
            await stream.WriteAsync(lengthBytes, token);
            await stream.WriteAsync(response, token);
        }
    }

    private async Task<byte[]> Resolve(byte[] query, CancellationToken token)
    {
        string domain;
        try
        {
            domain = DnsMessage.ReadQuestionName(query);
        }
        catch (Exception ex)
        {
            logger.LogDebug(ex, "Ignoring invalid DNS packet");
            return DnsMessage.CreateBlockedResponse(query);
        }

        FilterDecision decision;
        try
        {
            decision = state.Evaluate(domain);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Policy evaluation failed for {Domain}", domain);
            return DnsMessage.CreateBlockedResponse(query);
        }

        if (decision.Blocked)
        {
            events.Blocked(decision);
            return DnsMessage.CreateBlockedResponse(query);
        }

        try
        {
            using var dohCts = CancellationTokenSource.CreateLinkedTokenSource(token);
            dohCts.CancelAfter(UpstreamTimeout);
            using var client = clients.CreateClient("doh");
            using var request = new HttpRequestMessage(HttpMethod.Post, "")
            {
                Content = new ByteArrayContent(query)
            };
            request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/dns-message");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/dns-message"));
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, dohCts.Token);
            if (response.IsSuccessStatusCode)
            {
                return await response.Content.ReadAsByteArrayAsync(dohCts.Token);
            }

            logger.LogWarning("DoH returned {Status} for {Domain}", response.StatusCode, domain);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "DoH request failed for {Domain}, attempting UDP DNS fallback", domain);
        }

        try
        {
            using var udpCts = CancellationTokenSource.CreateLinkedTokenSource(token);
            udpCts.CancelAfter(UpstreamTimeout);
            return await ForwardUdp(query, udpCts.Token);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "UDP DNS fallback failed for {Domain}", domain);
            return DnsMessage.CreateBlockedResponse(query);
        }
    }

    private static async Task<byte[]> ForwardUdp(byte[] query, CancellationToken token)
    {
        using var client = new UdpClient();
        await client.SendAsync(query, FallbackDns, token);
        var result = await client.ReceiveAsync(token);
        return result.Buffer;
    }
}
