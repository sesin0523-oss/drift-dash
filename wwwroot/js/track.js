// 트랙: 몇 개의 기준점을 부드러운 곡선(Catmull-Rom)으로 이어 도로를 만든다.
// 도로 중심선을 8px 간격의 점들로 나눠 두고, 차가 어느 점에 가장 가까운지로
// "도로 위인지", "몇 바퀴째 어디쯤인지"를 계산한다.

export const SHOULDER = 70;   // 도로 밖 잔디 폭. 그 바깥은 벽(타이어 방벽)

function ellipse(cx, cy, rx, ry, n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

export const TRACKS = [
  {
    name: '선셋 서킷',
    desc: '넓고 빠른 기본 코스',
    width: 160,
    scale: 2.1,             // 기준점 좌표 배율 (트랙 크기)
    grass: ['#5fa84f', '#589c49'],
    points: [[0, 0], [900, 0], [1350, 120], [1550, 480], [1380, 860], [950, 980], [650, 820],
             [380, 940], [-50, 1000], [-420, 820], [-520, 420], [-340, 90]],
    boosts: [0.08, 0.36, 0.7],
    checkpoints: 10,
  },
  {
    name: '협곡 헤어핀',
    desc: '급커브가 많은 기술 코스',
    width: 135,
    scale: 1.8,
    grass: ['#b9935a', '#ad8850'],
    points: [[0, 0], [750, -120], [1180, 80], [1120, 470], [700, 540], [560, 820], [950, 1010],
             [1420, 1060], [1540, 1420], [1050, 1620], [250, 1560], [-260, 1300], [-130, 880],
             [-470, 620], [-400, 180]],
    boosts: [0.04, 0.45, 0.66],
    checkpoints: 14,
  },
  {
    name: '네온 시티',
    desc: '직각 코너와 S자, 몸싸움이 많은 좁은 시가지',
    width: 140,
    scale: 1,
    grass: ['#1f222a', '#262a33'],   // 어두운 보도블록 (도로와 대비)
    // 모서리마다 점을 두 개씩 가까이 둬서 각진 코너를 만든다
    points: [[0, 0], [1400, 0], [1600, 40], [1700, 200], [1700, 700], [1660, 860], [1500, 900],
             [1150, 900], [1000, 960], [950, 1100], [950, 1350], [880, 1480], [720, 1520],
             [300, 1520], [140, 1480], [80, 1330], [80, 1100], [20, 960], [-130, 900],
             [-450, 900], [-600, 840], [-650, 700], [-650, 250], [-600, 80], [-420, 0]],
    boosts: [0.1, 0.55, 0.86],
    checkpoints: 16,
  },
  {
    name: '도넛 링',
    desc: '짧은 타원, 드리프트 연습용',
    width: 180,
    scale: 1.5,
    grass: ['#4f9fb0', '#4895a6'],
    points: ellipse(0, 0, 760, 430, 14),
    boosts: [0.25, 0.75],
    checkpoints: 10,
  },
  {
    name: '스노우 밸리',
    desc: '눈길이라 잘 미끄러지는 S자 코스 (접지력 70%)',
    width: 150,
    scale: 1.15,
    grass: ['#e9eef5', '#dde5ef'],
    gripMul: 0.7,           // 눈길: 옆미끄럼이 덜 잡힘
    points: [[0, 0], [600, -150], [1200, -100], [1600, 200], [1500, 600], [1100, 700], [800, 550], [500, 700],
             [400, 1050], [700, 1350], [1200, 1400], [1500, 1700], [1200, 2000], [500, 2000], [0, 1700],
             [-300, 1300], [-200, 900], [-450, 500], [-350, 150]],
    boosts: [0.05, 0.42, 0.72],
    checkpoints: 14,
  },
  {
    name: '해안 고속도로',
    desc: '긴 직선과 시케인, 부스터가 많은 고속 코스',
    width: 170,
    scale: 1.15,
    grass: ['#ead9a8', '#e1cf9a'],   // 모래사장
    points: [[0, 0], [2200, 0], [2500, 150], [2550, 450], [2300, 600], [1900, 560], [1700, 700], [1900, 900],
             [2400, 1000], [2600, 1250], [2400, 1500], [1200, 1520], [0, 1500], [-350, 1300], [-400, 900],
             [-150, 700], [-400, 400], [-300, 100]],
    boosts: [0.08, 0.2, 0.55, 0.63, 0.9],
    checkpoints: 14,
  },
  {
    name: '화산 분지',
    desc: '분화구를 도는 지그재그 코스, 어두운 화산재',
    width: 150,
    scale: 1.2,
    grass: ['#2f2522', '#3a2a24'],
    points: [[0, 0], [500, -250], [1000, -200], [1300, 100], [1200, 450], [1450, 750], [1300, 1100],
             [900, 1150], [700, 900], [400, 1100], [0, 1050], [-300, 800], [-200, 500], [-450, 250]],
    boosts: [0.12, 0.5, 0.8],
    checkpoints: 14,
  },
  {
    name: '숲속 와인딩',
    desc: '좁고 구불구불한 숲길, 쉴 틈 없는 연속 커브',
    width: 132,
    scale: 1.2,
    grass: ['#2f6b3a', '#2a6034'],
    points: [[0, 0], [400, -200], [800, 0], [1100, -250], [1500, -100], [1600, 300], [1300, 500],
             [1500, 800], [1300, 1150], [900, 1050], [600, 1250], [200, 1150], [0, 850], [-300, 700], [-250, 350]],
    boosts: [0.3, 0.7],
    checkpoints: 16,
  },
  {
    name: '공항 활주로',
    desc: '끝없는 활주로 직선과 꼬불꼬불한 유도로',
    width: 180,
    scale: 1,
    grass: ['#86a072', '#7d9768'],
    points: [[0, 0], [3000, 0], [3300, 150], [3300, 450], [3000, 600], [2600, 550], [2300, 700], [1900, 600],
             [1500, 750], [1100, 600], [700, 700], [300, 600], [-100, 650], [-350, 450], [-300, 150]],
    boosts: [0.05, 0.15, 0.25, 0.6],
    checkpoints: 14,
  },
  {
    name: '사막 오아시스',
    desc: '모래 언덕 사이를 크게 도는 코스, 가운데 오아시스',
    width: 165,
    scale: 1.15,
    grass: ['#e2c27a', '#d8b86e'],
    points: [[0, 0], [800, -100], [1500, 0], [1900, 350], [1800, 800], [1400, 1000], [1000, 850], [650, 1050],
             [700, 1450], [300, 1650], [-200, 1500], [-450, 1100], [-300, 700], [-500, 350], [-350, 50]],
    boosts: [0.06, 0.4, 0.75],
    checkpoints: 14,
  },
  {
    name: '항구 부두',
    desc: '컨테이너 사이 직각 코너와 바다로 튀어나온 부두',
    width: 150,
    scale: 1,
    grass: ['#8d939c', '#848a93'],   // 콘크리트 바닥
    points: [[0, 0], [1600, 0], [1800, 60], [1880, 250], [1880, 500], [1800, 650], [1600, 700], [1200, 700],
             [1050, 760], [1000, 950], [1000, 1300], [940, 1460], [780, 1520], [400, 1520], [240, 1460],
             [180, 1300], [180, 950], [120, 780], [-50, 720], [-350, 720], [-500, 640], [-560, 450],
             [-520, 150], [-380, 20]],
    boosts: [0.08, 0.5, 0.88],
    checkpoints: 16,
  },
  {
    name: '절벽 고개',
    desc: '산허리를 오르내리는 좁은 갈지자 길',
    width: 140,
    scale: 1.2,
    grass: ['#8a8f7a', '#80856f'],
    points: [[0, 0], [700, -100], [1200, 100], [1000, 400], [500, 450], [300, 700], [700, 900], [1300, 850],
             [1600, 1100], [1400, 1450], [800, 1500], [200, 1400], [-250, 1100], [-200, 700], [-450, 400], [-300, 80]],
    boosts: [0.03, 0.55],
    checkpoints: 16,
  },
  // ── 그랑프리 전용 긴 코스 (gp: true → 그랑프리 모드에서만, 1→4 순서로) ──
  {
    name: '호수 순환로',
    desc: '그랑프리 1라운드 · 큰 호수를 도는 고속 코스, 긴 메인 직선',
    width: 190,
    scale: 3,
    grass: ['#4f9a45', '#4a9141'],
    gp: true,
    points: [[0, 0], [1800, 0], [2300, 100], [2500, 400], [2300, 700], [1900, 750], [1700, 950], [1900, 1200],
             [2600, 1250], [3100, 1500], [3200, 1900], [2900, 2200], [2200, 2250], [1500, 2100], [1000, 2300],
             [400, 2250], [0, 2000], [-200, 1600], [100, 1300], [-100, 1000], [-500, 900], [-700, 500], [-500, 150]],
    boosts: [0.5],
    checkpoints: 30,
  },
  {
    name: '대평원 하이웨이',
    desc: '그랑프리 2라운드 · 끝없는 직선과 시케인, 평원의 옆바람',
    width: 185,
    scale: 3,
    grass: ['#c9b46a', '#c0aa60'],
    gp: true,
    points: [[0, 0], [3000, 0], [3400, 300], [3300, 800], [2800, 1000], [2900, 1500], [3400, 1800], [3200, 2400],
             [2200, 2500], [1800, 2100], [1200, 2300], [400, 2400], [-200, 2000], [0, 1500], [-400, 1100], [-300, 500]],
    boosts: [0.3, 0.75],
    checkpoints: 30,
  },
  {
    name: '알파인 고개',
    desc: '그랑프리 3라운드 · 높은 산을 넘는 긴 와인딩, 낭떠러지 주의',
    width: 165,
    scale: 2.6,
    grass: ['#7f8a6e', '#768166'],
    gp: true,
    points: [[0, 0], [1200, -200], [2200, 0], [2600, 500], [2200, 900], [1400, 800], [1000, 1100], [1500, 1500],
             [2400, 1500], [2900, 1900], [2600, 2500], [1700, 2700], [800, 2500], [300, 2800], [-400, 2500],
             [-500, 1800], [-100, 1300], [-600, 900], [-500, 300]],
    boosts: [0.05, 0.6],
    checkpoints: 30,
  },
  {
    name: '야간 도심 순환',
    desc: '그랑프리 4라운드(결승) · 불 켜진 대도시를 한 바퀴, 직각 코너 연속',
    width: 170,
    scale: 2.2,
    grass: ['#1f222a', '#262a33'],
    gp: true,
    points: [[0, 0], [2400, 0], [2600, 100], [2700, 300], [2700, 1000], [2600, 1200], [2400, 1250], [1800, 1250],
             [1650, 1350], [1600, 1550], [1600, 2200], [1500, 2400], [1300, 2450], [200, 2450], [0, 2350],
             [-100, 2150], [-100, 1400], [-200, 1250], [-400, 1200], [-800, 1200], [-1000, 1100], [-1050, 900],
             [-1050, 300], [-950, 100], [-700, 0]],
    boosts: [0.1, 0.55],
    checkpoints: 30,
  },
];

// ───────────────────────── 트랙 특색 ─────────────────────────
// at: 트랙 위치(0~1), lat: 도로 폭 대비 옆 위치(-0.5~0.5), r: 반지름
// hazards: 도로 옆이 벽 대신 용암/바다 → 빠지면 견인되어 조금 뒤에서 다시 출발
// patches: 도로 위 노면 (mud 진흙·snow 눈 더미 = 감속, ice 빙판 = 미끄러움)
// obstacles: 장애물 (rock 바위·log 통나무 = 막힘, bumper 범퍼 = 세게 튕김)
// wind: 옆으로 미는 바람 (주기적으로 방향이 바뀜)
// zapWalls: 벽에 닿으면 감전되어 잠깐 느려짐
const FEATURES = {
  '협곡 헤어핀': {
    note: '굴러떨어진 바위 조심',
    obstacles: [[0.1, 0.25], [0.28, -0.25], [0.52, 0.22], [0.67, -0.22], [0.86, 0.25]]
      .map(([at, lat]) => ({ at, lat, r: 17, kind: 'rock' })),
  },
  '네온 시티': { note: '전기 방벽: 벽에 닿으면 감전', zapWalls: true },
  '도넛 링': {
    note: '도로 한가운데 핀볼 범퍼',
    obstacles: [0.12, 0.37, 0.62, 0.87].map((at) => ({ at, lat: 0, r: 15, kind: 'bumper' })),
  },
  '스노우 밸리': {
    note: '눈 더미(감속)와 빙판(미끄러움)',
    patches: [
      ...[[0.2, 0.25], [0.35, -0.25], [0.6, 0.2], [0.8, -0.2]].map(([at, lat]) => ({ at, lat, r: 30, kind: 'snow' })),
      { at: 0.45, lat: 0, r: 48, kind: 'ice' }, { at: 0.9, lat: 0, r: 48, kind: 'ice' },
    ],
  },
  '해안 고속도로': {
    note: '직선 옆은 바다! 빠지면 견인',
    hazards: [{ from: 0.02, to: 0.14, side: 1, kind: 'water' }, { from: 0.72, to: 0.86, side: -1, kind: 'water' }],
  },
  '화산 분지': {
    note: '커브 바깥은 용암! 빠지면 견인',
    hazards: [
      { from: 0.14, to: 0.24, side: -1, kind: 'lava' }, { from: 0.38, to: 0.48, side: 1, kind: 'lava' },
      { from: 0.62, to: 0.72, side: -1, kind: 'lava' }, { from: 0.84, to: 0.94, side: 1, kind: 'lava' },
    ],
  },
  '숲속 와인딩': {
    note: '진흙 웅덩이와 쓰러진 통나무',
    patches: [[0.15, 0.2], [0.42, -0.2], [0.58, 0.2], [0.82, -0.2]].map(([at, lat]) => ({ at, lat, r: 32, kind: 'mud' })),
    obstacles: [{ at: 0.3, lat: 0.3, r: 14, kind: 'log' }, { at: 0.68, lat: -0.3, r: 14, kind: 'log' }],
  },
  '공항 활주로': {
    note: '활주로에 부는 제트 바람',
    wind: [{ from: 0.04, to: 0.26, force: 320, period: 2.6 }],
  },
};
Object.assign(FEATURES, {
  '사막 오아시스': {
    note: '모래 언덕(감속)과 가끔 부는 모래 폭풍',
    patches: [[0.12, 0.25], [0.24, -0.25], [0.5, 0.22], [0.62, -0.2], [0.86, 0.25]]
      .map(([at, lat]) => ({ at, lat, r: 36, kind: 'sand' })),
    wind: [{ from: 0.66, to: 0.82, force: 240, period: 3.4 }],
    hazards: [{ from: 0.3, to: 0.37, side: 1, kind: 'water' }],
  },
  '항구 부두': {
    note: '부두 끝은 바다! 빠지면 견인 · 화물 상자 조심',
    hazards: [{ from: 0.44, to: 0.52, side: -1, kind: 'water' }, { from: 0.56, to: 0.64, side: -1, kind: 'water' }],
    obstacles: [[0.18, 0.28], [0.3, -0.28], [0.74, 0.28], [0.92, -0.28]]
      .map(([at, lat]) => ({ at, lat, r: 18, kind: 'crate' })),
  },
  '호수 순환로': { note: '장애물 없는 순수 실력 승부' },
  '대평원 하이웨이': {
    note: '직선 구간의 강한 옆바람',
    wind: [{ from: 0.02, to: 0.14, force: 260, period: 3 }, { from: 0.62, to: 0.72, force: 260, period: 3 }],
  },
  '알파인 고개': {
    note: '난간 없는 낭떠러지(떨어지면 견인)와 낙석',
    hazards: [{ from: 0.1, to: 0.17, side: -1, kind: 'cliff' }, { from: 0.55, to: 0.62, side: -1, kind: 'cliff' }],
    obstacles: [[0.3, 0.25], [0.45, -0.25], [0.8, 0.25]].map(([at, lat]) => ({ at, lat, r: 16, kind: 'rock' })),
  },
  '야간 도심 순환': { note: '네온 방벽: 벽에 닿으면 감전', zapWalls: true },
  '절벽 고개': {
    note: '난간 없는 낭떠러지! 떨어지면 견인 · 낙석 조심',
    hazards: [
      { from: 0.08, to: 0.16, side: -1, kind: 'cliff' }, { from: 0.36, to: 0.44, side: 1, kind: 'cliff' },
      { from: 0.66, to: 0.74, side: -1, kind: 'cliff' },
    ],
    obstacles: [[0.24, 0.25], [0.52, -0.25], [0.84, 0.22]].map(([at, lat]) => ({ at, lat, r: 16, kind: 'rock' })),
  },
});
for (const t of TRACKS) t.features = FEATURES[t.name] ?? {};

/** 그랑프리 모드에서 차례로 달리는 코스 번호들 */
export const GP_TRACKS = TRACKS.map((t, i) => (t.gp ? i : -1)).filter((i) => i >= 0);

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/** 트랙 정의 → 계산에 쓸 데이터 (점, 법선, 누적 거리, 체크포인트, 부스터, 출발 위치) */
export function buildTrack(index) {
  const def = TRACKS[index];
  const scale = def.scale ?? 1;
  const P = def.points.map(([x, y]) => [x * scale, y * scale]), n0 = P.length;

  // 1) 곡선을 촘촘하게
  const dense = [];
  for (let i = 0; i < n0; i++) {
    const p0 = P[(i - 1 + n0) % n0], p1 = P[i], p2 = P[(i + 1) % n0], p3 = P[(i + 2) % n0];
    for (let k = 0; k < 40; k++) dense.push(catmullRom(p0, p1, p2, p3, k / 40));
  }

  // 2) 8px 간격으로 다시 나누기 (점 간격이 일정해야 거리 계산이 쉬움)
  const STEP = 8;
  const pts = [];
  let carry = 0;
  for (let i = 0; i < dense.length; i++) {
    const a = dense[i], b = dense[(i + 1) % dense.length];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let d = carry;
    while (d < seg) {
      const t = d / seg;
      pts.push({ x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t });
      d += STEP;
    }
    carry = d - seg;
  }

  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    pts[i].tx = (b.x - a.x) / len;
    pts[i].ty = (b.y - a.y) / len;
    pts[i].nx = -pts[i].ty;   // 진행 방향의 왼쪽
    pts[i].ny = pts[i].tx;
    pts[i].s = i * STEP;
  }

  const cps = [];
  for (let k = 0; k < def.checkpoints; k++) cps.push(Math.floor((k / def.checkpoints) * n));

  // 부스터 발판: 도로 중앙에서 조금씩 엇갈리게
  const boosts = def.boosts.map((f, k) => {
    const i = Math.floor(f * n) % n, p = pts[i];
    const lat = (k % 2 === 0 ? -0.22 : 0.22) * def.width;
    return { i, lat, x: p.x + p.nx * lat, y: p.y + p.ny * lat, a: Math.atan2(p.ty, p.tx) };
  });

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }

  // 그리기용 경로 (한 번만 만들어 둠)
  const path = new Path2D();
  pts.forEach((p, i) => (i ? path.lineTo(p.x, p.y) : path.moveTo(p.x, p.y)));
  path.closePath();

  // 트랙 특색 배치
  const F = def.features ?? {};
  const atIdx = (f) => Math.floor(f * n) % n;
  const place = (o) => {
    const i = atIdx(o.at), p = pts[i], lat = (o.lat ?? 0) * def.width;
    return { ...o, i, x: p.x + p.nx * lat, y: p.y + p.ny * lat, a: Math.atan2(p.ty, p.tx) };
  };
  const obstacles = (F.obstacles ?? []).map(place);
  const patches = (F.patches ?? []).map(place);

  // 용암/바다: 점마다 어느 쪽(side)이 빠지는 곳인지. 그리기용 띠 모양도 미리 만듦
  const hazardSide = new Int8Array(n);
  const hazardKind = new Array(n).fill(null);
  const hazards = (F.hazards ?? []).map((h) => {
    const i0 = atIdx(h.from), i1 = atIdx(h.to);
    const idx = [];
    for (let i = i0; i !== i1; i = (i + 1) % n) idx.push(i);
    for (const i of idx) { hazardSide[i] = h.side; hazardKind[i] = h.kind; }
    const inner = def.width / 2 + 12, outer = def.width / 2 + SHOULDER + 90;
    const shape = new Path2D();
    idx.forEach((i, k) => {
      const p = pts[i], x = p.x + p.nx * h.side * inner, y = p.y + p.ny * h.side * inner;
      k ? shape.lineTo(x, y) : shape.moveTo(x, y);
    });
    for (const i of [...idx].reverse()) {
      const p = pts[i];
      shape.lineTo(p.x + p.nx * h.side * outer, p.y + p.ny * h.side * outer);
    }
    shape.closePath();
    return { ...h, i0, i1, shape };
  });

  const wind = (F.wind ?? []).map((w) => ({ ...w, i0: atIdx(w.from), i1: atIdx(w.to) }));

  return {
    index, def, pts, n, length: n * STEP, step: STEP, width: def.width, half: def.width / 2,
    cps, boosts, path,
    obstacles, patches, hazards, hazardSide, hazardKind, wind, zapWalls: !!F.zapWalls,
    bounds: { minX: minX - 200, minY: minY - 200, maxX: maxX + 200, maxY: maxY + 200 },
  };
}

