namespace SafeBrowse.Service;

public sealed class AgentOptions
{
    public required string ApiBaseUrl { get; init; }
    public required string UpstreamDohUrl { get; init; }
    public required string DataDirectory { get; init; }
    public required string ManifestPublicKeyPath { get; init; }
    public required string AgentVersion { get; init; }
}
