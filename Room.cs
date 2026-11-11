using System.Text.Json;
using System.Text.Json.Nodes;

namespace DriftDash;

/// <summary>AI 봇. 실제 운전은 방장 브라우저가 계산하고, 서버는 목록만 관리한다.</summary>
public sealed class Bot
{
    public required int Id { get; init; }      // 음수 (사람 id 와 겹치지 않게)
    public required string Name { get; init; }
    public int Color;
    public int Car;
    public int Team = -1;
    public int Level;                          // 0 쉬움, 1 보통, 2 어려움
    public bool InRace;
}

/// <summary>
/// 방 하나. 서버는 차를 직접 계산하지 않는다 (각자 브라우저가 자기 차를, 방장 브라우저가 봇을 계산).
/// 서버가 하는 일: 참가자·봇 목록, 팀, 출발 시각, 위치 중계, 완주 순위, 채팅, 기록.
///
/// 방장이 봇 대신 메시지를 보낼 때는 "as": 봇id 를 붙인다 → 서버는 그 봇이 보낸 것처럼 처리.
/// </summary>
public sealed class Room
{
    public const int MaxRacers = 6;            // 사람 + 봇
    public const int MaxConnections = 10;      // 관전자 포함
    public const int TrackCount = 4;
    private static readonly int[] PlacePoints = { 10, 8, 6, 5, 4, 3 };
    private static readonly string[] TrackNames = { "선셋 서킷", "협곡 헤어핀", "네온 시티", "도넛 링" };
    private static readonly string[] BotNames = { "봇 번개", "봇 터보", "봇 회오리", "봇 질주", "봇 스키드", "봇 니트로" };
    private static readonly string[] LevelNames = { "쉬움", "보통", "어려움" };

    private enum Phase { Lobby, Race, Results }

    public string Code { get; }
    private readonly object _lock = new();
    private readonly List<Client> _clients = new();
    private readonly List<Bot> _bots = new();
    private readonly RecordStore _records;
    private Phase _phase = Phase.Lobby;
    private int _hostId;
    private int _track;
    private int _laps = 3;
    private string _mode = "speed";   // speed: 스피드전, item: 아이템전
    private bool _teams;              // 팀전 (레드 vs 블루)
    private long _startAt;
    private int _raceId;
    private int _nextBotId = -1;
    private readonly List<(int id, string name, long time)> _results = new();
    private readonly List<string> _chatHistory = new();
    private const int ChatHistoryMax = 30;
    private const int ChatMaxLength = 120;

    public Room(string code, RecordStore records)
    {
        Code = code;
        _records = records;
    }

    public bool IsEmpty { get { lock (_lock) return _clients.Count == 0; } }

    private Client? Host => _clients.FirstOrDefault(c => c.Id == _hostId);
    private int RacerCount => _clients.Count(c => !c.Spectate) + _bots.Count;

    private int FreeColor()
    {
        var used = _clients.Select(x => x.Color).Concat(_bots.Select(b => b.Color)).ToHashSet();
        return Enumerable.Range(0, 12).First(i => !used.Contains(i));
    }

    /// <summary>레이스 참가자 (사람·봇 공통): id, 이름, 팀</summary>
    private IEnumerable<(int id, string name, int team)> RacersInRace =>
        _clients.Where(c => c.InRace).Select(c => (c.Id, c.Name, c.Team))
                .Concat(_bots.Where(b => b.InRace).Select(b => (b.Id, b.Name, b.Team)));

    private string NameOf(int id) =>
        _clients.FirstOrDefault(c => c.Id == id)?.Name ?? _bots.FirstOrDefault(b => b.Id == id)?.Name ?? "?";

    // ───────────────────────── 입장 / 퇴장 ─────────────────────────

    public bool Join(Client c)
    {
        lock (_lock)
        {
            if (_clients.Count >= MaxConnections) return false;
            c.Color = FreeColor();
            c.Room = this;
            c.InRace = false;
            c.Spectate = RacerCount >= MaxRacers;     // 자리가 없으면 관전으로
            _clients.Add(c);
            if (_clients.Count == 1) _hostId = c.Id;

            c.Send(new { t = "welcome", you = c.Id, room = Code, s = Lobby.Now });
            foreach (var old in _chatHistory) c.Send(old);
            if (_phase == Phase.Race) c.Send(RaceMessage());   // 경기 중에 들어오면 관전
            BroadcastRosterLocked();
            SystemChatLocked($"{c.Name} 님이 들어왔어요{(c.Spectate ? " (자리가 없어 관전)" : "")}");
        }
        return true;
    }