/**
 * (x, y) 에서 가장 가까운 중심선 점. hint(지난 프레임의 점 번호)가 있으면 그 근처만 찾는다.
 * lat: 중심선에서 옆으로 떨어진 거리(+는 왼쪽)
 */
export function nearest(track, x, y, hint) {
  const { pts, n } = track;
  let best = 0, bd = Infinity;
  const scan = (i) => {
    const p = pts[i];
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) { bd = d; best = i; }
  };
  if (hint == null) {
    for (let i = 0; i < n; i++) scan(i);
  } else {
    for (let k = -40; k <= 40; k++) scan((hint + k + n) % n);
    // 너무 멀면(순간이동 등) 전체에서 다시 찾기
    if (bd > (track.width * 2) ** 2) for (let i = 0; i < n; i++) scan(i);
  }
  const p = pts[best];
  return { i: best, lat: (x - p.x) * p.nx + (y - p.y) * p.ny };
}

/** 출발선 뒤 격자 위치 (2줄로 엇갈려 서기) */
export function gridSlot(track, slot) {
  const back = 6 + Math.floor(slot / 2) * 8;     // 점 번호로 뒤쪽
  const i = (track.n - back) % track.n;
  const p = track.pts[i];
  const lat = (slot % 2 === 0 ? 1 : -1) * track.width * 0.22;
  return { x: p.x + p.nx * lat, y: p.y + p.ny * lat, a: Math.atan2(p.ty, p.tx), i };
}

/** 점 번호 a 에서 b 까지 앞으로 몇 칸인지 (한 바퀴 돌아오는 것 고려) */
export function forwardDist(track, a, b) {
  return (b - a + track.n) % track.n;
}

/** 점 i 가 바람 구간이면 그 구간 */
export function windAt(track, i) {
  for (const w of track.wind) if (forwardDist(track, w.i0, i) <= forwardDist(track, w.i0, w.i1)) return w;
  return null;
}
