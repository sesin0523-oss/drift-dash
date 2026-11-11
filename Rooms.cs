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
                if (!room.Join(c)) c.Send(new { t = "error", msg = "방이 꽉 찼습니다 (최대 6명)." });
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

/// <summary>
/// 방 하나. 서버는 차를 직접 계산하지 않는다 (각자 브라우저가 자기 차를 계산).
/// 서버가 하는 일: 참가자 목록, 출발 시각 정하기, 위치 중계, 완주 순위 기록.
/// </summary>
public sealed class Room
{
    public const int MaxPlayers = 6;
    public const int TrackCount = 4;

    private enum Phase { Lobby, Race, Results }

    public string Code { get; }
    private readonly object _lock = new();
    private readonly List<Client> _clients = new();
    private Phase _phase = Phase.Lobby;
    private int _hostId;
    private int _track;
    private int _laps = 3;
    private string _mode = "speed";   // speed: 스피드전, item: 아이템전
    private long _startAt;
    private int _raceId;
    private readonly List<(int id, string name, long time)> _results = new();
    private readonly List<string> _chatHistory = new();   // 늦게 들어온 사람에게 보여줄 최근 대화
    private const int ChatHistoryMax = 30;
    private const int ChatMaxLength = 120;

    private readonly RecordStore _records;

    public Room(string code, RecordStore records)
    {
        Code = code;
        _records = records;
    }

    private static readonly string[] TrackNames = { "선셋 서킷", "협곡 헤어핀", "네온 시티", "도넛 링" };

    public bool IsEmpty { get { lock (_lock) return _clients.Count == 0; } }

    public bool Join(Client c)
    {
        lock (_lock)
        {
            if (_clients.Count >= MaxPlayers) return false;
            var used = _clients.Select(x => x.Color).ToHashSet();
            c.Color = Enumerable.Range(0, MaxPlayers).First(i => !used.Contains(i));
            c.Room = this;
            c.InRace = false;
            _clients.Add(c);
            if (_clients.Count == 1) _hostId = c.Id;

            c.Send(new { t = "welcome", you = c.Id, room = Code, s = Lobby.Now });
            foreach (var old in _chatHistory) c.Send(old);
            // 경기 중에 들어오면 관전
            if (_phase == Phase.Race) c.Send(RaceMessage());
            BroadcastRosterLocked();
            SystemChatLocked($"{c.Name} 님이 들어왔어요");
        }
        return true;
    }

    public void Leave(Client c)
    {
        lock (_lock)
        {
            _clients.Remove(c);
            if (_clients.Count == 0) return;
            if (_hostId == c.Id) _hostId = _clients[0].Id;
            Broadcast(new { t = "left", id = c.Id });
            SystemChatLocked($"{c.Name} 님이 나갔어요");
            if (_phase == Phase.Race) CheckRaceEndLocked();
            BroadcastRosterLocked();
        }
    }

