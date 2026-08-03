using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Net.Http.Headers;
using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed class DnsProxy(AgentState state, EventQueue events, IHttpClientFactory clients, ILogger<DnsProxy> logger)
{
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        var udp4 = new UdpClient(new IPEndPoint(IPAddress.Loopback, 53));
        var udp6 = new UdpClient(new IPEndPoint(IPAddress.IPv6Loopback, 53));
        var tcp4 = new TcpListener(IPAddress.Loopback, 53); var tcp6 = new TcpListener(IPAddress.IPv6Loopback, 53);
        tcp4.Start(); tcp6.Start();
        try { await Task.WhenAll(RunUdp(udp4, cancellationToken), RunUdp(udp6, cancellationToken), RunTcp(tcp4, cancellationToken), RunTcp(tcp6, cancellationToken)); }
        finally { udp4.Dispose(); udp6.Dispose(); tcp4.Stop(); tcp6.Stop(); }
    }

    private async Task RunUdp(UdpClient udp, CancellationToken token)
    {
        while (!token.IsCancellationRequested)
        {
            var request = await udp.ReceiveAsync(token);
            _ = HandleUdp(udp, request, token).ContinueWith(task => logger.LogError(task.Exception, "DNS UDP request failed"), TaskContinuationOptions.OnlyOnFaulted);
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
            var client = await listener.AcceptTcpClientAsync(token);
            _ = HandleTcp(client, token).ContinueWith(task => logger.LogError(task.Exception, "DNS TCP request failed"), TaskContinuationOptions.OnlyOnFaulted);
        }
    }
    private async Task HandleTcp(TcpClient client, CancellationToken token)
    {
        await using var stream = client.GetStream(); using (client)
        {
            var lengthBytes = new byte[2]; await stream.ReadExactlyAsync(lengthBytes, token);
            var query = new byte[BinaryPrimitives.ReadUInt16BigEndian(lengthBytes)]; await stream.ReadExactlyAsync(query, token);
            var response = await Resolve(query, token); BinaryPrimitives.WriteUInt16BigEndian(lengthBytes, checked((ushort)response.Length));
            await stream.WriteAsync(lengthBytes, token); await stream.WriteAsync(response, token);
        }
    }
    private async Task<byte[]> Resolve(byte[] query, CancellationToken token)
    {
        var domain = DnsMessage.ReadQuestionName(query); var decision = state.Evaluate(domain);
        if (decision.Blocked) { events.Blocked(decision); return DnsMessage.CreateBlockedResponse(query); }
        using var request = new HttpRequestMessage(HttpMethod.Post, "") { Content = new ByteArrayContent(query) };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/dns-message"); request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/dns-message"));
        using var response = await clients.CreateClient("doh").SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
        response.EnsureSuccessStatusCode(); return await response.Content.ReadAsByteArrayAsync(token);
    }
}
