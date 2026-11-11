// 아케이드 자동차 물리 + 바퀴/체크포인트 계산.
// 속도를 "앞 방향 성분"과 "옆 방향 성분"으로 나눠서,
// 옆 성분을 빨리 없애면 접지력이 좋은 차, 천천히 없애면 미끄러지는(드리프트) 차가 된다.

import { nearest, forwardDist, gridSlot, windAt, SHOULDER } from './track.js';

export const CAR = {
  length: 38, width: 20, radius: 17,
  // 충돌 모양: 차 크기와 같은 회전된 직사각형 (앞뒤가 평평해야 '길 막기'가 된다)
  // 스핀: 상대 앞부분이 내 뒤쪽 모서리를 이 속도 이상으로 박으면
  spinMinSpeed: 140, spinImmune: 1.2,
  accel: 560, brake: 1000, reverse: 260, roll: 140,
  maxSpeed: 640, offroadMax: 280, boostMax: 920, boostAccel: 1100,
  steer: 3.1,            // 최대 회전 속도 (rad/s)
  grip: 9.0,             // 평소 옆미끄럼 억제
  driftGrip: 1.7,        // 드리프트(Space) 중 옆미끄럼 억제
  offroadGrip: 5.0,
  chargeRate: 1,         // 미니 터보 모이는 속도
  mass: 1,               // 무게: 무거우면 덜 밀리고 상대를 더 밀어냄
  spinTime: 1,           // 스핀 시간 배율
};

/** 차 종류. stats 에 적은 값만 기본(CAR)에서 바뀐다. bars 는 로비 표시용 (0~5) */
export const CAR_TYPES = [
  { name: '밸런스', desc: '무난한 기본 차', stats: {},
    bars: { 속도: 3, 코너: 3, 드리프트: 3, 무게: 3 } },
  { name: '스피드', desc: '최고 속도가 높지만 코너가 둔함', stats: { maxSpeed: 690, accel: 520, steer: 2.85, grip: 8.2, chargeRate: 0.9, mass: 0.9 },
    bars: { 속도: 5, 코너: 2, 드리프트: 2, 무게: 2 } },
  { name: '드리프트', desc: '잘 미끄러지고 미니 터보가 빨리 참', stats: { maxSpeed: 625, accel: 570, steer: 3.4, driftGrip: 1.25, chargeRate: 1.45, mass: 0.95 },
    bars: { 속도: 2, 코너: 4, 드리프트: 5, 무게: 2 } },
  { name: '탱크', desc: '무거워서 잘 안 밀리고 스핀도 잘 안 당함', stats: { maxSpeed: 615, accel: 500, steer: 2.95, grip: 10.5, chargeRate: 0.85, mass: 1.6, spinMinSpeed: 230, spinTime: 0.7 },
    bars: { 속도: 2, 코너: 3, 드리프트: 1, 무게: 5 } },
];

/** 커스텀 차: 능력치 4개(1~5)를 합계 12점 안에서 나눔. 3·3·3·3 이면 기본 차와 비슷 */
export const CUSTOM_TYPE = 4;
export const CUSTOM_BUDGET = 12;
export const STAT_KEYS = ['speed', 'corner', 'drift', 'weight'];
export const STAT_NAMES = { speed: '속도', corner: '코너', drift: '드리프트', weight: '무게' };

export function customStats(st) {
  const v = (k) => Math.max(1, Math.min(5, Math.round(st?.[k] ?? 3)));
  return {
    maxSpeed: 586 + 18 * v('speed'),          // 604 ~ 676
    accel: 605 - 15 * v('speed'),             // 빠른 차일수록 가속은 조금 느림
    steer: 2.6 + 0.18 * v('corner'),
    grip: 7.4 + 0.6 * v('corner'),
    driftGrip: 2.15 - 0.22 * v('drift'),      // 낮을수록 잘 미끄러짐
    chargeRate: 0.7 + 0.18 * v('drift'),
    mass: 0.6 + 0.15 * v('weight'),           // 0.75 ~ 1.35
    spinMinSpeed: 110 + 20 * v('weight'),
    spinTime: 1.15 - 0.08 * v('weight'),
  };
}

