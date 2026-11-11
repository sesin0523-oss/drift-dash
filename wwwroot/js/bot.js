// AI 봇 운전사. 방장 브라우저에서만 돌고, 결과(위치)는 일반 플레이어처럼 서버로 보낸다.
//
// 운전 방법
// 1) 도로 중심선에서 속도에 비례한 만큼 앞쪽 점을 목표로 핸들을 꺾는다 (pure pursuit)
// 2) 더 먼 앞의 도로가 얼마나 꺾이는지(곡률) 보고, 급커브면 미리 속도를 줄인다
// 3) 바로 앞에 차가 있으면 차선을 옮겨 추월을 시도한다
// 4) 벽에 끼어 멈추면 잠깐 후진해서 빠져나온다
// 5) 아이템전이면 상황을 보고 아이템을 쓴다

import { Car } from './car.js';
import { forwardDist } from './track.js';

export const BOT_LEVELS = [
  { name: '쉬움', speed: 0.84, corner: 1.0, noise: 0.25, drift: false, itemDelay: 2.0 },
  { name: '보통', speed: 0.93, corner: 1.25, noise: 0.1, drift: false, itemDelay: 1.0 },
  { name: '어려움', speed: 1.0, corner: 1.5, noise: 0.02, drift: true, itemDelay: 0.4 },
];

export class Bot {
  constructor(info, track, slot) {
    this.id = info.id;
    this.level = BOT_LEVELS[info.level] ?? BOT_LEVELS[1];
    this.car = new Car(track, slot, info.car);
    this.car.id = info.id;
    this.track = track;
    this.lane = (Math.random() - 0.5) * 0.3;     // 도로 폭 대비 옆 위치 (-0.5 ~ 0.5)
    this.laneTimer = 1 + Math.random() * 2;
    this.noise = 0;
    this.stuckTime = 0;
    this.reverseTime = 0;
    this.driftHold = 0;
    this.itemWait = 0;
    this.itemHeld = 0;
    this.items = null;          // 아이템전이면 main 에서 붙여 줌
    this.sendTick = Math.floor(Math.random() * 3);
    this.hitCooldown = new Map();
  }

  /**
   * 이번 프레임 입력을 정한다.
   * others: 다른 차들 [{x, y, a, vx, vy, id, team}]
   * ctx: { canDrive, behindClose(같은편 제외), aheadId, incomingMissile }
   */
  think(dt, others) {
    const car = this.car, tr = this.track, L = this.level, S = car.spec;
    const speed = car.speed;

    // 벽에 끼었으면 후진
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      return { throttle: false, brake: true, steer: -this.lastSteer || 0.6, handbrake: false };
    }
    this.stuckTime = speed < 40 ? this.stuckTime + dt : 0;
    // 3초마다 앞으로 얼마나 갔는지 확인 (벽이나 차에 비비며 제자리걸음하는 경우)
    this.progressTimer = (this.progressTimer ?? 0) + dt;
    if (this.progressTimer > 3) {
      if (this.lastHint != null && forwardDist(tr, this.lastHint, car.hint) < 25 && car.spin <= 0) this.stuckTime = 99;
      this.lastHint = car.hint;
      this.progressTimer = 0;
    }
    if (this.stuckTime > 1.3) {
      this.stuckTime = 0;
      this.reverseTime = 0.9;
      this.lane = -this.lane;
    }

    // 차선: 가끔 바꾸고, 앞에 차가 막고 있으면 반대쪽으로
    this.laneTimer -= dt;
    if (this.laneTimer <= 0) {
      this.laneTimer = 2 + Math.random() * 3;
      this.lane = (Math.random() - 0.5) * 0.5;
    }
    const fx = Math.cos(car.a), fy = Math.sin(car.a);
    for (const o of others) {
      const dx = o.x - car.x, dy = o.y - car.y;
      const along = dx * fx + dy * fy, side = dx * -fy + dy * fx;
      if (along > 0 && along < 110 && Math.abs(side) < 26 && speed > 150) {
        this.lane = side > 0 ? -0.3 : 0.3;     // 상대 반대쪽으로 비켜 추월
        this.laneTimer = 1.5;
      }
    }

    // 목표 지점: 빠를수록 멀리 본다
    const look = Math.round(16 + speed / 45);
    const p = tr.pts[(car.hint + look) % tr.n];
    const tx = p.x + p.nx * this.lane * tr.width, ty = p.y + p.ny * this.lane * tr.width;
    let da = Math.atan2(ty - car.y, tx - car.x) - car.a;
    da = Math.atan2(Math.sin(da), Math.cos(da));

    // 실수(흔들림): 쉬운 봇일수록 크다
    this.noise += (Math.random() - 0.5) * L.noise * 3 * dt * 10;
    this.noise *= 0.92;
    const steer = Math.max(-1, Math.min(1, da * 2.8 + this.noise));
    this.lastSteer = steer;

    // 앞의 커브가 얼마나 급한지 → 그에 맞는 속도
    const a0 = tr.pts[car.hint], a1 = tr.pts[(car.hint + 45 + Math.round(speed / 20)) % tr.n];
    let curve = Math.atan2(a1.ty, a1.tx) - Math.atan2(a0.ty, a0.tx);
    curve = Math.abs(Math.atan2(Math.sin(curve), Math.cos(curve)));
    const top = S.maxSpeed * L.speed;
    const limit = top * (1 - Math.min(0.5, (curve * 0.6) / L.corner));

    let throttle = speed < limit && Math.abs(da) < 1.2;
    let brake = speed > limit + 70;
    let handbrake = false;

    // 어려운 봇: 급커브에서 드리프트 → 놓으면 미니 터보
    // (도로가 좁은 트랙에서는 미끄러지면 벽에 부딪히므로 드리프트 안 함)
    if (L.drift && tr.width >= 145 && curve > 0.55 && speed > 380 && !brake) {
      this.driftHold = 0.9;
    }
    if (this.driftHold > 0) {
      this.driftHold -= dt;
      handbrake = this.driftHold > 0;
      throttle = true;
      brake = false;
    }

    return { throttle, brake, steer, handbrake, curve };
  }

  /**
   * 아이템 쓰기 판단 (아이템전). 쥐고 있는 시간이 길어지면 그냥 쓴다.
   * info: { behindClose, aheadId, incomingMissile, curve }
   */
  thinkItem(dt, now, info) {
    const it = this.items;
    if (!it || !it.slot) { this.itemHeld = 0; return; }
    this.itemHeld += dt;
    if (this.itemHeld < this.level.itemDelay) return;

    const k = it.slot;
    const use =
      (k === 'banana' && (info.behindClose || this.itemHeld > 5)) ||
      (k === 'missile' && info.aheadId) ||
      (k === 'shield' && (info.incomingMissile || this.itemHeld > 7)) ||
      (k === 'boost' && (info.curve ?? 1) < 0.25);
    if (use || this.itemHeld > 9) {
      it.use(this.car, now, info.aheadId);
      this.itemHeld = 0;
    }
  }
}
