using System.IO.Compression;
using System.Text.Json;
using Microsoft.Extensions.Options;
using SafeBrowse.Core;

namespace SafeBrowse.Service;

public sealed class PolicyStore
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _directory;
    public PolicyStore(IOptions<AgentOptions> options) { _directory = options.Value.DataDirectory; Directory.CreateDirectory(_directory); }
    public void Save(Policy policy) => AtomicWrite(Path.Combine(_directory, "policy.json"), JsonSerializer.SerializeToUtf8Bytes(policy, Json));
    public Policy? Load() => File.Exists(Path.Combine(_directory, "policy.json")) ? JsonSerializer.Deserialize<Policy>(File.ReadAllBytes(Path.Combine(_directory, "policy.json")), Json) : null;
    public IReadOnlyDictionary<Category, HashSet<string>> LoadLists()
    {
        var output = new Dictionary<Category, HashSet<string>>();
        foreach (var category in Enum.GetValues<Category>())
        {
            var path = Path.Combine(_directory, "lists", $"{category.ToString().ToLowerInvariant()}.txt.gz");
            if (!File.Exists(path)) continue;
            using var stream = new GZipStream(File.OpenRead(path), CompressionMode.Decompress);
            using var reader = new StreamReader(stream);
            var entries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            while (reader.ReadLine() is { } line) if (line.Length > 0) entries.Add(line);
            output[category] = entries;
        }
        return output;
    }
    private static void AtomicWrite(string path, byte[] bytes) { var temp = $"{path}.new"; File.WriteAllBytes(temp, bytes); File.Move(temp, path, true); }
}
