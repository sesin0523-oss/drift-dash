using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace DriftDash;

/// <summary>
/// 플레이어가 차고에서 만든 커스텀 차. 다른 사람 화면에도 똑같이 그려지도록 서버가 검사해서 함께 보낸다.
/// 능력치는 속도·코너·드리프트·무게 각 1~5, 합계 12점 이하 (너무 센 차를 못 만들게).
/// </summary>
public sealed record CustomCar(
    string name, int shape, string color, string accent, int pattern, int? number,
    Dictionary<string, int> stats)
{
    public const int Budget = 12;
    private static readonly string[] StatKeys = { "speed", "corner", "drift", "weight" };
    private static readonly Regex Hex = new("^#[0-9a-fA-F]{6}$");

    /// <summary>브라우저가 보낸 값을 검사. 이상하면 null (기본 차로 처리)</summary>
    public static CustomCar? Parse(JsonObject? o)
    {
        if (o == null) return null;
        try
        {
            string name = new string(((string?)o["name"] ?? "").Where(ch => !char.IsControl(ch)).ToArray()).Trim();
            if (name.Length == 0) name = "내 차";
            if (name.Length > 10) name = name[..10];

            int shape = Math.Clamp((int?)o["shape"] ?? 0, 0, 3);
            int pattern = Math.Clamp((int?)o["pattern"] ?? 0, 0, 5);
            string color = (string?)o["color"] ?? "";
            string accent = (string?)o["accent"] ?? "";
            if (!Hex.IsMatch(color) || !Hex.IsMatch(accent)) return null;

            int? number = (int?)o["number"];
            if (number is < 0 or > 99) number = null;

            var stats = new Dictionary<string, int>();
            var s = o["stats"] as JsonObject;
            foreach (var k in StatKeys)
            {
                int v = (int?)s?[k] ?? 0;
                if (v is < 1 or > 5) return null;
                stats[k] = v;
            }
            if (stats.Values.Sum() > Budget) return null;

            return new CustomCar(name, shape, color, accent, pattern, number, stats);
        }
        catch (Exception)
        {
            return null;
        }
    }
}
