using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace SafeBrowse.Service;

public sealed class CredentialStore
{
    private readonly string _path;
    public CredentialStore(IOptions<AgentOptions> options) { Directory.CreateDirectory(options.Value.DataDirectory); _path = Path.Combine(options.Value.DataDirectory, "device.credential"); }
    public string? Read()
    {
        if (!File.Exists(_path)) return null;
        var protectedBytes = File.ReadAllBytes(_path);
        return Encoding.UTF8.GetString(ProtectedData.Unprotect(protectedBytes, null, DataProtectionScope.LocalMachine));
    }
    public void Write(string token)
    {
        var protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), null, DataProtectionScope.LocalMachine);
        File.WriteAllBytes(_path, protectedBytes);
    }
}
