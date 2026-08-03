using System.Diagnostics;
using System.IO.Pipes;
using System.ServiceProcess;
using System.Text;

if (args.Contains("--emergency")) { await SendEmergency(); return; }
ApplicationConfiguration.Initialize();
using var icon = new NotifyIcon { Icon = SystemIcons.Shield, Text = "Safe Browse protection", Visible = true };
var menu = new ContextMenuStrip();
var status = menu.Items.Add("Checking protection…"); status.Enabled = false;
menu.Items.Add("Open parent dashboard", null, (_, _) => Process.Start(new ProcessStartInfo("https://app.example.com") { UseShellExecute = true }));
menu.Items.Add("Emergency bypass (15 minutes)", null, (_, _) => Process.Start(new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = true, Verb = "runas", Arguments = "--emergency" }));
menu.Items.Add("Exit tray", null, (_, _) => Application.Exit()); icon.ContextMenuStrip = menu;
var timer = new System.Windows.Forms.Timer { Interval = 5000 };
timer.Tick += (_, _) => { try { using var service = new ServiceController("Safe Browse Protection"); status.Text = $"Protection: {service.Status}"; icon.Text = $"Safe Browse: {service.Status}"; } catch { status.Text = "Protection service unavailable"; } };
timer.Start(); Application.Run(); icon.Visible = false;

static async Task SendEmergency()
{
    await using var pipe = new NamedPipeClientStream(".", "safe-browse-native", PipeDirection.InOut, PipeOptions.Asynchronous);
    await pipe.ConnectAsync(2000); var message = Encoding.UTF8.GetBytes("{\"action\":\"emergency\"}\n"); await pipe.WriteAsync(message); await pipe.FlushAsync();
    using var reader = new StreamReader(pipe); MessageBox.Show(await reader.ReadLineAsync() ?? "No response", "Safe Browse", MessageBoxButtons.OK, MessageBoxIcon.Information);
}
