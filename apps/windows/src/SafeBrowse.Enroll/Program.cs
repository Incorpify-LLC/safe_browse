using System.Net.Http.Json;
using System.Security.Cryptography;
using System.ServiceProcess;
using System.Text;
using System.Text.Json;

// Usage:
//   SafeBrowse.Enroll.exe                          → GUI (double-click after MSI install)
//   SafeBrowse.Enroll.exe <enrollmentCode>
//   SafeBrowse.Enroll.exe <apiBaseUrl> <enrollmentCode> [deviceName]
// Default API is Incorpify SaaS production, overridden by the installed
// appsettings.json when present so self-hosted deployments work unchanged.

if (args.Length == 0)
{
    ApplicationConfiguration.Initialize();
    Application.Run(new EnrollForm(Enroller.ResolveApiBase()));
    return Environment.ExitCode;
}

try
{
    var (baseUrl, code, name) = Enroller.ParseArgs(args, Enroller.ResolveApiBase());
    var result = await Enroller.EnrollAsync(baseUrl, code, name);
    Console.WriteLine($"Enrolled device {result.DeviceId}. Restarting the Safe Browse service.");
    Enroller.TryRestartService();
    return 0;
}
catch (Exception ex)
{
    Console.Error.WriteLine(ex.Message);
    return 1;
}

/// <summary>
/// Enrollment logic shared by the command-line path and the GUI.
///
/// These cannot be local functions in the top-level statements above: C# scopes
/// those to the generated entry point, so <see cref="EnrollForm"/> could not call
/// them (CS8801).
/// </summary>
internal static class Enroller
{
    private const string FallbackApiBase = "https://safebrowse.incorpify.in/api/v1/device/";

    /// <summary>
    /// Prefer the ApiBaseUrl the installer wrote into the service's appsettings.json,
    /// so a self-hosted deployment enrolls against its own Worker rather than the
    /// Incorpify SaaS default.
    /// </summary>
    public static string ResolveApiBase()
    {
        try
        {
            var settingsPath = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
            if (File.Exists(settingsPath))
            {
                using var document = JsonDocument.Parse(File.ReadAllText(settingsPath));
                if (document.RootElement.TryGetProperty("Agent", out var agent) &&
                    agent.TryGetProperty("ApiBaseUrl", out var apiBase) &&
                    apiBase.ValueKind == JsonValueKind.String)
                {
                    var value = apiBase.GetString();
                    if (!string.IsNullOrWhiteSpace(value)) return value;
                }
            }
        }
        catch
        {
            // Unreadable or malformed settings must not block enrollment.
        }
        return FallbackApiBase;
    }

    public static (string baseUrl, string code, string name) ParseArgs(string[] args, string defaultApi)
    {
        if (args.Length < 1)
            throw new ArgumentException("Usage: SafeBrowse.Enroll.exe <code>  OR  <apiBaseUrl> <code> [deviceName]");

        string baseUrl;
        string code;
        string name;
        // A bare code is the common case. Only treat the first argument as a URL when
        // it looks like one — passing just the code used to crash with
        // IndexOutOfRangeException.
        if (args.Length == 1 || !args[0].Contains("://", StringComparison.Ordinal))
        {
            baseUrl = defaultApi.TrimEnd('/');
            code = args[0];
            name = args.Length > 1 ? args[1] : Environment.MachineName;
        }
        else
        {
            baseUrl = args[0].TrimEnd('/');
            code = args[1];
            name = args.Length > 2 ? args[2] : Environment.MachineName;
        }

        return (baseUrl, code.Trim(), name);
    }

    public static string EnrollEndpoint(string baseUrl)
    {
        if (baseUrl.EndsWith("/api/v1/device/enroll", StringComparison.OrdinalIgnoreCase))
            return baseUrl;
        if (baseUrl.EndsWith("/api/v1/device", StringComparison.OrdinalIgnoreCase))
            return baseUrl + "/enroll";
        return baseUrl.TrimEnd('/') + "/api/v1/device/enroll";
    }

