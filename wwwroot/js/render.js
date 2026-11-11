// 그리기: 트랙, 차, 스키드 자국, 연기, HUD, 미니맵

import { SHOULDER } from './track.js';
import { CAR } from './car.js';
import { drawCarArt, PRESET_LOOKS } from './carart.js';

export const COLORS = ['#ff5a4f', '#3d8bff', '#ffc531', '#34c77b', '#b46cff', '#ff8ad0',
                       '#ff9a3d', '#2fd0d0', '#9be15d', '#f5f5f5', '#8a8fff', '#c4a27a'];
export const TEAM_COLORS = ['#ff4b4b', '#3d8bff'];
const forwardIdx = (track, a, b) => (b - a + track.n) % track.n;
export const TEAM_NAMES = ['레드', '블루'];

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
    if (car.drafting && Math.random() < 0.6) {   // 슬립스트림: 차 옆으로 지나가는 바람 줄기
      const side = Math.random() < 0.5 ? -1 : 1;
      this.puff(car.x + fx * 10 - fy * 14 * side, car.y + fy * 10 + fx * 14 * side, 'rgba(210,235,255,', 2.5,
        -fx * 420, -fy * 420, 0.22);
    }
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
    if (track.zapWalls) {
      // 네온 시티: 번쩍이는 전기 방벽
      const glow = 0.55 + 0.45 * Math.sin(t * 6);
      ctx.strokeStyle = '#11131a';
      ctx.lineWidth = W + SHOULDER * 2 + 26;
      ctx.stroke(track.path);
      ctx.strokeStyle = `rgba(0,229,255,${0.5 + 0.4 * glow})`;
      ctx.setLineDash([22, 10]);
      ctx.lineWidth = W + SHOULDER * 2 + 22;
      ctx.stroke(track.path);
      ctx.strokeStyle = `rgba(255,60,200,${0.35 + 0.35 * (1 - glow)})`;
      ctx.lineDashOffset = 16;
      ctx.stroke(track.path);
      ctx.lineDashOffset = 0;
      ctx.setLineDash([]);
    } else {
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
    }
    ctx.strokeStyle = track.def.grass[0];
    ctx.lineWidth = W + SHOULDER * 2;
    ctx.stroke(track.path);

    // 용암·바다 (그 구간엔 벽이 없음)
    for (const h of track.hazards) this.drawHazard(h, t);

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
    this.drawPatches(track, t);
    this.drawWind(track, t);
    this.drawObstacles(track, t);

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

    // 팀전: 차 밑에 팀 색 원판
    for (const c of cars) {
      if (!c.teamColor) continue;
      ctx.fillStyle = c.teamColor + '55';
      ctx.strokeStyle = c.teamColor;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 27, 27, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    for (const c of cars) {
      // 투명 망토는 반투명, 견인 중엔 깜빡임
      const towing = c.towing || c.towingRemote;
      const ghostly = c.ghostly || c.ghost > 0;
      if (towing) ctx.globalAlpha = Math.floor(t * 8) % 2 ? 0.15 : 0.55;
      else if (ghostly) ctx.globalAlpha = 0.35;
      this.drawCar(c, COLORS[c.color % COLORS.length]);
      ctx.globalAlpha = 1;
      // 감전: 차 주위로 번개
      if (c.zap > 0 || c.zapped) {
        ctx.strokeStyle = Math.random() < 0.5 ? '#fff36b' : '#8fe8ff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let k = 0; k < 3; k++) {
          let a = Math.random() * Math.PI * 2, r = 14;
          ctx.moveTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r);
          for (let s = 0; s < 3; s++) { a += (Math.random() - 0.5) * 1.2; r += 7; ctx.lineTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r); }
        }
        ctx.stroke();
      }
    }

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
      ctx.fillStyle = c.teamColor ? c.teamColor + 'cc' : 'rgba(0,0,0,0.45)';   // 팀전이면 팀 색 이름표
      const w = ctx.measureText(name).width + 12;
      ctx.beginPath();
      ctx.roundRect(c.x - w / 2, c.y - 44, w, 20, 10);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(name, c.x, c.y - 29);
    }
  }

  // ───────────────────────── 트랙 특색 그리기 ─────────────────────────

  drawHazard(h, t) {
    const { ctx } = this;
    ctx.save();
    ctx.clip(h.shape);
    if (h.kind === 'lava') {
      ctx.fillStyle = '#7a1606';
      ctx.fill(h.shape);
      // 출렁이는 용암 무늬
      const g = ctx.createLinearGradient(0, 0, 400, 400);
      const k = (t * 0.25) % 1;
      g.addColorStop(0, '#ff4d00');
      g.addColorStop((k + 0.33) % 1, '#ffb000');
      g.addColorStop(1, '#ff2a00');
      ctx.globalAlpha = 0.55 + 0.25 * Math.sin(t * 3);
      ctx.fillStyle = g;
      ctx.fill(h.shape);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 10;
      ctx.strokeStyle = 'rgba(255,220,120,0.6)';
      ctx.setLineDash([6, 30]);
      ctx.lineDashOffset = -t * 40;
      ctx.stroke(h.shape);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    } else if (h.kind === 'cliff') {
      // 낭떠러지: 아래로 갈수록 어두워지는 골짜기 + 가장자리 바위선
      ctx.fillStyle = '#1b1a1f';
      ctx.fill(h.shape);
      ctx.lineWidth = 26;
      ctx.strokeStyle = 'rgba(90,85,80,0.9)';
      ctx.stroke(h.shape);
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.setLineDash([4, 18]);
      ctx.stroke(h.shape);
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = '#1e6fa8';
      ctx.fill(h.shape);
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.setLineDash([20, 26]);
      ctx.lineDashOffset = -t * 30;
      ctx.stroke(h.shape);
      ctx.setLineDash([]);
      ctx.lineDashOffset = 0;
    }
    ctx.restore();
  }

  drawPatches(track, t) {
    const { ctx } = this;
    for (const p of track.patches) {
      ctx.save();
      ctx.translate(p.x, p.y);
      if (p.kind === 'ice') {
        ctx.fillStyle = 'rgba(190,235,255,0.75)';
        ctx.beginPath(); ctx.ellipse(0, 0, p.r * 1.25, p.r * 0.85, p.a, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(-p.r * 0.6, -6); ctx.lineTo(p.r * 0.3, 8); ctx.moveTo(-4, -p.r * 0.5); ctx.lineTo(10, -2); ctx.stroke();
      } else if (p.kind === 'snow') {
        ctx.fillStyle = '#f7fbff';
        for (const [dx, dy, r] of [[0, 0, 1], [-0.5, 0.3, 0.7], [0.5, -0.3, 0.75], [0.2, 0.5, 0.6]]) {
          ctx.beginPath(); ctx.arc(dx * p.r, dy * p.r, r * p.r * 0.6, 0, Math.PI * 2); ctx.fill();
        }
        ctx.strokeStyle = 'rgba(150,180,210,0.6)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(0, 0, p.r * 0.6, 0, Math.PI * 2); ctx.stroke();
      } else if (p.kind === 'sand') {
        // 모래 언덕: 물결 무늬
        ctx.fillStyle = 'rgba(214,176,104,0.9)';
        ctx.beginPath(); ctx.ellipse(0, 0, p.r * 1.3, p.r * 0.9, p.a, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(160,120,60,0.55)';
        ctx.lineWidth = 2;
        ctx.rotate(p.a);
        for (const k of [-0.4, 0, 0.4]) {
          ctx.beginPath(); ctx.arc(0, k * p.r + p.r * 0.6, p.r * 0.7, Math.PI * 1.2, Math.PI * 1.8); ctx.stroke();
        }
      } else {   // mud
        ctx.fillStyle = '#5b3d22';
        ctx.beginPath(); ctx.ellipse(0, 0, p.r * 1.2, p.r * 0.85, p.a + 0.4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(140,100,60,0.7)';
        ctx.beginPath(); ctx.ellipse(p.r * 0.2, -p.r * 0.15, p.r * 0.45, p.r * 0.25, 0, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  drawObstacles(track, t) {
    const { ctx } = this;
    for (const o of track.obstacles) {
      ctx.save();
      ctx.translate(o.x, o.y);
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath(); ctx.arc(4, 5, o.r, 0, Math.PI * 2); ctx.fill();
      if (o.kind === 'bumper') {
        const pulse = 1 + 0.08 * Math.sin(t * 8);
        ctx.fillStyle = '#ff3d7f';
        ctx.beginPath(); ctx.arc(0, 0, o.r * pulse + 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ffe14d';
        ctx.beginPath(); ctx.arc(0, 0, o.r * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff3d7f';
        ctx.beginPath(); ctx.arc(0, 0, o.r * 0.45, 0, Math.PI * 2); ctx.fill();
      } else if (o.kind === 'log') {
        ctx.rotate(o.a + Math.PI / 2);
        ctx.fillStyle = '#6b4423';
        ctx.beginPath(); ctx.roundRect(-o.r * 2.4, -o.r * 0.75, o.r * 4.8, o.r * 1.5, o.r * 0.7); ctx.fill();
        ctx.fillStyle = '#c9a26b';
        ctx.beginPath(); ctx.ellipse(o.r * 2.3, 0, o.r * 0.35, o.r * 0.7, 0, 0, Math.PI * 2); ctx.fill();
      } else if (o.kind === 'crate') {
        // 화물 상자
        ctx.rotate(o.a);
        const s = o.r * 1.6;
        ctx.fillStyle = ['#d9622b', '#2b7bd9', '#3aa65a'][Math.floor(o.at * 10) % 3];
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = 2;
        for (let k = -2; k <= 2; k++) { ctx.beginPath(); ctx.moveTo(-s / 2, k * s / 5); ctx.lineTo(s / 2, k * s / 5); ctx.stroke(); }
        ctx.strokeRect(-s / 2, -s / 2, s, s);
      } else {   // rock
        ctx.fillStyle = '#7d736a';
        ctx.beginPath();
        for (let k = 0; k < 7; k++) {
          const a = (k / 7) * Math.PI * 2, r = o.r * (0.85 + 0.2 * Math.sin(k * 2.3));
          k ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.beginPath(); ctx.arc(-o.r * 0.3, -o.r * 0.3, o.r * 0.35, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    }
  }

  /** 제트 바람: 지금 미는 방향으로 흐르는 화살표 */
  drawWind(track, t) {
    const { ctx } = this;
    const rt = this.raceTime ?? t;   // 차 물리와 같은 시계(레이스 시간)로 방향 계산
    for (const w of track.wind) {
      const f = Math.sin((rt * Math.PI * 2) / w.period);
      if (Math.abs(f) < 0.15) continue;
      ctx.strokeStyle = `rgba(220,240,255,${Math.abs(f) * 0.6})`;
      ctx.lineWidth = 4;
      for (let i = w.i0; i !== w.i1; i = (i + 18) % track.n) {
        const p = track.pts[i];
        for (const lat of [-0.3, 0, 0.3]) {
          const off = ((t * 2 + i * 0.01) % 1) * 30 * Math.sign(f);
          const x = p.x + p.nx * (lat * track.width + off), y = p.y + p.ny * (lat * track.width + off);
          const dx = p.nx * Math.sign(f) * 14, dy = p.ny * Math.sign(f) * 14;
          ctx.beginPath();
          ctx.moveTo(x - dx - p.tx * 8, y - dy - p.ty * 8); ctx.lineTo(x, y); ctx.lineTo(x - dx + p.tx * 8, y - dy + p.ty * 8);
          ctx.stroke();
        }
        if (forwardIdx(track, i, w.i1) < 18) break;
      }
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

  /** c.look(커스텀 차 생김새)가 있으면 그것으로, 없으면 차 종류(c.type)의 기본 생김새로 */
  drawCar(c, color) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(c.a);
    drawCarArt(ctx, c.look ?? PRESET_LOOKS[c.type ?? 0] ?? PRESET_LOOKS[0], color);
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
      ctx.strokeStyle = c.id === meId ? '#fff' : c.teamColor ?? 'rgba(0,0,0,0.6)';
      ctx.lineWidth = (c.teamColor ? 3.5 : 2) / s;
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
