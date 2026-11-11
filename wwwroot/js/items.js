// 아이템전: 아이템 상자, 아이템 뽑기, 바나나·미사일·보호막·부스터
//
// 네트워크 방식 (자기 차는 자기가 판정하는 원칙 그대로):
// - 상자를 먹으면 'box' 를 보내 다른 사람 화면에서도 3초 동안 상자를 숨긴다.
// - 바나나·미사일을 쓰면 'obj' 를 보내 모두의 화면에 같은 물체를 만든다.
// - 바나나를 밟았는지, 미사일에 맞았는지는 "맞는 사람" 브라우저가 판정하고 'objHit' 로 알린다.
//   (미사일은 각 화면에서 똑같은 규칙으로 목표를 쫓아가므로 모두 비슷하게 보인다)

export const ITEM_NAMES = { banana: '바나나', missile: '미사일', shield: '보호막', boost: '부스터' };
const KINDS = Object.keys(ITEM_NAMES);

const BOX_RESPAWN = 3000;
const BANANA_LIFE = 40000;
const MISSILE_SPEED = 980;
const MISSILE_TURN = 5.5;      // rad/s
const MISSILE_LIFE = 5000;

/** 순위에 따라 아이템 확률이 달라짐. place: 0 = 1등, 1 = 꼴찌 (역전의 기회) */
export function rollItem(place) {
  const w = {
    banana: 45 - 30 * place,
    shield: 30 - 15 * place,
    boost: 20 + 15 * place,
    missile: 5 + 30 * place,
  };
  let r = Math.random() * KINDS.reduce((s, k) => s + w[k], 0);
  for (const k of KINDS) if ((r -= w[k]) < 0) return k;
  return 'boost';
}

export class Items {
  /**
   * hooks: {
   *   send(msg)                     서버로 보내기
   *   hitMe(fromId, why) → bool      내 차를 스핀시킴 (보호막이면 false)
   *   sfx(name)                      효과음
   *   banner(text, color)            화면 가운데 알림
   * }
   */
  constructor(track, me, hooks) {
    this.track = track;
    this.me = me;
    this.hooks = hooks;
    this.objs = new Map();
    this.slot = null;
    this.rolling = null;          // { until, kind }
    this.seq = 0;
    this.boxes = [];
    const rows = track.def.itemRows ?? [0.17, 0.5, 0.82];
    rows.forEach((f) => {
      const i = Math.floor(f * track.n) % track.n, p = track.pts[i];
      for (const k of [-0.3, -0.1, 0.1, 0.3]) {
        const lat = k * track.width;
        this.boxes.push({ x: p.x + p.nx * lat, y: p.y + p.ny * lat, hiddenUntil: 0 });
      }
    });
  }

  get incomingMissile() {
    for (const o of this.objs.values()) if (o.kind === 'missile' && o.target === this.me && !o.arrived) return o;
    return null;
  }