    public void Leave(Client c)
    {
        lock (_lock)
        {
            _clients.Remove(c);
            if (_clients.Count == 0) return;
            Broadcast(new { t = "left", id = c.Id });
            SystemChatLocked($"{c.Name} 님이 나갔어요");

            if (_hostId == c.Id)
            {
                _hostId = _clients[0].Id;
                // 봇은 방장 브라우저가 운전하므로, 방장이 나가면 봇도 함께 나감
                foreach (var b in _bots) Broadcast(new { t = "left", id = b.Id });
                if (_bots.Count > 0) SystemChatLocked("방장이 바뀌어서 봇들이 나갔어요");
                _bots.Clear();
            }
            if (_phase == Phase.Race) CheckRaceEndLocked();
            BroadcastRosterLocked();
        }
    }

    // ───────────────────────── 메시지 ─────────────────────────

    /// <summary>이 메시지를 누가 보낸 것으로 볼지: 방장이 "as": 봇id 를 붙였으면 그 봇</summary>
    private (int id, bool isBot) Actor(Client c, JsonObject m)
    {
        int? asId = (int?)m["as"];
        if (asId is int bid && c.Id == _hostId && _bots.Any(b => b.Id == bid)) return (bid, true);
        return (c.Id, false);
    }

    private bool ActorInRace(int id, bool isBot) =>
        isBot ? _bots.Any(b => b.Id == id && b.InRace) : _clients.Any(c => c.Id == id && c.InRace);

