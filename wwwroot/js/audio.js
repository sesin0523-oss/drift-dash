// 효과음: Web Audio 로 합성 (음원 파일 없음)
// 브라우저는 사용자가 한 번 클릭/키 입력을 해야 소리를 낼 수 있어서 unlock() 을 그때 부른다.

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = localStorageGet('dd-muted') === '1';
  }

  unlock() {
    if (this.ctx) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(ctx.destination);

    // 엔진: 톱니파 두 개 + 저역 필터
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0;
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = 900;
    this.engA = ctx.createOscillator();
    this.engB = ctx.createOscillator();
    this.engA.type = 'sawtooth';
    this.engB.type = 'square';
    this.engA.connect(filt); this.engB.connect(filt);
    filt.connect(this.engGain);
    this.engGain.connect(this.master);
    this.engA.start(); this.engB.start();

    // 타이어 끼익: 노이즈 + 대역 필터
    const noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = noise;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2400;
    bp.Q.value = 6;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;
    src.connect(bp); bp.connect(this.skidGain); this.skidGain.connect(this.master);
    src.start();
  }

  setMuted(m) {
    this.muted = m;
    localStorageSet('dd-muted', m ? '1' : '0');
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  /** 매 프레임: 엔진 소리 높이 = 속도, 끼익 = 드리프트 */
  update(speed, throttle, drifting, boosting) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = 55 + speed * 0.22 + (boosting ? 40 : 0);
    this.engA.frequency.setTargetAtTime(f, t, 0.05);
    this.engB.frequency.setTargetAtTime(f * 0.5, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.05 + (throttle ? 0.06 : 0.02), t, 0.1);
    this.skidGain.gain.setTargetAtTime(drifting ? 0.12 : 0, t, 0.05);
  }

  silenceEngine() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.engGain.gain.setTargetAtTime(0, t, 0.1);
    this.skidGain.gain.setTargetAtTime(0, t, 0.05);
  }

  beep(freq, dur = 0.15, type = 'square', vol = 0.25) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur);
  }

  boost() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(3000, t + 0.4);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + 0.6);
  }

  bump(strength) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    g.gain.setValueAtTime(Math.min(0.5, strength / 600), t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.2);
  }

  /** 상대 뒤를 박았을 때: 쇠 부딪히는 '깡' */
  clank() {
    if (!this.ctx) return;
    [620, 930].forEach((f) => this.beep(f, 0.12, 'square', 0.18));
    this.bump(500);
  }

  /** 내가 스핀할 때: 끼이익 + 내려가는 소리 */
  spin() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(900, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.9);
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + 0.95);
    this.skidGain.gain.setTargetAtTime(0.18, t, 0.02);
  }

  /** 아이템전 효과음 */
  sfx(name) {
    if (!this.ctx) return;
    const seq = (notes, gap, type = 'square', vol = 0.18) =>
      notes.forEach((f, i) => setTimeout(() => this.beep(f, gap / 1000 + 0.05, type, vol), i * gap));
    switch (name) {
      case 'pickup': seq([660, 880, 1100, 1320], 55, 'triangle', 0.2); break;
      case 'ready': this.beep(1568, 0.18, 'sine', 0.25); break;
      case 'banana': seq([300, 180], 70, 'sine', 0.25); break;
      case 'missile': this.boost(); seq([400, 600, 800], 40, 'sawtooth', 0.08); break;
      case 'warning': seq([1200, 0, 1200, 0, 1200], 90, 'square', 0.16); break;
      case 'shield': seq([523, 784, 1047], 60, 'sine', 0.2); break;
      case 'shieldPop': seq([1047, 523], 80, 'sine', 0.22); break;
      case 'explode': this.bump(600); this.boost(); break;
    }
  }

  fanfare() {
    [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, i === 3 ? 0.5 : 0.14, 'square', 0.22), i * 120));
  }
}

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* 무시 */ } }