    public static async Task<Enrollment> EnrollAsync(string baseUrl, string code, string name)
    {
        if (string.IsNullOrWhiteSpace(code))
            throw new InvalidOperationException("Enrollment code is required.");

        var endpoint = EnrollEndpoint(baseUrl);
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var response = await client.PostAsJsonAsync(
            endpoint,
            new { code = code.Trim(), deviceName = name, platform = "windows", agentVersion = "0.1.1" });

        var body = await response.Content.ReadAsStringAsync();
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(
                string.IsNullOrWhiteSpace(body) ? $"Enroll failed (HTTP {(int)response.StatusCode})." : body);

        var result = JsonSerializer.Deserialize<Enrollment>(body, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        if (result is null)
            throw new InvalidOperationException("Enroll response was empty.");

        var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "SafeBrowse");
        Directory.CreateDirectory(directory);
        var protectedToken = ProtectedData.Protect(Encoding.UTF8.GetBytes(result.Token), null, DataProtectionScope.LocalMachine);
        await File.WriteAllBytesAsync(Path.Combine(directory, "device.credential"), protectedToken);
        await File.WriteAllTextAsync(
            Path.Combine(directory, "policy.json"),
            JsonSerializer.Serialize(result.Policy, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));

        return result;
    }

    public static void TryRestartService()
    {
        try
        {
            using var sc = new ServiceController("Safe Browse Protection");
            if (sc.Status == ServiceControllerStatus.Running)
            {
                sc.Stop();
                sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20));
            }
            sc.Start();
            sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
        }
        catch
        {
            // Best-effort; parent can restart manually.
        }
    }
}

internal sealed record Enrollment(Guid DeviceId, string Token, JsonElement Policy);

/// <summary>Click-to-enroll UI for parents after a normal MSI double-click install.</summary>
internal sealed class EnrollForm : Form
{
    private readonly string _defaultApi;
    private readonly TextBox _codeBox;
    private readonly TextBox _nameBox;
    private readonly Button _enrollBtn;
    private readonly Label _status;

    public EnrollForm(string defaultApi)
    {
        _defaultApi = defaultApi;
        Text = "Safe Browse — Link this PC";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 240);
        Font = new Font("Segoe UI", 10f);

        var intro = new Label
        {
            AutoSize = false,
            Location = new Point(20, 16),
            Size = new Size(400, 48),
            Text = "Enter the setup code from the parent console\n(https://safebrowse.incorpify.in → child → Generate setup code)."
        };

        var codeLabel = new Label { Text = "Setup code", Location = new Point(20, 72), AutoSize = true };
        _codeBox = new TextBox
        {
            Location = new Point(20, 94),
            Width = 400,
            PlaceholderText = "e.g. AB3K-M9NP-Q2VX",
            CharacterCasing = CharacterCasing.Upper
        };

        var nameLabel = new Label { Text = "Device name (optional)", Location = new Point(20, 128), AutoSize = true };
        _nameBox = new TextBox
        {
            Location = new Point(20, 150),
            Width = 400,
            Text = Environment.MachineName
        };

        _enrollBtn = new Button
        {
            Text = "Link this PC",
            Location = new Point(250, 190),
            Size = new Size(170, 32),
            BackColor = Color.FromArgb(16, 185, 129),
            ForeColor = Color.White,
            FlatStyle = FlatStyle.Flat
        };
        _enrollBtn.FlatAppearance.BorderSize = 0;
        _enrollBtn.Click += async (_, _) => await OnEnrollAsync();

        var cancel = new Button
        {
            Text = "Cancel",
            Location = new Point(160, 190),
            Size = new Size(80, 32),
            DialogResult = DialogResult.Cancel
        };
        cancel.Click += (_, _) => Close();

        _status = new Label
        {
            Location = new Point(20, 196),
            Size = new Size(130, 24),
            ForeColor = Color.DimGray,
            Text = ""
        };

        AcceptButton = _enrollBtn;
        CancelButton = cancel;
        Controls.AddRange([intro, codeLabel, _codeBox, nameLabel, _nameBox, _status, cancel, _enrollBtn]);
        ActiveControl = _codeBox;
    }

    private async Task OnEnrollAsync()
    {
        var code = _codeBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(code))
        {
            MessageBox.Show(this, "Paste the setup code from the parent console.", "Setup code required",
                MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        _enrollBtn.Enabled = false;
        _status.Text = "Linking…";
        _status.ForeColor = Color.DimGray;
        try
        {
            var name = string.IsNullOrWhiteSpace(_nameBox.Text) ? Environment.MachineName : _nameBox.Text.Trim();
            var result = await Enroller.EnrollAsync(_defaultApi, code, name);
            Enroller.TryRestartService();
            MessageBox.Show(
                this,
                $"This PC is linked.\nDevice id: {result.DeviceId}\n\nYou can close this window.",
                "Safe Browse",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            Environment.ExitCode = 0;
            Close();
        }
        catch (Exception ex)
        {
            _status.Text = "Failed";
            _status.ForeColor = Color.Firebrick;
            MessageBox.Show(
                this,
                ex.Message + "\n\nGenerate a fresh code in the parent console if this one expired.",
                "Could not link this PC",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            _enrollBtn.Enabled = true;
        }
    }
}
