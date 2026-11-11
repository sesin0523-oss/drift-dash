using System.Text.Json;
using System.Text.Json.Nodes;

namespace DriftDash;

/// <summary>
/// 트랙별 최고 랩 타임 순위(이름마다 최고 기록 하나, 상위 10개)와 1위의 고스트(주행 경로).
/// data/records.json 에 저장해서 서버를 껐다 켜도 남는다.
/// (Render 무료 요금제는 서버가 잠들거나 재배포되면 디스크가 초기화되어 기록도 사라짐)
/// </summary>
public sealed class RecordStore
{
    public const int TopCount = 10;
    public const int GhostHz = 10;          // 고스트는 초당 10번 위치 기록

    // 트랙 중심선 길이(px). 아무리 빨라도 (최고 부스트 속도 920px/s, 안쪽 라인 고려 0.75배) 이보다 빠를 순 없음
    private static readonly int[] TrackLength = { 11232, 13488, 7096, 5720, 10280, 11540, 6968, 7256, 8480, 8384, 7168, 9192, 37192, 38280, 37160, 25536 };

    private sealed class Entry
    {
        public string Name { get; set; } = "";
        public long Time { get; set; }
        public long Date { get; set; }
    }

    private sealed class TrackRecords
    {
        public List<Entry> Top { get; set; } = new();
        public string? GhostName { get; set; }
        public long GhostTime { get; set; }
        public float[]? Ghost { get; set; }   // [x, y, a, x, y, a, ...]
    }

    private readonly Dictionary<int, TrackRecords> _tracks = new();
    private readonly object _lock = new();
    private readonly string _file;

    public RecordStore(string dataDir)
    {
        Directory.CreateDirectory(dataDir);
        _file = Path.Combine(dataDir, "records.json");
        try
        {
            if (File.Exists(_file))
            {
                var loaded = JsonSerializer.Deserialize<Dictionary<int, TrackRecords>>(File.ReadAllText(_file));
                if (loaded != null) foreach (var (k, v) in loaded) _tracks[k] = v;
            }
        }
        catch (Exception e)
        {
            Console.WriteLine($"기록 파일을 읽지 못했어요 ({e.Message}). 빈 기록으로 시작합니다.");
        }
    }

    public static long MinLapMs(int track) =>
        track >= 0 && track < TrackLength.Length ? (long)(TrackLength[track] / 920.0 * 1000 * 0.75) : long.MaxValue;

    /// <summary>
    /// 랩 기록 제출. 말이 안 되는 기록(너무 빠름, 고스트 길이가 시간과 안 맞음)은 거부.
    /// 결과: rank(1부터, 순위 밖이면 0), newBest(트랙 1위 갱신)
    /// </summary>
    public (bool ok, int rank, bool newBest) Submit(int track, string name, long time, JsonArray? ghost)
    {
        if (time < MinLapMs(track) || time > 10 * 60 * 1000) return (false, 0, false);

        float[]? frames = null;
        if (ghost != null)
        {
            int expected = (int)(time * GhostHz / 1000) + 1;
            if (ghost.Count % 3 != 0 || Math.Abs(ghost.Count / 3 - expected) > 6 || ghost.Count > 3 * 6000)
                return (false, 0, false);
            frames = new float[ghost.Count];
            for (int i = 0; i < ghost.Count; i++)
            {
                double v = (double?)ghost[i] ?? double.NaN;
                if (!double.IsFinite(v) || Math.Abs(v) > 1e6) return (false, 0, false);
                frames[i] = (float)v;
            }
        }

        lock (_lock)
        {
            if (!_tracks.TryGetValue(track, out var tr)) _tracks[track] = tr = new TrackRecords();

            var mine = tr.Top.FirstOrDefault(e => e.Name == name);
            if (mine != null && mine.Time <= time) return (true, 0, false);   // 내 예전 기록이 더 좋음
            if (mine != null) tr.Top.Remove(mine);
            tr.Top.Add(new Entry { Name = name, Time = time, Date = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
            tr.Top.Sort((a, b) => a.Time.CompareTo(b.Time));
            if (tr.Top.Count > TopCount) tr.Top.RemoveRange(TopCount, tr.Top.Count - TopCount);

            int rank = tr.Top.FindIndex(e => e.Name == name && e.Time == time) + 1;
            bool newBest = rank == 1 && frames != null && (tr.Ghost == null || time < tr.GhostTime);
            if (newBest)
            {
                tr.Ghost = frames;
                tr.GhostName = name;
                tr.GhostTime = time;
            }
            if (rank > 0) Save();
            return (true, rank, newBest);
        }
    }

    public object Top()
    {
        lock (_lock)
        {
            return Enumerable.Range(0, TrackLength.Length).Select(i =>
                _tracks.TryGetValue(i, out var tr)
                    ? tr.Top.Select(e => new { name = e.Name, time = e.Time, date = e.Date }).ToArray()
                    : Array.Empty<object>()).ToArray();
        }
    }

    public object? Ghost(int track)
    {
        lock (_lock)
        {
            if (!_tracks.TryGetValue(track, out var tr) || tr.Ghost == null) return null;
            return new { name = tr.GhostName, time = tr.GhostTime, hz = GhostHz, frames = tr.Ghost };
        }
    }

    private void Save()
    {
        try
        {
            string tmp = _file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_tracks));
            File.Move(tmp, _file, overwrite: true);
        }
        catch (Exception e)
        {
            Console.WriteLine($"기록 저장 실패: {e.Message}");
        }
    }
}
