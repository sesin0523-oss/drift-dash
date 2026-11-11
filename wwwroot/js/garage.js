// 차고: 커스텀 차 만들기 / 고치기. 저장은 브라우저(localStorage)에, 최대 3대.
// 레이스에 쓸 때는 서버가 다시 검사해서 다른 사람에게도 같은 차를 보여 준다.

import { drawCarArt, SHAPES, PATTERNS } from './carart.js';
import { CUSTOM_BUDGET, STAT_KEYS, STAT_NAMES, clampStats } from './car.js';

export const MAX_CUSTOM = 3;

export const lookOf = (cc) => cc && ({
  shape: cc.shape, color: cc.color, accent: cc.accent, pattern: cc.pattern, number: cc.number,
});

/** 작은 캔버스에 차 한 대 그리기 (차 고르기 카드, 차고 미리보기) */
export function drawPreview(canvas, look, baseColor, angle = 0) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = Math.min(w / 52, h / 34);
  ctx.translate(w / 2, h / 2);
  ctx.rotate(angle);
  ctx.scale(s, s);
  drawCarArt(ctx, look, baseColor);
}

const DEFAULT = () => ({
  name: '내 차', shape: 1, color: '#ff5a4f', accent: '#ffffff', pattern: 4, number: 7,
  stats: { speed: 3, corner: 3, drift: 3, weight: 3 },
});

export class Garage {
  /** hooks: { save(car, index), remove(index) } — index 가 null 이면 새 차 */
  constructor(hooks) {
    this.hooks = hooks;
    this.el = document.getElementById('garage');
    this.car = DEFAULT();
    this.index = null;
    this.angle = 0;

    const $ = (id) => document.getElementById(id);
    this.$ = $;

    // 모양 버튼
    SHAPES.forEach((name, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'shape-btn';
      b.innerHTML = '<canvas></canvas><span></span>';
      b.querySelector('span').textContent = name;
      b.addEventListener('click', () => { this.car.shape = i; this.render(); });
      $('gShapes').append(b);
    });
    PATTERNS.forEach((name, i) => $('gPattern').add(new Option(name, i)));

    // 능력치 줄
    for (const k of STAT_KEYS) {
      const row = document.createElement('div');
      row.className = 'stat-row';
      row.innerHTML = '<span class="label"></span><button type="button" class="ghost minus">−</button><i><b></b></i><button type="button" class="ghost plus">+</button><span class="val"></span>';
      row.querySelector('.label').textContent = STAT_NAMES[k];
      row.querySelector('.minus').addEventListener('click', () => this.bump(k, -1));
      row.querySelector('.plus').addEventListener('click', () => this.bump(k, +1));
      row.dataset.k = k;
      $('gStats').append(row);
    }

    $('gName').addEventListener('input', () => { this.car.name = $('gName').value.slice(0, 10); });
    $('gColor').addEventListener('input', () => { this.car.color = $('gColor').value; this.render(); });
    $('gAccent').addEventListener('input', () => { this.car.accent = $('gAccent').value; this.render(); });
    $('gPattern').addEventListener('change', () => { this.car.pattern = +$('gPattern').value; this.render(); });
    $('gNumber').addEventListener('input', () => {
      const v = $('gNumber').value.trim();
      this.car.number = v === '' ? null : Math.max(0, Math.min(99, parseInt(v, 10) || 0));
      this.render();
    });
    $('gSave').addEventListener('click', () => {
      this.car.name = ($('gName').value.trim() || '내 차').slice(0, 10);
      this.car.stats = clampStats(this.car.stats);
      this.hooks.save(structuredClone(this.car), this.index);
      this.close();
    });
    $('gCancel').addEventListener('click', () => this.close());
    $('gDelete').addEventListener('click', () => {
      if (this.index != null && confirm(`"${this.car.name}" 차를 지울까요?`)) {
        this.hooks.remove(this.index);
        this.close();
      }
    });
  }

  get isOpen() { return !this.el.classList.contains('hidden'); }

  open(car, index) {
    this.car = car ? structuredClone(car) : DEFAULT();
    this.index = index ?? null;
    const $ = this.$;
    $('gTitle').textContent = this.index == null ? '새 차 만들기' : '차 고치기';
    $('gDelete').classList.toggle('hidden', this.index == null);
    $('gName').value = this.car.name;
    $('gColor').value = this.car.color;
    $('gAccent').value = this.car.accent;
    $('gPattern').value = this.car.pattern;
    $('gNumber').value = this.car.number ?? '';
    this.el.classList.remove('hidden');
    document.getElementById('lobby').classList.add('hidden');
    this.render();
    // 미리보기 차가 천천히 돌게
    cancelAnimationFrame(this.raf);
    const spin = () => {
      if (!this.isOpen) return;
      this.angle += 0.01;
      drawPreview($('gPreview'), this.car, this.car.color, -Math.PI / 2 + Math.sin(this.angle) * 0.6);
      this.raf = requestAnimationFrame(spin);
    };
    spin();
  }

  close() {
    this.el.classList.add('hidden');
    document.getElementById('lobby').classList.remove('hidden');
  }

  bump(k, d) {
    const st = this.car.stats;
    const total = STAT_KEYS.reduce((s, key) => s + st[key], 0);
    const next = st[k] + d;
    if (next < 1 || next > 5) return;
    if (d > 0 && total >= CUSTOM_BUDGET) return;   // 포인트가 모자람
    st[k] = next;
    this.render();
  }

  render() {
    const $ = this.$, c = this.car;
    [...$('gShapes').children].forEach((b, i) => {
      b.classList.toggle('selected', i === c.shape);
      drawPreview(b.querySelector('canvas'), { ...c, shape: i, number: null }, c.color);
    });
    const total = STAT_KEYS.reduce((s, k) => s + c.stats[k], 0);
    for (const row of $('gStats').children) {
      const v = c.stats[row.dataset.k];
      row.querySelector('b').style.width = `${v * 20}%`;
      row.querySelector('.val').textContent = v;
      row.querySelector('.minus').disabled = v <= 1;
      row.querySelector('.plus').disabled = v >= 5 || total >= CUSTOM_BUDGET;
    }
    $('gPoints').textContent = `남은 포인트 ${CUSTOM_BUDGET - total} / ${CUSTOM_BUDGET}`;
  }
}