    public void OnMessage(Client c, string type, JsonObject m)
    {
        lock (_lock)
        {
            bool host = c.Id == _hostId;
            bool lobby = _phase != Phase.Race;
            var (actor, isBot) = Actor(c, m);
            bool racing = _phase == Phase.Race && ActorInRace(actor, isBot);

            switch (type)
            {
                // ── 로비 설정 ──
                case "cfg" when host && lobby:
                    _track = Math.Clamp((int?)m["track"] ?? 0, 0, TrackCount - 1);
                    _laps = Math.Clamp((int?)m["laps"] ?? 3, 1, 9);
                    _mode = (string?)m["mode"] == "item" ? "item" : "speed";
                    _teams = (bool?)m["teams"] ?? false;
                    if (_teams) BalanceTeamsLocked();
                    BroadcastRosterLocked();
                    break;

                case "car" when lobby:
                    c.Car = Math.Clamp((int?)m["car"] ?? 0, 0, 3);
                    BroadcastRosterLocked();
                    break;

                case "team" when lobby && _teams:
                    c.Team = Math.Clamp((int?)m["team"] ?? 0, 0, 1);
                    BroadcastRosterLocked();
                    break;

                case "spec" when lobby:
                {
                    bool want = (bool?)m["on"] ?? false;
                    if (!want && RacerCount >= MaxRacers) { c.Send(new { t = "error", msg = "레이서 자리가 꽉 찼어요 (최대 6대)." }); break; }
                    c.Spectate = want;
                    BroadcastRosterLocked();
                    break;
                }

                case "addBot" when host && lobby:
                {
                    if (RacerCount >= MaxRacers) { c.Send(new { t = "error", msg = "레이서 자리가 꽉 찼어요 (최대 6대)." }); break; }
                    int level = Math.Clamp((int?)m["level"] ?? 1, 0, 2);
                    string name = BotNames.First(n => _bots.All(b => b.Name != n));
                    var bot = new Bot { Id = _nextBotId--, Name = name, Level = level, Color = FreeColor(), Car = Random.Shared.Next(4) };
                    _bots.Add(bot);
                    if (_teams) bot.Team = SmallerTeam();
                    BroadcastRosterLocked();
                    SystemChatLocked($"{name} ({LevelNames[level]}) 이(가) 들어왔어요");
                    break;
                }

                case "removeBot" when host && lobby:
                {
                    var bot = _bots.FirstOrDefault(b => b.Id == ((int?)m["id"] ?? 0));
                    if (bot == null) break;
                    _bots.Remove(bot);
                    BroadcastRosterLocked();
                    break;
                }

                case "botTeam" when host && lobby && _teams:
                {
                    var bot = _bots.FirstOrDefault(b => b.Id == ((int?)m["id"] ?? 0));
                    if (bot != null) bot.Team = 1 - Math.Max(0, bot.Team);
                    BroadcastRosterLocked();
                    break;
                }

                case "start" when host && lobby:
                    if (RacerCount == 0) { c.Send(new { t = "error", msg = "레이서가 없어요. 관전을 끄거나 봇을 추가하세요." }); break; }
                    _phase = Phase.Race;
                    _raceId++;
                    _results.Clear();
                    _startAt = Lobby.Now + 4000;   // 4초 뒤 출발 (카운트다운)
                    if (_teams) BalanceTeamsLocked();
                    foreach (var cl in _clients) cl.InRace = !cl.Spectate;
                    foreach (var b in _bots) b.InRace = true;
                    Broadcast(RaceMessage());
                    BroadcastRosterLocked();
                    StartTimeout(_raceId, TimeSpan.FromMinutes(10));
                    break;

                case "lobby" when host && _phase == Phase.Results:
                    _phase = Phase.Lobby;
                    foreach (var cl in _clients) cl.InRace = false;
                    foreach (var b in _bots) b.InRace = false;
                    BroadcastRosterLocked();
                    break;

                // ── 레이스 중 ──
                case "st" when racing:
                    // 차 상태 → 다른 사람들에게 그대로 중계 (보낸 차 id 를 붙임)
                    m["id"] = actor;
                    m.Remove("as");
                    RelayLocked(c, m.ToJsonString());
                    break;

                case "fin" when racing && _results.All(r => r.id != actor):
                {
                    long time = Math.Max(1000, (long?)m["time"] ?? 0);
                    string name = NameOf(actor);
                    _results.Add((actor, name, time));
                    Broadcast(new { t = "fin", id = actor, time, place = _results.Count });
                    SystemChatLocked($"{name} 님 완주! {_results.Count}위 ({Fmt(time)})");
                    // 1등이 들어오면 나머지는 30초 안에 들어와야 함
                    if (_results.Count == 1) StartTimeout(_raceId, TimeSpan.FromSeconds(30));
                    CheckRaceEndLocked();
                    break;
                }

                case "hit" when racing:
                {
                    // 뒤 모서리를 박았다 → 맞은 차의 주인에게 전달 (봇이면 방장). 스핀 여부는 맞은 쪽이 결정
                    int targetId = (int?)m["target"] ?? 0;
                    if (targetId == actor) break;
                    Client? owner = _bots.Any(b => b.Id == targetId && b.InRace) ? Host
                                  : _clients.FirstOrDefault(x => x.Id == targetId && x.InRace);
                    if (owner == null) break;
                    int side = Math.Sign((double?)m["side"] ?? 1);
                    double power = Math.Clamp((double?)m["power"] ?? 0, 0, 2000);
                    owner.Send(new { t = "hit", from = actor, target = targetId, side = side == 0 ? 1 : side, power });
                    break;
                }

                case "spun" when racing:
                {
                    string why = (string?)m["why"] switch { "banana" => "banana", "missile" => "missile", _ => "bump" };
                    Broadcast(new { t = "spun", id = actor, from = (int?)m["from"] ?? 0, why });
                    break;
                }

                // 아이템전: 상자 먹음 / 바나나·미사일 생성 / 맞음 → 다른 사람들에게 그대로 중계
                case "box" or "obj" or "objHit" when racing && _mode == "item":
                {
                    if (type == "obj" && (string?)m["kind"] is not ("banana" or "missile")) break;
                    m["id"] = actor;
                    m.Remove("as");
                    RelayLocked(c, m.ToJsonString());
                    break;
                }

                case "lap" when racing && !isBot && _mode == "speed":
                {
                    // 한 바퀴 기록 (사람·스피드전만)
                    long time = (long?)m["time"] ?? 0;
                    var (ok, rank, newBest) = _records.Submit(_track, c.Name, time, m["ghost"] as JsonArray);
                    c.Send(new { t = "lapres", ok, rank, newBest, time });
                    if (rank == 1) SystemChatLocked($"{c.Name} 님이 {TrackNames[_track]} 신기록! {Fmt(time)}");
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
            }
        }
    }

    // ───────────────────────── 팀 ─────────────────────────

    private int SmallerTeam()
    {
        int red = _clients.Count(c => !c.Spectate && c.Team == 0) + _bots.Count(b => b.Team == 0);
        int blue = _clients.Count(c => !c.Spectate && c.Team == 1) + _bots.Count(b => b.Team == 1);
        return red <= blue ? 0 : 1;
    }

    /// <summary>팀을 안 정한 사람·봇을 인원이 적은 팀에 넣음</summary>
    private void BalanceTeamsLocked()
    {
        foreach (var c in _clients.Where(c => !c.Spectate && c.Team < 0)) c.Team = SmallerTeam();
        foreach (var b in _bots.Where(b => b.Team < 0)) b.Team = SmallerTeam();
    }

    // ───────────────────────── 레이스 진행 ─────────────────────────

    private object RaceMessage() => new
    {
        t = "race",
        raceId = _raceId,
        track = _track,
        laps = _laps,
        mode = _mode,
        teams = _teams,
        startAt = _startAt,
        grid = RacersInRace.Select(r => r.id).ToArray(),
    };

    private void CheckRaceEndLocked()
    {
        if (RacersInRace.All(r => _results.Any(x => x.id == r.id))) EndRaceLocked();
    }

    private void EndRaceLocked()
    {
        if (_phase != Phase.Race) return;
        _phase = Phase.Results;
        var racers = RacersInRace.ToList();
        var dnf = racers.Where(r => _results.All(x => x.id != r.id)).Select(r => new { r.id, r.name }).ToArray();

        // 팀전: 순위 점수 합 (1위 10, 2위 8, 3위 6, 4위 5, 5위 4, 6위 3, 완주 못함 0)
        int[] teamScore = new int[2];
        if (_teams)
        {
            for (int i = 0; i < _results.Count; i++)
            {
                int team = racers.FirstOrDefault(r => r.id == _results[i].id).team;
                if (team is 0 or 1) teamScore[team] += PlacePoints[Math.Min(i, PlacePoints.Length - 1)];
            }
            string winner = teamScore[0] == teamScore[1] ? "무승부!" : teamScore[0] > teamScore[1] ? "레드 팀 승리!" : "블루 팀 승리!";
            SystemChatLocked($"팀전 결과 {teamScore[0]} : {teamScore[1]} {winner}");
        }

        Broadcast(new
        {
            t = "results",
            list = _results.Select(r => new { r.id, r.name, r.time }).ToArray(),
            dnf,
            teams = _teams,
            teamScore,
            points = PlacePoints,
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

    // ───────────────────────── 보내기 ─────────────────────────

    public void BroadcastRoster()
    {
        lock (_lock) BroadcastRosterLocked();
    }

    private void BroadcastRosterLocked()
    {
        var people = _clients.Select(c => (object)new
        {
            id = c.Id, name = c.Name, color = c.Color, inRace = c.InRace,
            car = c.Car, team = c.Team, spec = c.Spectate, bot = false, level = 0,
        });
        var bots = _bots.Select(b => (object)new
        {
            id = b.Id, name = b.Name, color = b.Color, inRace = b.InRace,
            car = b.Car, team = b.Team, spec = false, bot = true, level = b.Level,
        });
        Broadcast(new
        {
            t = "roster",
            host = _hostId,
            phase = _phase.ToString().ToLowerInvariant(),
            track = _track,
            laps = _laps,
            mode = _mode,
            teams = _teams,
            players = people.Concat(bots).ToArray(),
        });
    }

    /// <summary>보낸 사람을 뺀 모두에게</summary>
    private void RelayLocked(Client from, string json)
    {
        foreach (var other in _clients)
            if (other != from) other.Send(json);
    }

    private void AddChatLocked(string json)
    {
        _chatHistory.Add(json);
        if (_chatHistory.Count > ChatHistoryMax) _chatHistory.RemoveAt(0);
        foreach (var c in _clients) c.Send(json);
    }

    private void SystemChatLocked(string text) =>
        AddChatLocked(JsonSerializer.Serialize(new { t = "chat", sys = true, text, ts = Lobby.Now }));

    private void Broadcast(object msg)
    {
        string json = JsonSerializer.Serialize(msg);
        foreach (var c in _clients) c.Send(json);
    }

    private static string Fmt(long ms) => $"{ms / 60000}:{ms / 1000 % 60:00}.{ms % 1000:000}";
}
