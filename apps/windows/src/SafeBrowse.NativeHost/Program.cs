using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text.Json;

var input = Console.OpenStandardInput(); var output = Console.OpenStandardOutput();
while (true)
{
    var header = new byte[4]; var read = await input.ReadAsync(header);
    if (read == 0) break;
    while (read < 4) { var next = await input.ReadAsync(header.AsMemory(read)); if (next == 0) return; read += next; }
    var length = BinaryPrimitives.ReadInt32LittleEndian(header);
    if (length is <= 0 or > 1_048_576) return;
    var payload = new byte[length]; await input.ReadExactlyAsync(payload);
    string response;
    try
    {
        await using var pipe = new NamedPipeClientStream(".", "safe-browse-native", PipeDirection.InOut, PipeOptions.Asynchronous);
        await pipe.ConnectAsync(2_000);
        await pipe.WriteAsync(payload); await pipe.WriteAsync("\n"u8.ToArray()); await pipe.FlushAsync();
        using var reader = new StreamReader(pipe); response = await reader.ReadLineAsync() ?? "{\"error\":\"empty_response\"}";
    }
    catch (Exception error) { response = JsonSerializer.Serialize(new { error = "agent_unavailable", detail = error.Message }); }
    var bytes = System.Text.Encoding.UTF8.GetBytes(response); BinaryPrimitives.WriteInt32LittleEndian(header, bytes.Length);
    await output.WriteAsync(header); await output.WriteAsync(bytes); await output.FlushAsync();
}