/** 합계가 예산을 넘지 않게 맞춘 능력치 */
export function clampStats(st) {
  const out = {};
  let total = 0;
  for (const k of STAT_KEYS) { out[k] = Math.max(1, Math.min(5, Math.round(st?.[k] ?? 3))); total += out[k]; }
  for (const k of [...STAT_KEYS].reverse()) while (total > CUSTOM_BUDGET && out[k] > 1) { out[k]--; total--; }
  return out;
}

export const carSpec = (type, custom) =>
  type === CUSTOM_TYPE && custom
    ? { ...CAR, ...customStats(clampStats(custom.stats)) }
    : { ...CAR, ...(CAR_TYPES[type] ?? CAR_TYPES[0]).stats };

/** 회전된 직사각형(OBB): 중심, 앞 방향 축, 옆 방향 축, 반길이/반폭 */
function box(c) {
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  return { x: c.x, y: c.y, ax: [[fx, fy], [-fy, fx]], h: [CAR.length / 2, CAR.width / 2] };
}

function corners(b) {
  const [[fx, fy], [rx, ry]] = b.ax, [hl, hw] = b.h;
  return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([s, t]) => [b.x + fx * hl * s + rx * hw * t, b.y + fy * hl * s + ry * hw * t]);
}

function inside(b, px, py, margin = 0.5) {
  const dx = px - b.x, dy = py - b.y;
  return Math.abs(dx * b.ax[0][0] + dy * b.ax[0][1]) <= b.h[0] + margin
      && Math.abs(dx * b.ax[1][0] + dy * b.ax[1][1]) <= b.h[1] + margin;
}

/**
 * 분리축 검사(SAT): 두 직사각형의 축 4개에 그림자를 비춰 보고,
 * 모든 축에서 겹치면 충돌. 가장 조금 겹친 축이 밀어낼 방향(n: A→B), 겹친 양이 depth.
 */
export function boxCollide(A, B) {
  let depth = Infinity, nx = 0, ny = 0;
  const dx = B.x - A.x, dy = B.y - A.y;
  for (const [ax, ay] of [...A.ax, ...B.ax]) {
    const ra = A.h[0] * Math.abs(A.ax[0][0] * ax + A.ax[0][1] * ay) + A.h[1] * Math.abs(A.ax[1][0] * ax + A.ax[1][1] * ay);
    const rb = B.h[0] * Math.abs(B.ax[0][0] * ax + B.ax[0][1] * ay) + B.h[1] * Math.abs(B.ax[1][0] * ax + B.ax[1][1] * ay);
    const dist = dx * ax + dy * ay;
    const overlap = ra + rb - Math.abs(dist);
    if (overlap <= 0) return null;
    if (overlap < depth) {
      depth = overlap;
      const s = dist < 0 ? -1 : 1;
      nx = ax * s; ny = ay * s;
    }
  }
  // 접촉점: 서로의 안으로 들어간 꼭짓점들의 평균
  let cx = 0, cy = 0, k = 0;
  for (const [px, py] of corners(A)) if (inside(B, px, py)) { cx += px; cy += py; k++; }
  for (const [px, py] of corners(B)) if (inside(A, px, py)) { cx += px; cy += py; k++; }
  if (k) { cx /= k; cy /= k; } else { cx = (A.x + B.x) / 2; cy = (A.y + B.y) / 2; }
  return { depth, nx, ny, cx, cy };
}

export class Car {
  constructor(track, slot, type = 0, custom = null) {
    this.type = type;
    this.spec = carSpec(type, custom);
    this.mass = this.spec.mass;
    const g = gridSlot(track, slot);
    this.x = g.x; this.y = g.y; this.a = g.a;
    this.vx = 0; this.vy = 0;
    this.hint = g.i;
    this.lat = 0;
    this.offroad = false;
    this.drifting = false;
    this.driftCharge = 0;     // 드리프트를 오래 할수록 참 → 놓으면 미니 터보
    this.boost = 0;           // 남은 부스트 시간(초)
    this.lap = 1;
    this.nextCp = 1;
    this.cpCount = 0;
    this.finished = false;
    this.lapStart = 0;
    this.lapTimes = [];
    this.bumped = 0;          // 벽/차에 부딪힌 세기 (소리·흔들림용)
    this.boostedPad = false;
    this.spin = 0;            // 남은 스핀 시간 (조작 불능)
    this.spinRate = 0;        // 도는 속도 (rad/s)
    this.immune = 0;          // 스핀 직후 연속 스핀 방지
    this.hits = [];           // 이번 프레임에 내가 상대 뒤 모서리를 박은 기록 → 서버로
    this.shield = 0;          // 보호막 남은 시간 (아이템전)
    this.shieldPopped = false;
    this.towT = 0;            // 용암·바다에 빠져 견인 중 (조작 불가)
    this.fell = null;         // 이번 프레임에 빠졌으면 { kind, x, y } (효과용)
    this.ghost = 0;           // 투명 망토 / 견인 직후: 차·아이템에 안 부딪힘
    this.zap = 0;             // 감전: 느려짐
    this.zapHit = false;      // 이번 프레임에 전기 벽에 닿음 (효과용)
    this.slide = 0;           // 기름: 핸들이 거의 안 먹음
    this.surface = null;      // 지금 밟고 있는 노면 (mud/snow/ice)
  }

