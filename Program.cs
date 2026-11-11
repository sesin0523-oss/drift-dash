using System.Net.NetworkInformation;
using System.Net.Sockets;
using DriftDash;

// 포트: 클라우드(Render 등)는 PORT 환경변수를 주고, 내 PC 에서는 5080
string port = Environment.GetEnvironmentVariable("PORT") ?? "5080";

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls($"http://0.0.0.0:{port}");   // 같은 와이파이의 다른 기기도 접속 가능
builder.Logging.SetMinimumLevel(LogLevel.Warning);

var app = builder.Build();

app.UseDefaultFiles();     // / → wwwroot/index.html
app.UseStaticFiles(new StaticFileOptions
{
    // 개발 중 수정한 js 가 바로 반영되도록 캐시 끔
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache",
});
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });

// 트랙 기록: DATA_DIR 환경변수가 있으면 거기에, 없으면 프로젝트 폴더의 data/ 에 저장
var records = new RecordStore(Environment.GetEnvironmentVariable("DATA_DIR")
                              ?? Path.Combine(app.Environment.ContentRootPath, "data"));
var lobby = new Lobby(records);

// 같은 와이파이 친구에게 줄 주소 (localhost 로 열었을 때 화면에 보여줌)
app.MapGet("/api/info", () => new { lan = LanIPs().Select(ip => $"http://{ip}:{port}").ToArray() });

// 트랙별 랭킹 (상위 10명) / 1위 고스트
app.MapGet("/api/records", () => records.Top());
app.MapGet("/api/ghost/{track:int}", (int track) =>
    records.Ghost(track) is { } g ? Results.Ok(g) : Results.NotFound());

// 실시간 통신
app.Map("/ws", async ctx =>
{
    if (!ctx.WebSockets.IsWebSocketRequest)
    {
        ctx.Response.StatusCode = 400;
        return;
    }
    using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
    await lobby.HandleAsync(ws, ctx.RequestAborted);
});

Console.WriteLine("DriftDash 서버 실행 중");
Console.WriteLine($"  이 PC      : http://localhost:{port}");
foreach (var ip in LanIPs()) Console.WriteLine($"  같은 와이파이: http://{ip}:{port}");
Console.WriteLine("종료하려면 Ctrl+C");

app.Run();

static IEnumerable<string> LanIPs() =>
    NetworkInterface.GetAllNetworkInterfaces()
        .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
        .OrderByDescending(n => n.GetIPProperties().GatewayAddresses.Count)
        .SelectMany(n => n.GetIPProperties().UnicastAddresses)
        .Where(a => a.Address.AddressFamily == AddressFamily.InterNetwork)
        .Select(a => a.Address.ToString())
        .Distinct();
