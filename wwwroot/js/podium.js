// 시상식: 1·2·3등 단상 위에 차가 차례로 내려앉고, 1등에게 왕관과 꽃가루.
// 화면(캔버스) 좌표로 그린다. data = { title, subtitle, color, places: [{name, color, type, sub}], others }

const BLOCK = [
  { h: 165, top: '#ffe27a', bottom: '#d9a520', label: '1' },   // 금
  { h: 120, top: '#eef1f6', bottom: '#a9b1bf', label: '2' },   // 은
  { h: 90, top: '#f0b48a', bottom: '#b06b3f', label: '3' },    // 동
];
const LAND_AT = [2.2, 1.6, 1.0];       // 3등 → 2등 → 1등 순서로 착지 (초)
const CONFETTI = ['#ff5a4f', '#ffc531', '#34c77b', '#3d8bff', '#b46cff', '#ffffff'];

const easeOutBack = (x) => { const c = 1.7; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
const easeOutBounce = (x) => {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
};

export class Podium {
  /** hooks: { land(place) } — 차가 단상에 닿을 때 (소리 내기용) */
  constructor(data, hooks = {}) {
    this.data = data;
    this.hooks = hooks;
    this.start = performance.now();
    this.landed = [false, false, false];
    this.confetti = [];
    this.last = this.start;
  }

  get elapsed() { return (performance.now() - this.start) / 1000; }

  draw(R) {
    const ctx = R.ctx, W = R.w, H = R.h;
    const now = performance.now(), t = (now - this.start) / 1000;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    R.beginScreen();

    // 배경: 어두운 무대 + 위에서 내려오는 조명
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#1c1430');
    bg.addColorStop(1, '#07070d');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const s = Math.max(0.55, Math.min(1.25, W / 900, H / 620));
    const floorY = H * 0.8;
    const gap = 14 * s, bw = 150 * s;
    const xs = [W / 2, W / 2 - bw - gap, W / 2 + bw + gap];   // 1등 가운데, 2등 왼쪽, 3등 오른쪽
    const places = this.data.places.slice(0, 3);

    // 조명
    places.forEach((p, i) => {
      if (t < LAND_AT[i] - 0.3) return;
      const a = Math.min(1, (t - LAND_AT[i] + 0.3) * 2) * (i === 0 ? 0.28 : 0.16);
      const g = ctx.createLinearGradient(0, 0, 0, floorY);
      g.addColorStop(0, `rgba(255,240,200,${a})`);
      g.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(xs[i] - 30 * s, 0);
      ctx.lineTo(xs[i] + 30 * s, 0);
      ctx.lineTo(xs[i] + bw * 0.75, floorY);
      ctx.lineTo(xs[i] - bw * 0.75, floorY);
      ctx.closePath();
      ctx.fill();
    });

    // 바닥
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(0, floorY, W, H - floorY);

    // 단상 (아래에서 솟아오름)
    places.forEach((p, i) => {
      const k = Math.min(1, Math.max(0, (t - 0.15 * i) / 0.6));
      const h = BLOCK[i].h * s * easeOutBack(k);
      const x = xs[i] - bw / 2, y = floorY - h;
      const g = ctx.createLinearGradient(0, y, 0, floorY);
      g.addColorStop(0, BLOCK[i].top);
      g.addColorStop(1, BLOCK[i].bottom);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, h + 2, [10 * s, 10 * s, 0, 0]);
      ctx.fill();
      if (k > 0.6) {
        // 숫자는 단상 위쪽, 기록은 그 바로 아래 (가장 낮은 3등 단상에도 들어가게)
        R.text(BLOCK[i].label, xs[i], y + 48 * s, 44 * s, 'rgba(60,40,10,0.55)', 'center', '900');
        if (p.sub) R.text(p.sub, xs[i], y + 74 * s, 14 * s, '#ffffff', 'center', '800');
      }
    });

    // 차: 위에서 떨어져 통통 튀며 착지
    places.forEach((p, i) => {
      const k = (t - (LAND_AT[i] - 0.7)) / 0.7;
      if (k <= 0) return;
      const topY = floorY - BLOCK[i].h * s;
      const restY = topY - 26 * s;
      const y = k >= 1 ? restY : -60 + (restY + 60) * easeOutBounce(k);
      if (k >= 1 && !this.landed[i]) {
        this.landed[i] = true;
        this.hooks.land?.(i);
        if (i === 0) this.burst(xs[0], restY - 30 * s, 140);
      }
      ctx.save();
      ctx.translate(xs[i], y);
      ctx.scale(2.3 * s, 2.3 * s);
      R.drawCar({ x: 0, y: 0, a: -Math.PI / 2, type: p.type }, p.color);
      ctx.restore();

      if (k >= 1) {
        // 이름 (1등은 크게) + 1등 왕관
        const nameY = restY - (i === 0 ? 72 : 58) * s;
        R.text(p.name, xs[i], nameY, (i === 0 ? 24 : 18) * s, '#ffffff', 'center', '800');
        if (i === 0) this.crown(ctx, xs[0], nameY - 34 * s, s, t);
      }
    });

    // 제목: 1등이 착지한 뒤 크게 튀어나옴
    const tk = Math.min(1, Math.max(0, (t - LAND_AT[0] - 0.1) / 0.45));
    if (tk > 0) {
      const size = (46 * s) * (0.6 + 0.4 * easeOutBack(tk));
      R.text(this.data.title, W / 2, H * 0.14 + 10 * s, size, this.data.color ?? '#ffc531', 'center', '900');
      if (this.data.subtitle) R.text(this.data.subtitle, W / 2, H * 0.14 + 44 * s, 17 * s, '#e6e2f2', 'center', '700');
    }
    if (this.data.others && t > LAND_AT[0] + 0.5)
      R.text(this.data.others, W / 2, floorY + 40 * s, 15 * s, '#c9c6d6', 'center', '600');

    // 꽃가루
    if (t > LAND_AT[0] && t < LAND_AT[0] + 4 && Math.random() < 0.6) this.rain(W);
    this.drawConfetti(ctx, dt, H);

    if (t > 3 && Math.floor(t * 2) % 2 === 0)
      R.text('화면을 누르면 결과 보기', W / 2, H - 18, 14 * s, 'rgba(255,255,255,0.75)', 'center', '600');
  }

  crown(ctx, x, y, s, t) {
    ctx.save();
    ctx.translate(x, y + Math.sin(t * 3) * 3 * s);
    ctx.scale(s, s);
    ctx.fillStyle = '#ffd43b';
    ctx.strokeStyle = '#a5760a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-22, 12); ctx.lineTo(-24, -10); ctx.lineTo(-11, 2); ctx.lineTo(0, -16);
    ctx.lineTo(11, 2); ctx.lineTo(24, -10); ctx.lineTo(22, 12); ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#ff5a4f';
    for (const cx of [-12, 0, 12]) { ctx.beginPath(); ctx.arc(cx, 6, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  burst(x, y, n) {
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.4, sp = 250 + Math.random() * 450;
      this.confetti.push(this.piece(x, y, Math.cos(a) * sp, Math.sin(a) * sp));
    }
  }

  rain(W) {
    this.confetti.push(this.piece(Math.random() * W, -10, (Math.random() - 0.5) * 60, 80 + Math.random() * 80));
  }

  piece(x, y, vx, vy) {
    return { x, y, vx, vy, r: Math.random() * 6, vr: (Math.random() - 0.5) * 12,
             w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, c: CONFETTI[Math.floor(Math.random() * CONFETTI.length)] };
  }

  drawConfetti(ctx, dt, H) {
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const p = this.confetti[i];
      p.vy += 420 * dt;
      p.vx *= 0.99; p.vy = Math.min(p.vy, 260);
      p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      if (p.y > H + 20) { this.confetti.splice(i, 1); continue; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.r);
      ctx.scale(1, Math.abs(Math.cos(p.r * 1.7)) + 0.2);   // 팔랑팔랑
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
  }
}