  /** 매 프레임. car: 내 차(관전이면 null), remotes: id→RemoteCar, place: 0~1 */
  update(dt, now, car, remotes, place) {
    const { hooks } = this;

    // 상자 줍기
    if (car && !car.finished) {
      this.boxes.forEach((b, i) => {
        if (now < b.hiddenUntil || Math.hypot(car.x - b.x, car.y - b.y) > 26) return;
        b.hiddenUntil = now + BOX_RESPAWN;
        hooks.send({ t: 'box', i });
        if (!this.slot && !this.rolling) {
          this.rolling = { until: now + 900, kind: rollItem(place) };
          hooks.sfx('pickup');
        }
      });
    }
    if (this.rolling && now >= this.rolling.until) {
      this.slot = this.rolling.kind;
      this.rolling = null;
      hooks.sfx('ready');
    }

    // 바나나와 미사일
    for (const o of [...this.objs.values()]) {
      const age = now - o.born;
      if (o.kind === 'banana') {
        if (age > BANANA_LIFE) { this.objs.delete(o.id); continue; }
        // 내가 밟았나? (내가 놓은 바나나는 0.8초 뒤부터 나도 밟힘, 같은 팀 바나나는 안 밟힘)
        if (car && !car.finished && (o.owner !== this.me || age > 800) && !hooks.sameTeam?.(o.owner)
            && Math.hypot(car.x - o.x, car.y - o.y) < 22) {
          this.objs.delete(o.id);
          hooks.send({ t: 'objHit', oid: o.id });
          hooks.hitMe(o.owner, 'banana');
        }
        continue;
      }

      // 미사일: 목표 차를 향해 방향을 틀며 날아감
      if (age > MISSILE_LIFE || (o.arrived && age - o.arrived > 600)) { this.objs.delete(o.id); continue; }
      if (o.arrived) continue;
      const tgt = o.target === this.me ? car : remotes.get(o.target);
      if (tgt) {
        let da = Math.atan2(tgt.y - o.y, tgt.x - o.x) - o.a;
        da = Math.atan2(Math.sin(da), Math.cos(da));
        o.a += Math.max(-MISSILE_TURN * dt, Math.min(MISSILE_TURN * dt, da));
      }
      o.x += Math.cos(o.a) * MISSILE_SPEED * dt;
      o.y += Math.sin(o.a) * MISSILE_SPEED * dt;
      if (tgt && Math.hypot(tgt.x - o.x, tgt.y - o.y) < 26) {
        if (o.target === this.me) {
          this.objs.delete(o.id);
          hooks.send({ t: 'objHit', oid: o.id });
          hooks.sfx('explode');
          hooks.hitMe(o.owner, 'missile');
        } else {
          o.arrived = age;   // 맞은 사람이 'objHit' 를 보낼 때까지 잠깐 숨김
        }
      }
    }
  }

  /** 아이템 사용. ahead: 바로 앞 순위 차 id (없으면 null) */
  use(car, now, ahead) {
    if (!this.slot || !car || car.finished) return;
    const kind = this.slot;
    this.slot = null;
    const fx = Math.cos(car.a), fy = Math.sin(car.a);
    const oid = `${this.me}-${++this.seq}`;

    if (kind === 'banana') {
      const o = { kind, id: oid, owner: this.me, x: car.x - fx * 34, y: car.y - fy * 34, born: now };
      this.objs.set(oid, o);
      this.hooks.send({ t: 'obj', kind, oid, x: Math.round(o.x), y: Math.round(o.y) });
      this.hooks.sfx('banana');
    } else if (kind === 'missile') {
      const o = { kind, id: oid, owner: this.me, target: ahead ?? 0, x: car.x + fx * 26, y: car.y + fy * 26, a: car.a, born: now };
      this.objs.set(oid, o);
      this.hooks.send({ t: 'obj', kind, oid, x: Math.round(o.x), y: Math.round(o.y), a: o.a, target: o.target });
      this.hooks.sfx('missile');
      if (!ahead) this.hooks.banner('앞에 아무도 없어요 → 그냥 날아감', '#ffffff');
    } else if (kind === 'shield') {
      car.shield = 5;
      this.hooks.sfx('shield');
    } else if (kind === 'boost') {
      car.boost = Math.max(car.boost, 1.6);
    }
  }

  /** 다른 사람이 보낸 아이템 이벤트 */
  onRemote(m, now) {
    if (m.t === 'box') {
      const b = this.boxes[m.i];
      if (b) b.hiddenUntil = now + BOX_RESPAWN;
    } else if (m.t === 'obj') {
      if (m.kind !== 'banana' && m.kind !== 'missile') return;
      this.objs.set(m.oid, { kind: m.kind, id: m.oid, owner: m.id, x: m.x, y: m.y, a: m.a ?? 0, target: m.target ?? 0, born: now });
      if (m.kind === 'missile' && m.target === this.me) {
        this.hooks.banner('미사일 접근!', '#ff5a4f');
        this.hooks.sfx('warning');
      }
    } else if (m.t === 'objHit') {
      this.objs.delete(m.oid);
    }
  }

