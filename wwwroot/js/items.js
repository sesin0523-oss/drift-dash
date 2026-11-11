// 아이템전: 아이템 상자, 아이템 뽑기, 바나나·미사일·보호막·부스터
//
// 네트워크 방식 (자기 차는 자기가 판정하는 원칙 그대로):
// - 상자를 먹으면 'box' 를 보내 다른 사람 화면에서도 3초 동안 상자를 숨긴다.
// - 바나나·미사일을 쓰면 'obj' 를 보내 모두의 화면에 같은 물체를 만든다.
// - 바나나를 밟았는지, 미사일에 맞았는지는 "맞는 사람" 브라우저가 판정하고 'objHit' 로 알린다.
//   (미사일은 각 화면에서 똑같은 규칙으로 목표를 쫓아가므로 모두 비슷하게 보인다)

export const ITEM_NAMES = {
  banana: '바나나', missile: '미사일', shield: '보호막', boost: '부스터',
  oil: '기름 웅덩이', zap: '전기 충격', ink: '먹물', magnet: '자석', cloak: '투명 망토', boost3: '부스터 ×3',
};
export const ITEM_HELP = {
  banana: '뒤에 떨어뜨려 밟은 차를 스핀', missile: '바로 앞 차를 쫓아가 명중',
  shield: '5초 동안 공격 한 번 막기', boost: '1.6초 가속',
  oil: '뒤에 뿌려 밟은 차가 미끄러짐', zap: '상대 전원 1.5초 감속',
  ink: '나보다 앞선 상대 화면을 가림', magnet: '앞 차에 끌려가듯 따라붙기',
  cloak: '3초 동안 차·아이템 통과', boost3: '부스터 세 번',
};
const KINDS = Object.keys(ITEM_NAMES);

const BOX_RESPAWN = 3000;
const BANANA_LIFE = 40000;
const OIL_LIFE = 25000;
const MISSILE_SPEED = 980;
const MISSILE_TURN = 5.5;      // rad/s
const MISSILE_LIFE = 5000;

/**
 * 순위에 따라 아이템 확률이 달라짐. place: 0 = 1등, 1 = 꼴찌.
 * 앞쪽은 방어·견제용(바나나·기름·보호막), 뒤쪽은 따라잡기용(미사일·전기·자석·부스터×3)이 잘 나옴.
 */
export function rollItem(place) {
  const p = place;
  const w = {
    banana: 26 - 16 * p, oil: 14 - 4 * p, shield: 20 - 10 * p, cloak: 6 + 2 * p,
    boost: 14 + 4 * p, boost3: 12 * p, missile: 3 + 18 * p,
    zap: p > 0.2 ? 9 * p : 0, ink: 4 + 8 * p, magnet: 12 * p,
  };
  let r = Math.random() * KINDS.reduce((s, k) => s + Math.max(0, w[k]), 0);
  for (const k of KINDS) if ((r -= Math.max(0, w[k])) < 0) return k;
  return 'boost';
}

export class Items {
  /**
   * hooks: {
   *   send(msg)                     서버로 보내기
   *   hitMe(fromId, why) → bool      내 차를 스핀시킴 (보호막이면 false)
   *   sfx(name)                      효과음
   *   banner(text, color)            화면 가운데 알림
   *   slideMe(fromId)                기름을 밟음 → 미끄러지게
   *   fx(msg)                        모두에게 영향을 주는 아이템(전기 충격·먹물) 알리기
   *   sameTeam(ownerId) → bool       같은 팀 물건은 안 밟힘
   * }
   */
  constructor(track, me, hooks) {
    this.track = track;
    this.me = me;
    this.hooks = hooks;
    this.objs = new Map();
    this.slot = null;
    this.charges = 0;             // 부스터×3 남은 횟수
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
      this.charges = this.slot === 'boost3' ? 3 : 0;
      this.rolling = null;
      hooks.sfx('ready');
    }

    // 투명 망토·견인 중이면 바닥 물건과 미사일에 안 맞음
    const target = car && !car.finished && !car.ghostly ? car : null;

