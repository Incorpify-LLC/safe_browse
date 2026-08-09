using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Usage:
//   SafeBrowse.Enroll.exe <enrollmentCode>
//   SafeBrowse.Enroll.exe <apiBaseUrl> <enrollmentCode> [deviceName]
// Default API is Incorpify SaaS production.

const string DefaultApiBase = "https://safebrowse.incorpify.in/api/v1/device/";

if (args.Length < 1)
{
    Console.Error.WriteLine("Usage: SafeBrowse.Enroll.exe <code>");
    Console.Error.WriteLine("   or: SafeBrowse.Enroll.exe <apiBaseUrl> <code> [deviceName]");
    return 1;
}

string baseUrl;
string code;
string name;
if (args.Length == 1 || !args[0].Contains("://", StringComparison.Ordinal))
{
    baseUrl = DefaultApiBase.TrimEnd('/');
    code = args[0];
    name = args.Length > 1 ? args[1] : Environment.MachineName;
}
else
{
    baseUrl = args[0].TrimEnd('/');
    code = args[1];
    name = args.Length > 2 ? args[2] : Environment.MachineName;
}

if (baseUrl.EndsWith("/api/v1/device/enroll", StringComparison.OrdinalIgnoreCase)) { /* full endpoint */ }
else if (baseUrl.EndsWith("/api/v1/device", StringComparison.OrdinalIgnoreCase)) { baseUrl += "/enroll"; }
else { baseUrl += "/api/v1/device/enroll"; }

using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
using var response = await client.PostAsJsonAsync(baseUrl, new { code, deviceName = name, platform = "windows", agentVersion = "0.1.0" });
if (!response.IsSuccessStatusCode)
{
    Console.Error.WriteLine(await response.Content.ReadAsStringAsync());
    return 1;
}

var result = await response.Content.ReadFromJsonAsync<Enrollment>();
if (result is null) return 1;

var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SafeBrowse");
Directory.CreateDirectory(directory);
var protectedToken = ProtectedData.Protect(Encoding.UTF8.GetBytes(result.Token), null, DataProtectionScope.LocalMachine);
await File.WriteAllBytesAsync(Path.Combine(directory, "device.credential"), protectedToken);
await File.WriteAllTextAsync(
    Path.Combine(directory, "policy.json"),
    JsonSerializer.Serialize(result.Policy, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));

Console.WriteLine($"Enrolled device {result.DeviceId}. Restart the Safe Browse service.");
return 0;

internal sealed record Enrollment(Guid DeviceId, string Token, JsonElement Policy);
