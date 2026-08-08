using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var baseUrl = args[0].TrimEnd('/');
if (baseUrl.EndsWith("/api/v1/device/enroll", StringComparison.OrdinalIgnoreCase)) { /* full endpoint passed */ }
else if (baseUrl.EndsWith("/api/v1/device", StringComparison.OrdinalIgnoreCase)) { baseUrl += "/enroll"; }
else { baseUrl += "/api/v1/device/enroll"; }
var api = baseUrl;
var name = args.Length > 2 ? args[2] : Environment.MachineName;
using var client = new HttpClient();
using var response = await client.PostAsJsonAsync(api, new { code = args[1], deviceName = name, platform = "windows", agentVersion = "0.1.0" });
if (!response.IsSuccessStatusCode) { Console.Error.WriteLine(await response.Content.ReadAsStringAsync()); return 1; }
var result = await response.Content.ReadFromJsonAsync<Enrollment>();
if (result is null) return 1;
var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SafeBrowse"); Directory.CreateDirectory(directory);
var protectedToken = ProtectedData.Protect(Encoding.UTF8.GetBytes(result.Token), null, DataProtectionScope.LocalMachine);
await File.WriteAllBytesAsync(Path.Combine(directory, "device.credential"), protectedToken);
await File.WriteAllTextAsync(Path.Combine(directory, "policy.json"), JsonSerializer.Serialize(result.Policy, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
Console.WriteLine($"Enrolled device {result.DeviceId}. Restart the Safe Browse service."); return 0;
internal sealed record Enrollment(Guid DeviceId, string Token, JsonElement Policy);