  get shielded() { return this.shield > 0; }
  get ghostly() { return this.ghost > 0 || this.towT > 0; }
  get towing() { return this.towT > 0; }

  /** 용암·바다에 빠짐 → 조금 뒤 도로 한가운데로 견인, 잠깐 조작 불가 */
  fall(track, kind) {
    this.fell = { kind, x: this.x, y: this.y };
    const i = (this.hint - 12 + track.n) % track.n, p = track.pts[i];
    this.x = p.x; this.y = p.y; this.a = Math.atan2(p.ty, p.tx);
    this.vx = this.vy = 0;
    this.hint = i; this.lat = 0; this.offroad = false;
    this.towT = 1.5;
    this.ghost = this.towT + 1.2;     // 다시 출발한 직후 잠깐은 부딪히지 않음
    this.boost = 0; this.spin = 0; this.slide = 0; this.driftCharge = 0;
  }

  /** 상대가 내 뒤 모서리를 박았을 때. side: 맞은 쪽(-1/1), power: 박은 속도 */
  applySpin(side, power) {
    if (this.spin > 0 || this.immune > 0 || this.finished || this.ghostly) return false;
    if (power < this.spec.spinMinSpeed) return false;   // 탱크는 웬만큼 세게 박아야 돎
    if (this.shield > 0) {           // 보호막이 한 번 막아 줌
      this.shield = 0;
      this.shieldPopped = true;
      this.immune = 0.8;
      return false;
    }
    this.spin = (0.9 + Math.min(0.5, power / 1000)) * this.spec.spinTime;
    this.spinRate = -side * (9 + Math.min(6, power / 80));
    this.vx *= 0.6;
    this.vy *= 0.6;
    this.immune = this.spin + CAR.spinImmune;
    this.driftCharge = 0;
    return true;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }

