using Microsoft.Extensions.Options;
using SafeBrowse.Service;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "Safe Browse Protection");
builder.Configuration.AddJsonFile("appsettings.json", optional: false).AddEnvironmentVariables("SAFE_BROWSE_");
builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection("Agent"));
builder.Services.AddHttpClient("api", (services, client) => client.BaseAddress = new Uri(services.GetRequiredService<IOptions<AgentOptions>>().Value.ApiBaseUrl));
builder.Services.AddHttpClient("doh", (services, client) => client.BaseAddress = new Uri(services.GetRequiredService<IOptions<AgentOptions>>().Value.UpstreamDohUrl));
builder.Services.AddSingleton<AgentState>();
builder.Services.AddSingleton<CredentialStore>();
builder.Services.AddSingleton<PolicyStore>();
builder.Services.AddSingleton<ListArtifactStore>();
builder.Services.AddSingleton<EventQueue>();
builder.Services.AddSingleton<AccessRequestQueue>();
builder.Services.AddHostedService<ProtectionWorker>();
builder.Services.AddHostedService<NativePipeWorker>();
await builder.Build().RunAsync();
