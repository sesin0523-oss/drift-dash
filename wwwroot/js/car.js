// 아케이드 자동차 물리 + 바퀴/체크포인트 계산.
// 속도를 "앞 방향 성분"과 "옆 방향 성분"으로 나눠서,
// 옆 성분을 빨리 없애면 접지력이 좋은 차, 천천히 없애면 미끄러지는(드리프트) 차가 된다.

import { nearest, forwardDist, gridSlot, SHOULDER } from './track.js';

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
};

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
  constructor(track, slot) {
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
  }

  get shielded() { return this.shield > 0; }

  /** 상대가 내 뒤 모서리를 박았을 때. side: 맞은 쪽(-1/1), power: 박은 속도 */
  applySpin(side, power) {
    if (this.spin > 0 || this.immune > 0 || this.finished) return false;
    if (this.shield > 0) {           // 보호막이 한 번 막아 줌
      this.shield = 0;
      this.shieldPopped = true;
      this.immune = 0.8;
      return false;
    }
    this.spin = 0.9 + Math.min(0.5, power / 1000);
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
    const max = this.boost > 0 ? CAR.boostMax : this.offroad ? CAR.offroadMax : CAR.maxSpeed;

    // 가속 / 브레이크 / 후진 — 최고 속도에 닿으면 더 가속하지 않음
    if (input.throttle) {
      if (vf < 0) vf += CAR.brake * dt;
      else if (vf < max) vf = Math.min(max, vf + CAR.accel * dt);
    }
    if (input.brake) vf -= (vf > 0 ? CAR.brake : CAR.reverse) * dt;
    if (!input.throttle && !input.brake && !spinning) vf -= Math.sign(vf) * Math.min(Math.abs(vf), CAR.roll * dt);
    if (vf < -220) vf = -220;
    if (this.boost > 0 && vf < max) vf = Math.min(max, vf + CAR.boostAccel * dt);

    // 최고 속도를 넘었으면(부스트가 끝났거나 잔디로 나감) 서서히 줄어듦
    if (vf > max) vf -= (vf - max) * Math.min(1, (this.offroad ? 4 : 2) * dt);

    // 조향: 느릴 땐 잘 안 돌고, 아주 빠르면 조금 덜 돈다
    const speedFactor = Math.min(1, Math.abs(vf) / 160) * (1 - 0.3 * Math.min(1, Math.abs(vf) / CAR.boostMax));
    let turn = input.steer * CAR.steer * speedFactor * Math.sign(vf || 1);
    if (input.handbrake) turn *= 1.3;
    this.a += turn * dt;

    // 옆미끄럼 줄이기 (접지력)
    // 스핀 중엔 거의 미끄러지기만 해서 속도가 어느 정도 남는다
    const grip = spinning ? 0.6 : input.handbrake ? CAR.driftGrip : this.offroad ? CAR.offroadGrip : CAR.grip;
    vr *= Math.exp(-grip * dt);
    if (input.handbrake) vf *= 1 - 0.35 * dt;

    // 드리프트 판정과 미니 터보 (스핀은 터보를 모으지 않음)
    this.drifting = spinning ? Math.hypot(vf, vr) > 60 : Math.abs(vr) > 90 && Math.abs(vf) > 180;
    if (spinning) {
      this.driftCharge = 0;
    } else if (input.handbrake && this.drifting) {
      this.driftCharge += dt;
    } else if (!input.handbrake) {
      if (this.driftCharge > 0.7) this.boost = Math.max(this.boost, Math.min(1.1, 0.35 + this.driftCharge * 0.35));
      this.driftCharge = 0;
    }

    // 새 방향 기준으로 속도 다시 합치기 (차가 '돌면서 나아가는' 느낌)
    const nfx = Math.cos(this.a), nfy = Math.sin(this.a);
    this.vx = nfx * vf + -nfy * vr;
    this.vy = nfy * vf + nfx * vr;

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    this.collideOthers(others);
    this.collideTrack(track);
    this.checkPads(track);
    this.checkLap(track, raceTimeMs);
  }

  collideTrack(track) {
    const near = nearest(track, this.x, this.y, this.hint);
    this.hint = near.i;
    this.lat = near.lat;
    this.offroad = Math.abs(near.lat) > track.half;

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
    for (const o of others) {
      const col = boxCollide(box(this), box(o));
      if (!col) continue;

      // n 은 나→상대 방향. 나를 반대로 밀어냄
      const nx = -col.nx, ny = -col.ny;
      this.x += nx * col.depth;
      this.y += ny * col.depth;

      const ovx = o.vx || 0, ovy = o.vy || 0;
      const rel = (this.vx - ovx) * nx + (this.vy - ovy) * ny;   // < 0 이면 서로 다가가는 중
      if (rel < 0) {
        this.vx -= nx * rel * 1.1;
        this.vy -= ny * rel * 1.1;
        this.bumped = Math.max(this.bumped, -rel);
      }

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