  /**
   * input: { throttle, brake, steer(-1~1), handbrake }
   * others: 다른 차들 [{x, y, vx, vy}] — 부딪히면 밀려남
   */
  step(input, dt, track, others, raceTimeMs) {
    const S = this.spec;   // 이 차 종류의 능력치
    this.fell = null;
    this.zapHit = false;
    if (this.ghost > 0) this.ghost -= dt;
    if (this.zap > 0) this.zap -= dt;
    if (this.slide > 0) this.slide -= dt;
    // 견인 중: 제자리에서 기다림
    if (this.towT > 0) {
      this.towT -= dt;
      this.vx = this.vy = 0;
      this.drifting = false;
      this.hits.length = 0;
      return;
    }

    // 노면 (진흙·눈 더미·빙판)
    this.surface = null;
    for (const p of track.patches) if ((this.x - p.x) ** 2 + (this.y - p.y) ** 2 < p.r * p.r) this.surface = p.kind;
    const surfSpeed = this.surface === 'mud' ? 0.5 : this.surface === 'snow' ? 0.6 : this.surface === 'sand' ? 0.65 : 1;

    // 스핀 중: 조작 불가, 빙글빙글 돌며 미끄러짐
    if (this.immune > 0) this.immune -= dt;
    if (this.shield > 0) this.shield -= dt;
    const spinning = this.spin > 0;
    if (spinning) {
      this.spin -= dt;
      this.a += this.spinRate * dt;
      this.spinRate *= Math.exp(-1.2 * dt);
      input = { throttle: false, brake: false, steer: 0, handbrake: false };
    }

    const fx = Math.cos(this.a), fy = Math.sin(this.a);
    const rx = -fy, ry = fx;
    let vf = this.vx * fx + this.vy * fy;      // 앞 방향 속도
    let vr = this.vx * rx + this.vy * ry;      // 옆 방향 속도

    // 최고 속도 (부스트 중엔 더 빠르고, 잔디에선 느림)
    if (this.boost > 0) this.boost -= dt;
    // 팀 슬립스트림: 팀원 바로 뒤에 붙으면 바람을 덜 받아 최고 속도 +8%, 가속 +25%
    this.drafting = !!input.draft && !this.offroad && this.boost <= 0;
    const draftMul = this.drafting ? 1.08 : 1;
    const effMul = surfSpeed * (this.zap > 0 ? 0.55 : 1) * (input.pull ? 1.1 : 1);   // 노면·감전·자석
    const max = (this.boost > 0 ? S.boostMax : this.offroad ? S.offroadMax : S.maxSpeed * draftMul) * effMul;

    // 가속 / 브레이크 / 후진 — 최고 속도에 닿으면 더 가속하지 않음
    if (input.throttle) {
      if (vf < 0) vf += S.brake * dt;
      else if (vf < max) vf = Math.min(max, vf + S.accel * (this.drafting ? 1.25 : 1) * dt);
    }
    if (input.brake) vf -= (vf > 0 ? S.brake : S.reverse) * dt;
    if (!input.throttle && !input.brake && !spinning) vf -= Math.sign(vf) * Math.min(Math.abs(vf), S.roll * dt);
    if (vf < -220) vf = -220;
    if (this.boost > 0 && vf < max) vf = Math.min(max, vf + S.boostAccel * dt);

    // 최고 속도를 넘었으면(부스트가 끝났거나 잔디로 나감) 서서히 줄어듦
    if (vf > max) vf -= (vf - max) * Math.min(1, (this.offroad ? 4 : 2) * dt);

    // 조향: 느릴 땐 잘 안 돌고, 아주 빠르면 조금 덜 돈다
    const speedFactor = Math.min(1, Math.abs(vf) / 160) * (1 - 0.3 * Math.min(1, Math.abs(vf) / S.boostMax));
    let turn = input.steer * S.steer * speedFactor * Math.sign(vf || 1);
    if (input.handbrake) turn *= 1.3;
    const dA = turn * dt;
    this.a += dA;

    // 트랙 접지력 (눈길이면 0.7배 → 더 미끄러짐) × 빙판·눈 더미·기름
    const gm = (track.def.gripMul ?? 1)
      * (this.surface === 'ice' ? 0.25 : this.surface === 'snow' ? 0.8 : 1)
      * (this.slide > 0 ? 0.12 : 1);

    // 1) 속도를 바깥 좌표로 (차가 돌기 전 방향 기준)
    let wx = fx * vf + rx * vr, wy = fy * vf + ry * vr;
    // 2) 차 머리가 돈 만큼 속도 방향도 '일부만' 따라 돈다 (나머지는 옆미끄럼이 됨)
    //    평소엔 93% 따라가서 거의 미끄러지지 않고, Space(드리프트)면 55%만 따라가서 옆으로 흐른다
    const follow = spinning ? 0 : input.handbrake ? 0.55 : (this.offroad ? 0.75 : 0.93) * (0.6 + 0.4 * gm);
    const rot = dA * follow, cr = Math.cos(rot), sr = Math.sin(rot);
    [wx, wy] = [wx * cr - wy * sr, wx * sr + wy * cr];
    // 3) 새 방향 기준으로 다시 나눠서, 옆 성분을 접지력만큼 줄임
    //    스핀 중엔 거의 미끄러지기만 해서 속도가 어느 정도 남는다
    const nfx = Math.cos(this.a), nfy = Math.sin(this.a);
    vf = wx * nfx + wy * nfy;
    vr = -wx * nfy + wy * nfx;
    const grip = spinning ? 0.6
      : input.handbrake ? S.driftGrip * (0.5 + 0.5 * gm)
      : (this.offroad ? S.offroadGrip : S.grip) * gm;
    vr *= Math.exp(-grip * dt);
    if (input.handbrake) vf *= 1 - 0.35 * dt;

    // 드리프트 판정과 미니 터보 (스핀은 터보를 모으지 않음)
    this.drifting = spinning ? Math.hypot(vf, vr) > 60 : Math.abs(vr) > 90 && Math.abs(vf) > 180;
    if (spinning) {
      this.driftCharge = 0;
    } else if (input.handbrake && this.drifting) {
      this.driftCharge += dt * S.chargeRate;
    } else if (!input.handbrake) {
      if (this.driftCharge > 0.7) this.boost = Math.max(this.boost, Math.min(1.1, 0.35 + this.driftCharge * 0.35));
      this.driftCharge = 0;
    }

    // 새 방향 기준으로 속도 다시 합치기
    this.vx = nfx * vf + -nfy * vr;
    this.vy = nfy * vf + nfx * vr;

    // 자석: 앞 차 쪽으로 끌려감
    if (input.pull) {
      const dx = input.pull.x - this.x, dy = input.pull.y - this.y, d = Math.hypot(dx, dy) || 1;
      this.vx += (dx / d) * 340 * dt;
      this.vy += (dy / d) * 340 * dt;
    }
    // 바람: 도로 옆 방향으로 밀었다 당겼다
    const w = track.wind.length ? windAt(track, this.hint) : null;
    if (w) {
      const p = track.pts[this.hint], f = w.force * Math.sin(((raceTimeMs / 1000) * Math.PI * 2) / w.period);
      this.vx += p.nx * f * dt;
      this.vy += p.ny * f * dt;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.collideOthers(others);
    this.collideTrack(track);
    if (this.towT > 0) return;   // 방금 빠짐
    this.collideObstacles(track);
    this.checkPads(track);
    this.checkLap(track, raceTimeMs);
  }

  /** 바위·통나무(막힘), 범퍼(세게 튕김) */
  collideObstacles(track) {
    for (const o of track.obstacles) {
      const dx = this.x - o.x, dy = this.y - o.y, d = Math.hypot(dx, dy), min = o.r + 13;
      if (d >= min || d < 0.01) continue;
      const nx = dx / d, ny = dy / d;
      this.x = o.x + nx * min;
      this.y = o.y + ny * min;
      const vn = this.vx * nx + this.vy * ny;
      if (vn < 0) {
        const bounce = o.kind === 'bumper' ? 2.6 : 1.3;
        this.vx -= nx * vn * bounce;
        this.vy -= ny * vn * bounce;
        if (o.kind === 'bumper') { this.vx += nx * 160; this.vy += ny * 160; }
        else { this.vx *= 0.85; this.vy *= 0.85; }
        this.bumped = Math.max(this.bumped, -vn + (o.kind === 'bumper' ? 200 : 0));
      }
    }
  }

  collideTrack(track) {
    const near = nearest(track, this.x, this.y, this.hint);
    this.hint = near.i;
    this.lat = near.lat;
    this.offroad = Math.abs(near.lat) > track.half;

    // 용암·바다 구간: 그쪽엔 벽이 없고, 도로를 벗어나면 빠짐
    const hs = track.hazardSide[near.i];
    if (hs && Math.sign(near.lat) === hs) {
      if (Math.abs(near.lat) > track.half + 14) this.fall(track, track.hazardKind[near.i]);
      return;
    }

    // 벽: 도로 + 잔디 바깥
    const wall = track.half + SHOULDER;
    if (Math.abs(near.lat) > wall) {
      const p = track.pts[near.i];
      const side = Math.sign(near.lat);
      const over = Math.abs(near.lat) - wall;
      this.x -= p.nx * side * over;
      this.y -= p.ny * side * over;
      // 벽을 향하는 속도는 튕겨내고 전체적으로 감속
      const vn = (this.vx * p.nx + this.vy * p.ny) * side;
      if (vn > 0) {
        this.vx -= p.nx * side * vn * 1.4;
        this.vy -= p.ny * side * vn * 1.4;
        this.vx *= 0.8; this.vy *= 0.8;
        this.bumped = Math.max(this.bumped, vn);
        // 네온 시티: 전기 방벽에 감전
        if (track.zapWalls && vn > 60) { this.zap = Math.max(this.zap, 0.7); this.zapHit = true; }
      }
    }
  }

  /**
   * 다른 차와 충돌. 차 모양을 회전된 직사각형으로 보고,
   * 겹치면 내 차만 밀어낸다 (상대 차는 상대 브라우저가 똑같이 계산).
   * - 앞차를 뒤에서 그냥 박으면: 범퍼끼리 평평하게 맞닿아 내 속도가 앞차 속도로 줄어듦 → 길 막기
   * - 내 앞부분으로 상대 '뒤쪽 모서리'를 세게 박으면: this.hits 에 기록 → 상대가 스핀
   */
  collideOthers(others) {
    this.hits.length = 0;
    if (this.ghostly) return;                 // 투명 망토·견인 직후: 통과
    for (const o of others) {
      if (o.ghostly || o.ghost > 0) continue;
      const col = boxCollide(box(this), box(o));
      if (!col) continue;

      // n 은 나→상대 방향. 나를 반대로 밀어냄. 무게가 다르면 가벼운 쪽이 더 밀림
      // (상대도 자기 화면에서 똑같이 자기를 밀어내므로 둘의 몫을 합치면 2배)
      const share = Math.max(0.4, Math.min(1.6, (2 * (o.mass ?? 1)) / ((o.mass ?? 1) + this.mass)));
      const nx = -col.nx, ny = -col.ny;
      this.x += nx * col.depth * share;
      this.y += ny * col.depth * share;

      const ovx = o.vx || 0, ovy = o.vy || 0;
      const rel = (this.vx - ovx) * nx + (this.vy - ovy) * ny;   // < 0 이면 서로 다가가는 중
      if (rel < 0) {
        this.vx -= nx * rel * 1.1 * share;
        this.vy -= ny * rel * 1.1 * share;
        this.bumped = Math.max(this.bumped, -rel);
      }

      // 같은 팀은 스핀시키지 않음 (팀전)
      if (o.team != null && o.team >= 0 && o.team === this.team) continue;

      // 스핀 판정: 접촉점이 상대 차의 뒤쪽 모서리이고, 내 차의 앞부분인지
      const { cx, cy } = col;
      const ofx = Math.cos(o.a), ofy = Math.sin(o.a);
      const vlx = (cx - o.x) * ofx + (cy - o.y) * ofy;      // 상대 기준 앞(+)/뒤(-)
      const vly = (cx - o.x) * -ofy + (cy - o.y) * ofx;     // 상대 기준 옆
      const mfx = Math.cos(this.a), mfy = Math.sin(this.a);
      const mlx = (cx - this.x) * mfx + (cy - this.y) * mfy; // 내 기준 앞(+)/뒤(-)
      const closing = -rel;
      // 뒤쪽 절반(vlx<-6) + 범퍼 가운데를 벗어난 모서리 쪽(|vly|>3.5) + 내 앞부분(mlx>4) + 충분한 속도
      if (vlx < -6 && Math.abs(vly) > 3.5 && mlx > 4 && closing > CAR.spinMinSpeed)
        this.hits.push({ id: o.id, side: Math.sign(vly), power: closing, x: cx, y: cy });
    }
  }

  checkPads(track) {
    let on = false;
    for (const b of track.boosts) {
      const di = Math.min(forwardDist(track, b.i, this.hint), forwardDist(track, this.hint, b.i));
      if (di <= 4 && Math.abs(this.lat - b.lat) < 34) on = true;
    }
    if (on && !this.boostedPad) this.boost = Math.max(this.boost, 1.2);
    this.boostedPad = on;
  }

  /** 체크포인트를 순서대로 지나야 바퀴가 올라간다 (지름길·역주행 방지) */
  checkLap(track, raceTimeMs) {
    if (this.finished || Math.abs(this.lat) > track.half + SHOULDER + 10) return;
    const last = this.nextCp >= track.cps.length;
    const target = last ? track.cps[0] : track.cps[this.nextCp];
    if (forwardDist(track, target, this.hint) < 30) {
      this.cpCount++;
      if (last) {
        this.lapTimes.push(raceTimeMs - this.lapStart);
        this.lapStart = raceTimeMs;
        this.lap++;
        this.nextCp = 1;
        this.justLapped = true;
      } else {
        this.nextCp++;
      }
    }
  }

  get spinning() { return this.spin > 0; }

  /** 순위 계산용 값 (클수록 앞) */
  progress(track) {
    const last = this.nextCp >= track.cps.length;
    const target = last ? track.cps[0] : track.cps[this.nextCp];
    return this.cpCount * 100000 - forwardDist(track, this.hint, target);
  }
}