    // 바나나·기름·미사일
    for (const o of [...this.objs.values()]) {
      const age = now - o.born;
      if (o.kind === 'banana' || o.kind === 'oil') {
        if (age > (o.kind === 'oil' ? OIL_LIFE : BANANA_LIFE)) { this.objs.delete(o.id); continue; }
        // 내가 밟았나? (내가 놓은 것은 0.8초 뒤부터 나도 밟힘, 같은 팀 것은 안 밟힘)
        const reach = o.kind === 'oil' ? 30 : 22;
        if (target && (o.owner !== this.me || age > 800) && !hooks.sameTeam?.(o.owner)
            && Math.hypot(target.x - o.x, target.y - o.y) < reach) {
          this.objs.delete(o.id);
          hooks.send({ t: 'objHit', oid: o.id });
          if (o.kind === 'oil') hooks.slideMe?.(o.owner);
          else hooks.hitMe(o.owner, 'banana');
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
      if (tgt && !(tgt.ghostly || tgt.ghost > 0) && Math.hypot(tgt.x - o.x, tgt.y - o.y) < 26) {
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

  /** 아이템 사용. ahead: 바로 앞 순위 상대 차 id (없으면 null) */
  use(car, now, ahead) {
    if (!this.slot || !car || car.finished || car.towing) return;
    const kind = this.slot;
    if (kind === 'boost3' && --this.charges > 0) { /* 아직 남음 → 칸 유지 */ } else this.slot = null;
    const fx = Math.cos(car.a), fy = Math.sin(car.a);
    const oid = `${this.me}-${++this.seq}`;

    if (kind === 'banana' || kind === 'oil') {
      const back = kind === 'oil' ? 40 : 34;
      const o = { kind, id: oid, owner: this.me, x: car.x - fx * back, y: car.y - fy * back, born: now };
      this.objs.set(oid, o);
      this.hooks.send({ t: 'obj', kind, oid, x: Math.round(o.x), y: Math.round(o.y) });
      this.hooks.sfx(kind === 'oil' ? 'oil' : 'banana');
    } else if (kind === 'zap' || kind === 'ink') {
      this.hooks.fx({ kind });
      this.hooks.sfx(kind);
    } else if (kind === 'magnet') {
      car.magnetT = 2.5;
      car.magnetTarget = ahead;
      this.hooks.sfx('magnet');
      if (!ahead) this.hooks.banner('앞에 아무도 없어요', '#ffffff');
    } else if (kind === 'cloak') {
      car.ghost = Math.max(car.ghost, 3);
      this.hooks.sfx('cloak');
    } else if (kind === 'boost3') {
      car.boost = Math.max(car.boost, 1.0);
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
      if (!['banana', 'missile', 'oil'].includes(m.kind)) return;
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
      } else if (o.kind === 'oil') {
        // 바닥에 번진 기름 (무지갯빛 광택)
        ctx.fillStyle = 'rgba(15,15,20,0.85)';
        ctx.beginPath(); ctx.ellipse(0, 0, 30, 22, 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.ellipse(16, 10, 12, 8, 0, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = `hsla(${(t * 60) % 360},80%,65%,0.45)`;
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.ellipse(-4, -3, 16, 9, 0.5, 0, Math.PI * 1.3); ctx.stroke();
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
  } else if (kind === 'boost3') {
    for (let k = 0; k < 3; k++) {
      ctx.fillStyle = ['#ff5a2e', '#ff9a2e', '#ffd02e'][k];
      const ox = -12 + k * 8;
      ctx.beginPath();
      ctx.moveTo(ox - 4, -10); ctx.lineTo(ox + 4, 0); ctx.lineTo(ox - 4, 10);
      ctx.lineTo(ox, 10); ctx.lineTo(ox + 8, 0); ctx.lineTo(ox, -10);
      ctx.closePath(); ctx.fill();
    }
  } else if (kind === 'oil') {
    ctx.fillStyle = '#16161c';
    ctx.beginPath(); ctx.ellipse(0, 4, 13, 8, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -13); ctx.quadraticCurveTo(7, -3, 0, 1); ctx.quadraticCurveTo(-7, -3, 0, -13); ctx.fill();
    ctx.strokeStyle = 'rgba(160,120,255,0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(-2, 3, 7, 3.5, 0, 0, Math.PI); ctx.stroke();
  } else if (kind === 'zap') {
    ctx.fillStyle = '#ffe14d';
    ctx.strokeStyle = '#a07a00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(4, -14); ctx.lineTo(-8, 2); ctx.lineTo(-1, 2); ctx.lineTo(-4, 14); ctx.lineTo(9, -3); ctx.lineTo(2, -3); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (kind === 'ink') {
    ctx.fillStyle = '#6a2fc0';
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill();
    for (let k = 0; k < 7; k++) {
      const a = (k / 7) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(Math.cos(a) * 11, Math.sin(a) * 11, 3 + (k % 3), 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-3, -2, 2, 0, Math.PI * 2); ctx.arc(3, -2, 2, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 'magnet') {
    ctx.lineWidth = 7;
    ctx.strokeStyle = '#e8413a';
    ctx.beginPath(); ctx.arc(0, -1, 8, Math.PI, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-8, -1); ctx.lineTo(-8, 8); ctx.moveTo(8, -1); ctx.lineTo(8, 8); ctx.stroke();
    ctx.strokeStyle = '#e6e6e6';
    ctx.beginPath(); ctx.moveTo(-8, 8); ctx.lineTo(-8, 13); ctx.moveTo(8, 8); ctx.lineTo(8, 13); ctx.stroke();
  } else if (kind === 'cloak') {
    // 반투명 유령 천
    ctx.fillStyle = 'rgba(235,240,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(-10, 12); ctx.lineTo(-10, -2); ctx.arc(0, -2, 10, Math.PI, 0); ctx.lineTo(10, 12);
    ctx.lineTo(6, 8); ctx.lineTo(3, 12); ctx.lineTo(0, 8); ctx.lineTo(-3, 12); ctx.lineTo(-6, 8);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#334';
    ctx.beginPath(); ctx.arc(-4, -2, 2, 0, Math.PI * 2); ctx.arc(4, -2, 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
