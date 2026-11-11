// 서버와 WebSocket 통신 + 서버 시계 맞추기 + 상대 차 위치 보간

export class Net {
  constructor() {
    this.handlers = {};
    this.offset = 0;          // 서버시각 - 내시각 (ms)
    this.bestRtt = Infinity;
    this.rtt = 0;
    this.ws = null;
    this.open = false;
  }

  on(type, fn) { this.handlers[type] = fn; }

  connect(room, name) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws.onopen = () => {
      this.open = true;
      this.send({ t: 'join', room, name });
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 2000);
    };
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === 'pong') return this.onPong(m);
      this.handlers[m.t]?.(m);
    };
    this.ws.onclose = () => {
      this.open = false;
      clearInterval(this.pingTimer);
      this.handlers.close?.();
    };
  }

  send(obj) {
    if (this.open) this.ws.send(JSON.stringify(obj));
  }

  ping() { this.send({ t: 'ping', c: performance.now() }); }

  onPong(m) {
    const now = performance.now();
    const rtt = now - m.c;
    this.rtt = this.rtt ? this.rtt * 0.7 + rtt * 0.3 : rtt;
    // 왕복이 가장 짧았던 측정이 가장 정확 → 그걸로 시계 차이를 정함
    if (rtt <= this.bestRtt * 1.2) {
      this.bestRtt = Math.min(this.bestRtt, rtt);
      const est = m.s - (Date.now() - rtt / 2);
      this.offset = this.offset ? this.offset * 0.5 + est * 0.5 : est;
    }
  }

  /** 서버 기준 현재 시각 (ms) */
  serverNow() { return Date.now() + this.offset; }
}

/**
 * 상대 차 한 대.
 * 1) 받은 상태를 시각과 함께 모아 두고 "100ms 전" 시점을 앞뒤 두 상태 사이에서 섞는다 (끊김 방지)
 * 2) 그 위치에서 속도·회전 속도로 100ms 만큼 앞으로 밀어 "지금 이 순간" 위치를 추정한다
 *    → 앞에서 길을 막거나 뒤를 박을 때, 내 화면의 상대 위치가 실제와 거의 같아진다
 * 3) 추정 위치로 바로 점프하지 않고 부드럽게 따라가서 떨림을 줄인다
 */
export class RemoteCar {
  static DELAY = 100;

  constructor(id) {
    this.id = id;
    this.buf = [];
    this.x = 0; this.y = 0; this.a = 0; this.vx = 0; this.vy = 0;
    this.drifting = false; this.boosting = false; this.spinning = false;
    this.prog = 0; this.lap = 1; this.finished = false;
    this.visible = false;
    this.placed = false;
  }

  push(m) {
    if (this.buf.length && m.ts <= this.buf[this.buf.length - 1].ts) return;
    this.buf.push(m);
    if (this.buf.length > 40) this.buf.shift();
    this.prog = m.p; this.lap = m.lap; this.finished = !!m.fin;
  }

  update(serverNow) {
    const b = this.buf;
    if (!b.length) return;
    this.visible = true;
    const t = serverNow - RemoteCar.DELAY;

    let i = b.length - 1;
    while (i > 0 && b[i - 1].ts > t) i--;
    const s1 = b[i], s0 = b[i - 1];

    let x, y, a, w = 0, vx, vy, src;
    if (s0 && s0.ts <= t && t <= s1.ts) {
      const k = (t - s0.ts) / (s1.ts - s0.ts || 1);
      let da = s1.a - s0.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));      // 짧은 쪽으로 회전
      x = s0.x + (s1.x - s0.x) * k;
      y = s0.y + (s1.y - s0.y) * k;
      a = s0.a + da * k;
      w = da / Math.max(0.016, (s1.ts - s0.ts) / 1000);   // 회전 속도
      vx = s1.vx; vy = s1.vy; src = s1;
    } else {
      // 최신 상태보다 시간이 앞이면 그 상태에서 출발
      const last = b[b.length - 1];
      const ahead = Math.min(200, Math.max(0, t - last.ts)) / 1000;
      x = last.x + last.vx * ahead;
      y = last.y + last.vy * ahead;
      a = last.a; vx = last.vx; vy = last.vy; src = last;
    }

    // "100ms 전" → "지금" 으로 앞당기기 (회전 속도는 과하게 튀지 않게 제한)
    const lead = RemoteCar.DELAY / 1000;
    w = Math.max(-12, Math.min(12, w));
    const ex = x + vx * lead, ey = y + vy * lead, ea = a + w * lead;

    if (!this.placed || Math.hypot(ex - this.x, ey - this.y) > 150) {
      this.x = ex; this.y = ey; this.a = ea;
      this.placed = true;
    } else {
      const k = 0.35;
      this.x += (ex - this.x) * k;
      this.y += (ey - this.y) * k;
      let da = ea - this.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      this.a += da * k;
    }
    this.vx = vx; this.vy = vy;
    this.drifting = src.d; this.boosting = src.b; this.spinning = !!src.sp; this.shielded = !!src.sh; this.ghostly = !!src.gh; this.towingRemote = !!src.tw; this.zapped = !!src.zp;
  }

  get speed() { return Math.hypot(this.vx, this.vy); }
}
