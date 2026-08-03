using System.Security.Cryptography;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace SafeBrowse.Service;

public sealed class ListArtifactStore(IOptions<AgentOptions> options, ILogger<ListArtifactStore> logger)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly AgentOptions _options = options.Value;

    public async Task SyncAsync(HttpClient client, string expectedVersion, CancellationToken token)
    {
        var versionFile = Path.Combine(_options.DataDirectory, "lists", ".version");
        if (File.Exists(versionFile) && await File.ReadAllTextAsync(versionFile, token) == expectedVersion) return;
        var envelope = await client.GetFromJsonAsync<SignedEnvelope>("lists/manifest", Json, token) ?? throw new InvalidDataException("List manifest missing");
        if (envelope.Version != expectedVersion || envelope.Algorithm != "ES256") throw new InvalidDataException("Unexpected list manifest version or algorithm");
        var payload = Convert.FromBase64String(PadBase64(envelope.Payload.Replace('-', '+').Replace('_', '/')));
        var signature = Convert.FromBase64String(PadBase64(envelope.Signature.Replace('-', '+').Replace('_', '/')));
        using var key = ECDsa.Create(); key.ImportFromPem(await File.ReadAllTextAsync(_options.ManifestPublicKeyPath, token));
        if (!key.VerifyData(payload, signature, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)) throw new CryptographicException("List manifest signature is invalid");
        var manifest = JsonSerializer.Deserialize<Manifest>(payload, Json) ?? throw new InvalidDataException("List manifest payload invalid");
        if (manifest.Version != expectedVersion) throw new InvalidDataException("List payload version mismatch");
        var directory = Path.Combine(_options.DataDirectory, "lists"); Directory.CreateDirectory(directory);
        foreach (var artifact in manifest.Artifacts)
        {
            if (!artifact.Filename.EndsWith(".txt.gz", StringComparison.Ordinal) || artifact.Filename.Contains('/') || artifact.Filename.Contains('\\')) throw new InvalidDataException("Unsafe artifact filename");
            var bytes = await client.GetByteArrayAsync($"lists/{Uri.EscapeDataString(expectedVersion)}/{Uri.EscapeDataString(artifact.Filename)}", token);
            var hash = SHA256.HashData(bytes);
            if (!CryptographicOperations.FixedTimeEquals(hash, Convert.FromHexString(artifact.Sha256))) throw new CryptographicException($"Hash mismatch for {artifact.Filename}");
            var target = Path.Combine(directory, artifact.Filename); await File.WriteAllBytesAsync($"{target}.new", bytes, token); File.Move($"{target}.new", target, true);
        }
        await File.WriteAllTextAsync(versionFile, expectedVersion, token);
        logger.LogInformation("Installed signed blocklist version {Version}", expectedVersion);
    }

    private static string PadBase64(string value) => value.PadRight(value.Length + ((4 - value.Length % 4) % 4), '=');
    private sealed record SignedEnvelope(string Version, string Payload, string Signature, string Algorithm);
    private sealed record Manifest(string Version, Artifact[] Artifacts);
    private sealed record Artifact(string Category, string Filename, string Sha256, int Count);
}
