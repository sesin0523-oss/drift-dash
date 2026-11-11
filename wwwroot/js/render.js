// 그리기: 트랙, 차, 스키드 자국, 연기, HUD, 미니맵

import { SHOULDER } from './track.js';
import { CAR } from './car.js';

export const COLORS = ['#ff5a4f', '#3d8bff', '#ffc531', '#34c77b', '#b46cff', '#ff8ad0'];

const FONT = '"Pretendard", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cam = { x: 0, y: 0, zoom: 1 };
    this.skids = [];          // [x1, y1, x2, y2, alpha]
    this.particles = [];
    this.grassPattern = null;
    this.patternTrack = -1;
    this.shake = 0;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  /** 화면 배율(레티나, 윈도우 150%/200%)에 맞춰 캔버스 해상도를 올림 → 글씨·선이 선명 */
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.dpr = dpr;
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
  }

  makeGrass(track) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const [a, b] = track.def.grass;
    g.fillStyle = a;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = b;
    for (let i = 0; i < 260; i++) g.fillRect(Math.random() * 128, Math.random() * 128, 2, 3);
    this.grassPattern = this.ctx.createPattern(c, 'repeat');
    this.patternTrack = track.index;
  }

  clearMarks() {
    this.skids.length = 0;
    this.particles.length = 0;
  }

  // ───────────────────────── 효과 ─────────────────────────

  addSkid(car, prev) {
    if (!prev) return;
    const wheels = (c) => {
      const fx = Math.cos(c.a), fy = Math.sin(c.a);
      const bx = c.x - fx * 12, by = c.y - fy * 12;
      return [[bx - fy * 8, by + fx * 8], [bx + fy * 8, by - fx * 8]];
    };
    const w0 = wheels(prev), w1 = wheels(car);
    for (let k = 0; k < 2; k++) this.skids.push([w0[k][0], w0[k][1], w1[k][0], w1[k][1]]);
    if (this.skids.length > 3000) this.skids.splice(0, this.skids.length - 3000);
  }

  puff(x, y, color, size, vx = 0, vy = 0, life = 0.6) {
    if (this.particles.length > 500) return;
    this.particles.push({ x, y, vx: vx + (Math.random() - 0.5) * 40, vy: vy + (Math.random() - 0.5) * 40, size, life, max: life, color });
  }

  /** 박았을 때 불꽃 */
  sparks(x, y, n = 14) {
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2, sp = 150 + Math.random() * 350;
      this.puff(x, y, Math.random() < 0.5 ? 'rgba(255,230,120,' : 'rgba(255,150,40,', 3 + Math.random() * 3,
        Math.cos(ang) * sp, Math.sin(ang) * sp, 0.3);
    }
  }

  updateParticles(dt) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= 0.94; p.vy *= 0.94;
      p.life -= dt;
      if (p.life <= 0) this.particles.splice(i, 1);
    }
    this.shake *= 0.85;
  }

  /** 차 상태에 따라 연기/불꽃/흙먼지 */
  emitFor(car, dt) {
    const fx = Math.cos(car.a), fy = Math.sin(car.a);
    const rx = car.x - fx * 16, ry = car.y - fy * 16;
    if (car.drifting && Math.random() < 0.7)
      this.puff(rx + (Math.random() - 0.5) * 14, ry + (Math.random() - 0.5) * 14, 'rgba(235,235,235,', 10 + Math.random() * 8);
    if ((car.boost > 0 || car.boosting) && Math.random() < 0.9)
      this.puff(rx, ry, Math.random() < 0.5 ? 'rgba(255,170,40,' : 'rgba(255,90,40,', 6 + Math.random() * 5, -fx * 200, -fy * 200, 0.25);
    if (car.offroad && car.speed > 120 && Math.random() < 0.5)
      this.puff(rx, ry, 'rgba(150,110,60,', 8 + Math.random() * 6, 0, 0, 0.5);
    if (car.driftCharge > 0.7 && Math.random() < 0.6) {
      const col = car.driftCharge > 1.5 ? 'rgba(255,150,40,' : 'rgba(90,180,255,';
      this.puff(rx + (Math.random() - 0.5) * 16, ry + (Math.random() - 0.5) * 16, col, 4, (Math.random() - 0.5) * 120, (Math.random() - 0.5) * 120, 0.25);
    }
  }

  // ───────────────────────── 월드 ─────────────────────────

  /** 카메라: 따라갈 차를 부드럽게 따라가며, 빠를수록 조금 멀리 본다 */
  follow(target, dt, snap = false) {
    const base = Math.min(this.w / 1150, this.h / 750);
    const speed = target ? Math.hypot(target.vx || 0, target.vy || 0) : 0;
    const zoom = base * (1.15 - Math.min(0.35, speed / 2400));
    const lead = 0.35;
    const tx = target ? target.x + (target.vx || 0) * lead : this.cam.x;
    const ty = target ? target.y + (target.vy || 0) * lead : this.cam.y;
    const k = snap ? 1 : 1 - Math.exp(-6 * dt);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
    this.cam.zoom += (zoom - this.cam.zoom) * (snap ? 1 : 1 - Math.exp(-3 * dt));
  }

  /** drawExtra(ctx): 차보다 아래에 그릴 것 (아이템 상자, 바나나, 미사일, 고스트 등) */
  drawWorld(track, cars, nameOf, t, drawExtra) {
    const { ctx, dpr } = this;
    if (this.patternTrack !== track.index) this.makeGrass(track);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this.grassPattern;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    const z = this.cam.zoom * dpr;
    ctx.setTransform(z, 0, 0, z, this.canvas.width / 2 - (this.cam.x + sx) * z, this.canvas.height / 2 - (this.cam.y + sy) * z);
    // 잔디 무늬도 월드와 함께 움직이게
    ctx.fillStyle = this.grassPattern;
    const b = track.bounds;
    ctx.fillRect(b.minX - 2000, b.minY - 2000, b.maxX - b.minX + 4000, b.maxY - b.minY + 4000);

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const W = track.width;
    // 타이어 방벽 → 갓길 → 연석 → 도로 순으로 굵은 선을 겹쳐 그림
    ctx.strokeStyle = '#2b2b2b';
    ctx.lineWidth = W + SHOULDER * 2 + 22;
    ctx.stroke(track.path);
    ctx.strokeStyle = '#f2f2f2';
    ctx.setLineDash([18, 18]);
    ctx.lineWidth = W + SHOULDER * 2 + 22;
    ctx.globalAlpha = 0.35;
    ctx.stroke(track.path);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.strokeStyle = track.def.grass[0];
    ctx.lineWidth = W + SHOULDER * 2;
    ctx.stroke(track.path);

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = W + 18;
    ctx.stroke(track.path);
    ctx.strokeStyle = '#e8413a';
    ctx.setLineDash([26, 26]);
    ctx.stroke(track.path);
    ctx.setLineDash([]);

    ctx.strokeStyle = '#4a4d55';
    ctx.lineWidth = W;
    ctx.stroke(track.path);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.setLineDash([30, 40]);
    ctx.stroke(track.path);
    ctx.setLineDash([]);

    this.drawStartLine(track);
    this.drawBoosts(track, t);

    // 스키드 자국
    ctx.strokeStyle = 'rgba(20,20,20,0.28)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    for (const s of this.skids) { ctx.moveTo(s[0], s[1]); ctx.lineTo(s[2], s[3]); }
    ctx.stroke();

    // 연기 (차 아래)
    for (const p of this.particles) {
      const a = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color + (a * 0.55).toFixed(3) + ')';
      const r = p.size * (1.6 - a * 0.6);
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    drawExtra?.(ctx);

    for (const c of cars) this.drawCar(c, COLORS[c.color % COLORS.length]);

    // 보호막
    for (const c of cars) {
      if (!c.shielded) continue;
      const r = 30 + Math.sin(t * 8) * 2;
      ctx.fillStyle = 'rgba(90,170,255,0.18)';
      ctx.strokeStyle = 'rgba(140,200,255,0.9)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // 스핀 중인 차 위에 빙글빙글 도는 별
    for (const c of cars) {
      if (!c.spinning) continue;
      for (let k = 0; k < 3; k++) {
        const ang = t * 7 + (k * Math.PI * 2) / 3;
        this.star(c.x + Math.cos(ang) * 22, c.y - 6 + Math.sin(ang) * 9, 6);
      }
    }

    ctx.font = `bold 13px ${FONT}`;
    ctx.textAlign = 'center';
    for (const c of cars) {
      const name = nameOf(c);
      if (!name) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      const w = ctx.measureText(name).width + 12;
      ctx.beginPath();
      ctx.roundRect(c.x - w / 2, c.y - 44, w, 20, 10);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(name, c.x, c.y - 29);
    }
  }

  star(x, y, r) {
    const { ctx } = this;
    ctx.fillStyle = '#ffe14d';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 ? r * 0.45 : r, a = -Math.PI / 2 + (i * Math.PI) / 5;
      ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  drawStartLine(track) {
    const { ctx } = this;
    const p = track.pts[0];
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(Math.atan2(p.ty, p.tx));
    const half = track.half, cell = 10;
    for (let row = 0; row < 2; row++)
      for (let k = -half; k < half; k += cell) {
        ctx.fillStyle = ((k / cell + row) & 1) ? '#111' : '#fff';
        ctx.fillRect(row * cell - cell, k, cell, cell);
      }
    ctx.restore();
  }

  drawBoosts(track, t) {
    const { ctx } = this;
    for (const b of track.boosts) {
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = 'rgba(255,200,40,0.25)';
      ctx.beginPath();
      ctx.roundRect(-30, -26, 60, 52, 8);
      ctx.fill();
      for (let k = 0; k < 3; k++) {
        const phase = ((t * 2.5 + k / 3) % 1);
        ctx.fillStyle = `rgba(255,${180 + phase * 60},40,${0.4 + 0.6 * (1 - phase)})`;
        const x = -22 + k * 16;
        ctx.beginPath();
        ctx.moveTo(x, -18); ctx.lineTo(x + 12, 0); ctx.lineTo(x, 18);
        ctx.lineTo(x + 6, 18); ctx.lineTo(x + 18, 0); ctx.lineTo(x + 6, -18);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  drawCar(c, color) {
    const { ctx } = this;
    const L = CAR.length, Wd = CAR.width;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.a);
    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.roundRect(-L / 2 + 3, -Wd / 2 + 4, L, Wd, 6);
    ctx.fill();
    // 바퀴
    ctx.fillStyle = '#151515';
    for (const [x, y] of [[-12, -11], [-12, 11], [11, -11], [11, 11]]) ctx.fillRect(x - 5, y - 3, 10, 6);
    // 차체
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect(-L / 2, -Wd / 2, L, Wd, 6);
    ctx.fill();
    // 줄무늬
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(-L / 2 + 2, -2.5, L - 4, 5);
    // 앞유리 / 뒷유리
    ctx.fillStyle = 'rgba(25,35,55,0.85)';
    ctx.beginPath();
    ctx.roundRect(2, -Wd / 2 + 3, 8, Wd - 6, 2);
    ctx.fill();
    ctx.fillRect(-12, -Wd / 2 + 4, 4, Wd - 8);
    // 헤드라이트
    ctx.fillStyle = '#fff6c4';
    ctx.fillRect(L / 2 - 3, -Wd / 2 + 2, 3, 4);
    ctx.fillRect(L / 2 - 3, Wd / 2 - 6, 3, 4);
    ctx.restore();
  }

  // ───────────────────────── 화면 고정 UI ─────────────────────────

  beginScreen() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  text(str, x, y, size, color = '#fff', align = 'left', weight = 'bold') {
    const { ctx } = this;
    ctx.font = `${weight} ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.textBaseline = 'alphabetic';
    ctx.lineWidth = Math.max(3, size / 7);
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeText(str, x, y);
    ctx.fillStyle = color;
    ctx.fillText(str, x, y);
  }

  minimap(track, cars, meId) {
    const { ctx } = this;
    const size = Math.min(190, this.w * 0.24);
    const b = track.bounds, bw = b.maxX - b.minX, bh = b.maxY - b.minY;
    const s = size / Math.max(bw, bh);
    const ox = this.w - size - 16, oy = 16;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.roundRect(ox - 8, oy - 8, bw * s + 16, bh * s + 16, 12);
    ctx.fill();
    ctx.save();
    ctx.translate(ox - b.minX * s, oy - b.minY * s);
    ctx.scale(s, s);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = track.width * 0.6;
    ctx.stroke(track.path);
    for (const c of cars) {
      ctx.fillStyle = COLORS[c.color % COLORS.length];
      ctx.strokeStyle = c.id === meId ? '#fff' : 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2 / s;
      ctx.beginPath();
      ctx.arc(c.x, c.y, (c.id === meId ? 9 : 7) / s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
    return oy + bh * s + 8;   // 미니맵 아래쪽 y (그 밑에 다른 정보 표시용)
  }
}

export function fmtTime(ms) {
  if (ms == null || ms < 0) return '-:--.---';
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, x = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(x).padStart(3, '0')}`;
}