    public void OnMessage(Client c, string type, JsonObject m)
    {
        lock (_lock)
        {
            switch (type)
            {
                case "cfg" when c.Id == _hostId && _phase != Phase.Race:
                    _track = Math.Clamp((int?)m["track"] ?? 0, 0, TrackCount - 1);
                    _laps = Math.Clamp((int?)m["laps"] ?? 3, 1, 9);
                    _mode = (string?)m["mode"] == "item" ? "item" : "speed";
                    BroadcastRosterLocked();
                    break;

                case "start" when c.Id == _hostId && _phase != Phase.Race:
                    _phase = Phase.Race;
                    _raceId++;
                    _results.Clear();
                    _startAt = Lobby.Now + 4000;   // 4초 뒤 출발 (카운트다운)
                    foreach (var cl in _clients) cl.InRace = true;
                    Broadcast(RaceMessage());
                    BroadcastRosterLocked();
                    StartTimeout(_raceId, TimeSpan.FromMinutes(10));
                    break;

                case "st" when _phase == Phase.Race && c.InRace:
                    // 내 차 상태 → 다른 사람들에게 그대로 중계 (보낸 사람 id 만 붙임)
                    m["id"] = c.Id;
                    string json = m.ToJsonString();
                    foreach (var other in _clients)
                        if (other != c) other.Send(json);
                    break;

                case "fin" when _phase == Phase.Race && c.InRace && _results.All(r => r.id != c.Id):
                {
                    long time = Math.Max(1000, (long?)m["time"] ?? 0);
                    _results.Add((c.Id, c.Name, time));
                    Broadcast(new { t = "fin", id = c.Id, time, place = _results.Count });
                    SystemChatLocked($"{c.Name} 님 완주! {_results.Count}위 ({time / 60000}:{time / 1000 % 60:00}.{time % 1000:000})");
                    // 1등이 들어오면 나머지는 30초 안에 들어와야 함
                    if (_results.Count == 1) StartTimeout(_raceId, TimeSpan.FromSeconds(30));
                    CheckRaceEndLocked();
                    break;
                }

                case "hit" when _phase == Phase.Race && c.InRace:
                {
                    // 내가 상대 뒤 모서리를 박았다 → 맞은 사람에게만 전달 (스핀 여부는 맞은 쪽이 결정)
                    int targetId = (int?)m["target"] ?? 0;
                    var target = _clients.FirstOrDefault(x => x.Id == targetId && x.InRace && x != c);
                    if (target == null) break;
                    int side = Math.Sign((double?)m["side"] ?? 1);
                    double power = Math.Clamp((double?)m["power"] ?? 0, 0, 2000);
                    target.Send(new { t = "hit", from = c.Id, side = side == 0 ? 1 : side, power });
                    break;
                }

                case "spun" when _phase == Phase.Race && c.InRace:
                {
                    // 맞은 사람이 실제로 돌았다 → 모두에게 알림 ("A → B 스핀!")
                    string why = (string?)m["why"] switch { "banana" => "banana", "missile" => "missile", _ => "bump" };
                    Broadcast(new { t = "spun", id = c.Id, from = (int?)m["from"] ?? 0, why });
                    break;
                }

                // 아이템전: 상자 먹음 / 바나나·미사일 생성 / 맞음 → 다른 사람들에게 그대로 중계
                case "box" or "obj" or "objHit" when _phase == Phase.Race && c.InRace && _mode == "item":
                {
                    if (type == "obj" && (string?)m["kind"] is not ("banana" or "missile")) break;
                    m["id"] = c.Id;
                    string itemJson = m.ToJsonString();
                    foreach (var other in _clients)
                        if (other != c) other.Send(itemJson);
                    break;
                }

                case "lap" when _phase == Phase.Race && c.InRace && _mode == "speed":
                {
                    // 한 바퀴 기록 (스피드전만. 아이템전은 운이 섞여서 랭킹에 넣지 않음)
                    long time = (long?)m["time"] ?? 0;
                    var (ok, rank, newBest) = _records.Submit(_track, c.Name, time, m["ghost"] as JsonArray);
                    c.Send(new { t = "lapres", ok, rank, newBest, time });
                    if (rank == 1)
                        SystemChatLocked($"{c.Name} 님이 {TrackNames[_track]} 신기록! {time / 60000}:{time / 1000 % 60:00}.{time % 1000:000}");
                    break;
                }

                case "chat":
                {
                    string text = new string(((string?)m["text"] ?? "").Where(ch => !char.IsControl(ch)).ToArray()).Trim();
                    if (text.Length == 0) break;
                    if (text.Length > ChatMaxLength) text = text[..ChatMaxLength];

                    // 도배 방지: 4초 안에 5개까지
                    long now = Lobby.Now;
                    while (c.ChatTimes.Count > 0 && now - c.ChatTimes.Peek() > 4000) c.ChatTimes.Dequeue();
                    if (c.ChatTimes.Count >= 5)
                    {
                        c.Send(new { t = "chat", sys = true, text = "채팅이 너무 빨라요. 잠시 후에 보내 주세요.", ts = now });
                        break;
                    }
                    c.ChatTimes.Enqueue(now);

                    AddChatLocked(JsonSerializer.Serialize(new { t = "chat", id = c.Id, name = c.Name, color = c.Color, text, ts = now }));
                    break;
                }

                case "lobby" when c.Id == _hostId && _phase == Phase.Results:
                    _phase = Phase.Lobby;
                    foreach (var cl in _clients) cl.InRace = false;
                    BroadcastRosterLocked();
                    break;
            }
        }
    }

    private object RaceMessage() => new
    {
        t = "race",
        raceId = _raceId,
        track = _track,
        laps = _laps,
        mode = _mode,
        startAt = _startAt,
        grid = _clients.Where(c => c.InRace).Select(c => c.Id).ToArray(),
    };

    private void CheckRaceEndLocked()
    {
        var racers = _clients.Where(c => c.InRace).ToList();
        if (racers.All(r => _results.Any(x => x.id == r.Id))) EndRaceLocked();
    }

    private void EndRaceLocked()
    {
        if (_phase != Phase.Race) return;
        _phase = Phase.Results;
        var dnf = _clients.Where(c => c.InRace && _results.All(r => r.id != c.Id))
                          .Select(c => new { id = c.Id, name = c.Name }).ToArray();
        Broadcast(new
        {
            t = "results",
            list = _results.Select(r => new { r.id, r.name, r.time }).ToArray(),
            dnf,
        });
        BroadcastRosterLocked();
    }

    private void StartTimeout(int raceId, TimeSpan after)
    {
        _ = Task.Run(async () =>
        {
            await Task.Delay(after);
            lock (_lock)
            {
                if (_raceId == raceId) EndRaceLocked();
            }
        });
    }

    public void BroadcastRoster()
    {
        lock (_lock) BroadcastRosterLocked();
    }

    private void BroadcastRosterLocked()
    {
        Broadcast(new
        {
            t = "roster",
            host = _hostId,
            phase = _phase.ToString().ToLowerInvariant(),
            track = _track,
            laps = _laps,
            mode = _mode,
            players = _clients.Select(c => new { id = c.Id, name = c.Name, color = c.Color, inRace = c.InRace }).ToArray(),
        });
    }

    /// <summary>채팅 한 줄을 기록하고 방 전체에 보냄.</summary>
    private void AddChatLocked(string json)
    {
        _chatHistory.Add(json);
        if (_chatHistory.Count > ChatHistoryMax) _chatHistory.RemoveAt(0);
        foreach (var c in _clients) c.Send(json);
    }

    /// <summary>입장/퇴장 같은 안내 문구 (회색으로 표시)</summary>
    private void SystemChatLocked(string text) =>
        AddChatLocked(JsonSerializer.Serialize(new { t = "chat", sys = true, text, ts = Lobby.Now }));

    private void Broadcast(object msg)
    {
        string json = JsonSerializer.Serialize(msg);
        foreach (var c in _clients) c.Send(json);
    }
}