  // ───────────────────────── 그리기 (월드 좌표) ─────────────────────────

  draw(ctx, t, now) {
    for (const b of this.boxes) {
      if (now < b.hiddenUntil) continue;
      ctx.save();
      ctx.translate(b.x, b.y + Math.sin(t * 3 + b.x) * 2);
      ctx.rotate(t * 1.5);
      const g = ctx.createLinearGradient(-12, -12, 12, 12);
      g.addColorStop(0, `hsl(${(t * 120) % 360}, 90%, 62%)`);
      g.addColorStop(1, `hsl(${(t * 120 + 120) % 360}, 90%, 55%)`);
      ctx.fillStyle = g;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-12, -12, 24, 24, 5);
      ctx.fill();
      ctx.stroke();
      ctx.rotate(-t * 1.5);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', 0, 1);
      ctx.restore();
    }
    for (const o of this.objs.values()) {
      if (o.arrived) continue;
      ctx.save();
      ctx.translate(o.x, o.y);
      if (o.kind === 'missile') {
        ctx.rotate(o.a);
        drawIcon(ctx, 'missile', 0, 0, 30, t);
      } else {
        drawIcon(ctx, 'banana', 0, 0, 26, t);
      }
      ctx.restore();
    }
  }
}

/** 아이템 그림 (월드와 HUD 공용). (x, y) 중심, size 크기 */
export function drawIcon(ctx, kind, x, y, size, t = 0) {
  const s = size / 30;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  if (kind === 'banana') {
    ctx.fillStyle = '#ffd93b';
    ctx.strokeStyle = '#8a6a10';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, -6, 14, 0.25 * Math.PI, 0.95 * Math.PI);
    ctx.arc(-2, -14, 16, 0.85 * Math.PI, 0.3 * Math.PI, true);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#5a4410';
    ctx.fillRect(9, 2, 4, 4);
  } else if (kind === 'missile') {
    // 오른쪽(+x)이 앞
    ctx.fillStyle = `rgba(255,${150 + Math.sin(t * 40) * 60},40,0.9)`;
    ctx.beginPath(); ctx.moveTo(-12, -4); ctx.lineTo(-22 - Math.random() * 6, 0); ctx.lineTo(-12, 4); ctx.fill();
    ctx.fillStyle = '#e8413a';
    ctx.beginPath(); ctx.roundRect(-12, -5, 20, 10, 3); ctx.fill();
    ctx.fillStyle = '#f2f2f2';
    ctx.beginPath(); ctx.moveTo(8, -5); ctx.lineTo(15, 0); ctx.lineTo(8, 5); ctx.fill();
    ctx.fillStyle = '#9b1f1a';
    ctx.beginPath(); ctx.moveTo(-12, -5); ctx.lineTo(-8, -10); ctx.lineTo(-5, -5); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-12, 5); ctx.lineTo(-8, 10); ctx.lineTo(-5, 5); ctx.fill();
  } else if (kind === 'shield') {
    ctx.fillStyle = 'rgba(80,170,255,0.35)';
    ctx.strokeStyle = '#7cc4ff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(-4, -4, 3, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'boost') {
    for (let k = 0; k < 2; k++) {
      ctx.fillStyle = k ? '#ffc531' : '#ff7a2e';
      const ox = -6 + k * 9;
      ctx.beginPath();
      ctx.moveTo(ox - 5, -11); ctx.lineTo(ox + 5, 0); ctx.lineTo(ox - 5, 11);
      ctx.lineTo(ox, 11); ctx.lineTo(ox + 10, 0); ctx.lineTo(ox, -11);
      ctx.closePath();
      ctx.fill();
    }
  }
  ctx.restore();
}
