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
];

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

  return {
    index, def, pts, n, length: n * STEP, step: STEP, width: def.width, half: def.width / 2,
    cps, boosts, path,
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
