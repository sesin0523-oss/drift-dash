using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;

namespace DriftDash;

/// <summary>
/// 접속한 브라우저 하나. WebSocket 은 동시에 두 번 보내면 안 되므로
/// 보낼 메시지를 큐(Channel)에 넣고 전용 작업 하나가 순서대로 보낸다.
/// </summary>
public sealed class Client
{
    public required WebSocket Ws { get; init; }
    public required int Id { get; init; }
    public string Name = "드라이버";
    public int Color;
    public bool InRace;
    public Room? Room;
    public readonly Queue<long> ChatTimes = new();   // 도배 방지용 최근 채팅 시각
    public int Car;          // 고른 차 종류 (0~3)
    public int Team = -1;    // 팀전: 0 = 레드, 1 = 블루, -1 = 아직 안 정함
    public bool Spectate;    // 관전만 하기

    private readonly Channel<string> _out = Channel.CreateBounded<string>(
        new BoundedChannelOptions(512) { FullMode = BoundedChannelFullMode.DropOldest });

    public void Send(string json) => _out.Writer.TryWrite(json);
    public void Send(object msg) => Send(JsonSerializer.Serialize(msg));
    public void Complete() => _out.Writer.TryComplete();

    public async Task PumpAsync(CancellationToken ct)
    {
        await foreach (var m in _out.Reader.ReadAllAsync(ct))
        {
            if (Ws.State != WebSocketState.Open) break;
            await Ws.SendAsync(Encoding.UTF8.GetBytes(m), WebSocketMessageType.Text, true, ct);
        }
    }
}

/// <summary>방 목록. 링크의 ?room=코드 로 같은 방에 들어온다.</summary>
public sealed class Lobby
{
    private readonly Dictionary<string, Room> _rooms = new();
    private readonly object _lock = new();
    private readonly RecordStore _records;
    private int _nextId;

    public Lobby(RecordStore records) => _records = records;

    public static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public async Task HandleAsync(WebSocket ws, CancellationToken ct)
    {
        var client = new Client { Ws = ws, Id = Interlocked.Increment(ref _nextId) };
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var pump = client.PumpAsync(cts.Token);

        var buf = new byte[8 * 1024];
        var ms = new MemoryStream();
        try
        {
            while (ws.State == WebSocketState.Open)
            {
                ms.SetLength(0);
                WebSocketReceiveResult r;
                bool closed = false;
                do
                {
                    r = await ws.ReceiveAsync(buf, cts.Token);
                    if (r.MessageType == WebSocketMessageType.Close) { closed = true; break; }
                    ms.Write(buf, 0, r.Count);
                } while (!r.EndOfMessage && ms.Length < 64 * 1024);
                if (closed) break;

                JsonObject? msg;
                try { msg = JsonNode.Parse(ms.ToArray()) as JsonObject; }
                catch (JsonException) { continue; }
                if (msg != null) OnMessage(client, msg);
            }
        }
        catch (Exception) { /* 연결 끊김 */ }

        Leave(client);
        client.Complete();
        cts.Cancel();
        try { await pump; } catch { }
        if (ws.State is WebSocketState.Open or WebSocketState.CloseReceived)
        {
            try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        }
    }

    private void OnMessage(Client c, JsonObject msg)
    {
        string? type = (string?)msg["t"];
        switch (type)
        {
            case "ping":
                // 시계 맞추기: 클라이언트가 보낸 시각을 그대로 돌려주고 서버 시각을 붙임
                c.Send(new { t = "pong", c = (double?)msg["c"] ?? 0, s = Now });
                break;

            case "join" when c.Room == null:
            {
                string name = CleanName((string?)msg["name"]);
                string code = CleanCode((string?)msg["room"]);
                Room room;
                lock (_lock)
                {
                    if (!_rooms.TryGetValue(code, out room!))
                        _rooms[code] = room = new Room(code, _records);
                }
                c.Name = name;
                if (!room.Join(c)) c.Send(new { t = "error", msg = "방이 꽉 찼습니다 (관전 포함 최대 10명)." });
                break;
            }

            case "name":
                c.Name = CleanName((string?)msg["name"]);
                c.Room?.BroadcastRoster();
                break;

            default:
                if (type != null) c.Room?.OnMessage(c, type, msg);
                break;
        }
    }

    private void Leave(Client c)
    {
        var room = c.Room;
        if (room == null) return;
        room.Leave(c);
        lock (_lock)
        {
            if (room.IsEmpty) _rooms.Remove(room.Code);
        }
    }

    private static string CleanName(string? s)
    {
        s = new string((s ?? "").Where(ch => !char.IsControl(ch)).ToArray()).Trim();
        if (s.Length == 0) s = "드라이버";
        return s.Length > 12 ? s[..12] : s;
    }

    private static string CleanCode(string? s)
    {
        s = new string((s ?? "").ToUpperInvariant().Where(ch => ch is >= 'A' and <= 'Z' or >= '0' and <= '9').ToArray());
        if (s.Length < 3) s = Random.Shared.Next(0x1000, 0xFFFF).ToString("X4");
        return s.Length > 8 ? s[..8] : s;
    }
}

