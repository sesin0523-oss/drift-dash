// Drift Dash 메인: 로비 → 카운트다운 → 레이스 → 결과
// 내 차는 내 브라우저에서, AI 봇은 방장 브라우저에서 계산한다.
// 다른 사람의 차(사람·봇)는 서버가 중계한 위치를 보간해서 그린다.

import { TRACKS, buildTrack } from './track.js';
import { Car, CAR_TYPES, carSpec, CUSTOM_TYPE, STAT_KEYS, STAT_NAMES } from './car.js';
import { Garage, lookOf, drawPreview, MAX_CUSTOM } from './garage.js';
import { PRESET_LOOKS } from './carart.js';
import { Net, RemoteCar } from './net.js';
import { Renderer, COLORS, TEAM_COLORS, TEAM_NAMES, fmtTime } from './render.js';
import { Sound } from './audio.js';
import { Chat } from './chat.js';
import { Items, drawIcon, ITEM_NAMES, ITEM_HELP } from './items.js';
import { Bot, BOT_LEVELS } from './bot.js';
import { Podium } from './podium.js';

const DT = 1 / 60;
const PLACE_POINTS = [10, 8, 6, 5, 4, 3];   // 팀전 순위 점수
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

// ───────────────────────── 방 코드 / 이름 / 차 ─────────────────────────

const params = new URLSearchParams(location.search);
let roomCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (roomCode.length < 3) {
  roomCode = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  history.replaceState(null, '', `?room=${roomCode}`);
}
let myName = store.get('dd-name') || `드라이버${Math.floor(Math.random() * 90 + 10)}`;
let myCar = Math.max(0, Math.min(CUSTOM_TYPE, +(store.get('dd-car') ?? 0) || 0));
// 내가 만든 커스텀 차들 (최대 3대) + 그중 고른 것
let customs = [];
try { customs = (JSON.parse(store.get('dd-customs') || '[]') || []).slice(0, MAX_CUSTOM); } catch { customs = []; }
let myCustomIdx = Math.max(0, Math.min(customs.length - 1, +(store.get('dd-custom-idx') ?? 0) || 0));
if (myCar === CUSTOM_TYPE && !customs.length) myCar = 0;

// ───────────────────────── 상태 ─────────────────────────

const net = new Net();
const renderer = new Renderer($('game'));
const sound = new Sound();

let me = 0;
let roster = { host: 0, phase: 'lobby', track: 0, laps: 3, mode: 'speed', teams: false, players: [] };
let mode = 'lobby';            // lobby | race | results
let race = null;               // 진행 중인 레이스
let remotes = new Map();       // id → RemoteCar (다른 사람, 그리고 내가 방장이 아니면 봇도)
const trackCache = new Map();
let lanBase = null;
let banner = null;
let lastCount = null;
let records = [];
let ghostOn = store.get('dd-ghost') !== '0';
let podium = null;             // 시상식 장면 (mode === 'podium' 일 때)
let lastResults = null;        // 마지막 결과 (시상식 다시 보기용)

const getTrack = (i) => {
  if (!trackCache.has(i)) trackCache.set(i, buildTrack(i));
  return trackCache.get(i);
};
const playerOf = (id) => roster.players.find((p) => p.id === id);
const isHost = () => roster.host === me;
const teamOf = (id) => (race?.teams ? playerOf(id)?.team ?? -1 : -1);
const sameTeam = (a, b) => race?.teams && teamOf(a) >= 0 && teamOf(a) === teamOf(b);

// ───────────────────────── 입력 (키보드 + 터치) ─────────────────────────

const keys = new Set();
const touch = { active: false, steer: 0, brake: false, drift: false };

const chat = new Chat({
  send: (text, team) => net.send({ t: 'chat', text, team }),
  colorOf: (c) => COLORS[(c ?? 0) % COLORS.length],
  teamColorOf: (t) => TEAM_COLORS[t],
  onOpenChange: () => keys.clear(),
  onIncoming: (m) => { if (m.id !== me) sound.beep(1320, 0.06, 'sine', 0.12); },
});

function placeChat() {
  chat.placeIn(mode === 'lobby' ? $('lobby') : mode === 'results' ? $('results') : null);
  updateTeamChat();
}

/** 팀전이고 내가 팀에 속해 있으면 채팅에 "전체/팀" 버튼 */
function updateTeamChat() {
  const p = playerOf(me);
  chat.setTeamAvailable(roster.teams && p && !p.spec && p.team >= 0 ? TEAM_COLORS[p.team] : null);
}

const GAME_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
                   'ShiftLeft', 'ShiftRight', 'KeyE', 'BracketLeft', 'BracketRight'];
const ITEM_KEYS = ['ShiftLeft', 'ShiftRight', 'KeyE'];   // Ctrl 은 W 와 같이 누르면 탭이 닫혀서 안 씀

addEventListener('keydown', (e) => {
  sound.unlock();
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (mode === 'podium' && ['Enter', 'Space', 'Escape'].includes(e.code) && podium?.elapsed > 1) {
    e.preventDefault();
    endPodium();
    return;
  }
  if (e.code === 'Enter' && chat.floating && !chat.isOpen) {
    e.preventDefault();
    chat.open();
    return;
  }
  if (GAME_KEYS.includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyM') sound.setMuted(!sound.muted);
  if (e.code === 'KeyG') {
    ghostOn = !ghostOn;
    store.set('dd-ghost', ghostOn ? '1' : '0');
    if (mode === 'race') showBanner(ghostOn ? '고스트 켬' : '고스트 끔', 900, '#ffffff');
  }
  if (ITEM_KEYS.includes(e.code) && !e.repeat) useItem();
  // 관전 중: [ ] 또는 ← → 로 따라갈 차 바꾸기
  if (spectating() && !e.repeat) {
    if (e.code === 'BracketLeft' || e.code === 'ArrowLeft') cycleSpectate(-1);
    if (e.code === 'BracketRight' || e.code === 'ArrowRight') cycleSpectate(1);
  }
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('pointerdown', () => sound.unlock());
// 시상식 중 화면을 누르면 결과 화면으로
$('game').addEventListener('pointerdown', () => { if (mode === 'podium' && podium?.elapsed > 1) endPodium(); });

// 휴대폰: 화면을 처음 만지면 터치 조작으로 전환
addEventListener('touchstart', () => {
  if (!touch.active) {
    touch.active = true;
    updateTouchVisibility();
  }
}, { passive: true });

// 왼쪽 조향 패드: 손가락을 처음 댄 곳에서 좌우로 끈 만큼 핸들 (아날로그)
{
  const pad = $('steerPad'), knob = $('steerKnob');
  let pid = null, x0 = 0, RANGE = 70;
  const move = (x) => {
    touch.steer = Math.max(-1, Math.min(1, (x - x0) / RANGE));
    knob.style.transform = `translateX(${touch.steer * RANGE}px)`;
  };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pid = e.pointerId;
    try { pad.setPointerCapture(pid); } catch { /* 일부 브라우저는 실패할 수 있음 */ }
    const r = pad.getBoundingClientRect();
    RANGE = Math.max(36, Math.min(70, (r.width - 56) / 2));   // 패드 폭에 맞춘 조향 범위
    x0 = Math.max(r.left + RANGE, Math.min(r.right - RANGE, e.clientX));
    knob.style.left = `${x0 - r.left - 28}px`;
    move(e.clientX);
  });
  pad.addEventListener('pointermove', (e) => { if (e.pointerId === pid) move(e.clientX); });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    touch.steer = 0;
    knob.style.transform = 'translateX(0)';
  };
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
}
// 오른쪽 버튼: 브레이크·드리프트는 누르는 동안, 아이템은 누를 때 한 번
for (const btn of document.querySelectorAll('#touch [data-k]')) {
  const k = btn.dataset.k;
  if (k === 'item') {
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); useItem(); });
    continue;
  }
  const set = (v) => (e) => { e.preventDefault(); touch[k] = v; btn.classList.toggle('on', v); };
  btn.addEventListener('pointerdown', set(true));
  btn.addEventListener('pointerup', set(false));
  btn.addEventListener('pointercancel', set(false));
  btn.addEventListener('pointerleave', set(false));
}

function updateTouchVisibility() {
  const driving = mode === 'race' && race?.car && !race.car.finished;
  $('touch').classList.toggle('hidden', !(touch.active && driving));
  $('itemBtn').classList.toggle('hidden', !race?.items);
  document.body.classList.toggle('touch', touch.active);
  document.body.classList.toggle('racing', mode === 'race');
  $('specBar').classList.toggle('hidden', !(mode === 'race' && spectating()));
}

function readInput() {
  const k = (c) => keys.has(c);
  const kbSteer = ((k('ArrowRight') || k('KeyD')) ? 1 : 0) - ((k('ArrowLeft') || k('KeyA')) ? 1 : 0);
  return {
    throttle: k('ArrowUp') || k('KeyW') || (touch.active && !touch.brake),   // 터치는 가속 자동
    brake: k('ArrowDown') || k('KeyS') || touch.brake,
    steer: kbSteer || touch.steer,
    handbrake: k('Space') || touch.drift,
  };
}

// ───────────────────────── 관전 ─────────────────────────

/** 내 차가 없거나(관전) 완주했으면 다른 차를 골라 볼 수 있음 */
function spectating() {
  return !!race && (!race.car || race.car.finished);
}

function cycleSpectate(dir) {
  const ids = standings().map((s) => s.id).filter((id) => id !== me);
  if (!ids.length) return;
  const i = ids.indexOf(race.specId);
  race.specId = ids[(i + dir + ids.length) % ids.length];
  updateSpecBar();
}

function updateSpecBar() {
  if (!race) return;
  const p = playerOf(race.specId);
  $('specName').textContent = p ? `${p.name}${p.bot ? ' (봇)' : ''}` : '1위 따라가기';
}
$('specPrev').addEventListener('click', () => cycleSpectate(-1));
$('specNext').addEventListener('click', () => cycleSpectate(1));

// ───────────────────────── 네트워크 ─────────────────────────

net.on('welcome', (m) => {
  me = m.you;
  roomCode = m.room;
  updateLink();
  sendCar();
});

/** 고른 차를 서버에 알림 (커스텀이면 생김새·능력치까지) */
function sendCar() {
  if (myCar === CUSTOM_TYPE && customs[myCustomIdx]) net.send({ t: 'car', car: CUSTOM_TYPE, custom: customs[myCustomIdx] });
  else net.send({ t: 'car', car: myCar });
}

function saveCustoms() {
  store.set('dd-customs', JSON.stringify(customs));
  store.set('dd-custom-idx', myCustomIdx);
  store.set('dd-car', myCar);
}

const garage = new Garage({
  save: (car, index) => {
    if (index == null) { customs.push(car); index = customs.length - 1; }
    else customs[index] = car;
    myCar = CUSTOM_TYPE;
    myCustomIdx = index;
    saveCustoms();
    sendCar();
    renderCars();
  },
  remove: (index) => {
    customs.splice(index, 1);
    if (myCar === CUSTOM_TYPE) {
      if (!customs.length) myCar = 0;
      myCustomIdx = Math.max(0, Math.min(customs.length - 1, myCustomIdx));
    }
    saveCustoms();
    sendCar();
    renderCars();
  },
});

let lastMyColor = null;
net.on('roster', (m) => {
  roster = m;
  if (m.phase === 'lobby' && mode !== 'lobby') enterLobby();
  renderLobby();
  updateTeamChat();
  const c = playerOf(me)?.color;
  if (c !== lastMyColor) { lastMyColor = c; renderCars(); }   // 기본 차 그림은 내 색으로
});

// 팀 부스터 게이지
net.on('tgauge', (m) => { if (race) race.teamGauge = m.g; });
net.on('tboost', (m) => {
  if (!race) return;
  race.feed.push({ text: `${TEAM_NAMES[m.team]} 팀 부스터 발동!`, until: performance.now() + 3000, mine: teamOf(me) === m.team });
  const car = race.car;
  if (car && !car.finished && teamOf(me) === m.team) {
    car.boost = Math.max(car.boost, 2.2);
    showBanner('팀 부스터!', 1500, TEAM_COLORS[m.team]);
    renderer.shake = Math.max(renderer.shake, 8);
  }
  for (const b of race.bots) if (!b.car.finished && teamOf(b.id) === m.team) b.car.boost = Math.max(b.car.boost, 2.2);
});

net.on('race', (m) => startRace(m));

net.on('st', (m) => {
  if (!race || m.id === me || race.bots.some((b) => b.id === m.id)) return;
  let r = remotes.get(m.id);
  if (!r) remotes.set(m.id, (r = makeRemote(m.id)));
  r.push(m);
});

net.on('fin', (m) => {
  if (!race) return;
  race.finishers.push(m);
  const p = playerOf(m.id);
  if (m.id !== me) showBanner(`${p ? p.name : '?'} 완주! (${m.place}위)`, 2000, '#ffffff');
});

/** 내 차를 스핀시킴 (뒤 모서리 박힘 / 바나나 / 미사일 공통). 실제로 돌았으면 모두에게 알림 */
function spinMe(from, why, side = Math.random() < 0.5 ? -1 : 1, power = 420) {
  const car = race?.car;
  if (!car) return false;
  if (car.applySpin(side, power)) {
    net.send({ t: 'spun', from, why });
    showBanner(why === 'missile' ? '미사일에 맞았어요!' : why === 'banana' ? '바나나를 밟았어요!' : '스핀!', 1300, '#ff5a4f');
    renderer.shake = 14;
    sound.spin();
    return true;
  }
  if (car.shieldPopped) {
    car.shieldPopped = false;
    showBanner('보호막이 막았어요!', 1200, '#7cc4ff');
    sound.sfx('shieldPop');
  }
  return false;
}

/** 방장: 봇을 스핀시킴 */
function spinBot(bot, from, why, side = Math.random() < 0.5 ? -1 : 1, power = 420) {
  if (bot.car.applySpin(side, power)) net.send({ t: 'spun', from, why, as: bot.id });
  bot.car.shieldPopped = false;
}

/** 보호막이 있으면 한 번 막고 true */
function blockedByShield(car, isMe) {
  if (car.shield <= 0) return false;
  car.shield = 0;
  if (isMe) { showBanner('보호막이 막았어요!', 1200, '#7cc4ff'); sound.sfx('shieldPop'); }
  return true;
}

/** 기름을 밟음: 1.1초 동안 미끄러지고 속도가 조금 줄어듦 */
function slideCar(car, isMe) {
  if (!car || car.finished || car.ghostly || blockedByShield(car, isMe)) return;
  car.slide = 1.1;
  car.vx *= 0.8; car.vy *= 0.8;
  if (isMe) { showBanner('기름에 미끄러졌어요!', 1200, '#b28cff'); sound.sfx('oil'); renderer.shake = 8; }
}

/**
 * 모두에게 영향을 주는 아이템이 쓰임 (m.id = 쓴 차, m.kind = zap|ink).
 * 이 브라우저가 맡은 차(내 차 + 내가 방장이면 봇들)에게만 적용 — 각자 자기 차를 판정하는 원칙 그대로.
 */
function applyFx(m) {
  if (!race) return;
  const st = standings();
  const rank = (id) => st.findIndex((s) => s.id === id);
  const victims = [];
  if (race.car && m.id !== me) victims.push({ id: me, car: race.car, isMe: true });
  for (const b of race.bots) if (b.id !== m.id) victims.push({ id: b.id, car: b.car, bot: b });

  const from = playerOf(m.id)?.name ?? '?';
  race.feed.push({ text: m.kind === 'zap' ? `${from}의 전기 충격!` : `${from}의 먹물!`, until: performance.now() + 3000, mine: m.id === me });

  for (const v of victims) {
    const c = v.car;
    if (c.finished || c.ghostly || sameTeam(v.id, m.id)) continue;
    if (m.kind === 'zap') {
      if (blockedByShield(c, v.isMe)) continue;
      c.zap = 1.5;
      if (v.isMe) { showBanner('감전! 잠깐 느려져요', 1300, '#ffe14d'); renderer.shake = 10; sound.sfx('zapHit'); }
    } else if (m.kind === 'ink' && rank(v.id) >= 0 && rank(v.id) < rank(m.id)) {   // 나보다 앞선 차만
      if (v.isMe) { race.inkUntil = performance.now() + 3500; race.inkSeed = Math.random(); sound.sfx('splat'); }
      else v.bot.inkT = 3;
    }
  }
}
net.on('fx', (m) => applyFx(m));

// 누가 뒤 모서리를 박았다 (목표가 내 봇이면 봇을, 아니면 나를)
net.on('hit', (m) => {
  const bot = race?.bots.find((b) => b.id === m.target);
  if (bot) spinBot(bot, m.from, 'bump', m.side, m.power);
  else spinMe(m.from, 'bump', m.side, m.power);
});

net.on('spun', (m) => {
  if (!race) return;
  const from = playerOf(m.from)?.name ?? '?', to = playerOf(m.id)?.name ?? '?';
  const text = m.why === 'banana' ? `${from}의 바나나 → ${to} 스핀!`
             : m.why === 'missile' ? `${from}의 미사일 → ${to} 명중!`
             : `${from} → ${to} 스핀!`;
  race.feed.push({ text, until: performance.now() + 3500, mine: m.from === me && m.id !== me });
  if (race.feed.length > 4) race.feed.shift();
  if (m.from === me && m.id !== me) showBanner('명중! 상대가 돌았어요', 1400, '#ffc531');
  // 팀전: 상대를 스핀시키면 팀 게이지 +15
  if (race.teams && m.id !== m.from && !sameTeam(m.id, m.from)) {
    if (m.from === me) race.tgAcc += 15;
    const bot = race.bots.find((b) => b.id === m.from);
    if (bot) bot.tgAcc += 15;
  }
});

// 아이템전: 다른 사람(또는 다른 사람의 봇)이 보낸 아이템 이벤트 → 이 브라우저의 모든 아이템 판정기에
for (const t of ['box', 'obj', 'objHit']) net.on(t, (m) => {
  for (const it of localItems()) it.onRemote(m, performance.now());
});

net.on('lapres', (m) => {
  if (!m.ok || !m.rank) return;
  if (m.rank === 1) {
    showBanner(`트랙 신기록!  ${fmtTime(m.time)}`, 2200, '#ffc531');
    sound.fanfare();
  } else {
    showBanner(`랭킹 ${m.rank}위 기록!  ${fmtTime(m.time)}`, 1800, '#ffffff');
  }
  fetchRecords();
});

// 결과: 단판이거나 3판 2선승이 끝났으면 시상식부터, 시리즈 도중이면 중간 결과만
net.on('results', (m) => {
  lastResults = m;
  if (m.series?.on && !m.series.over) showResults(m);
  else startPodium(m);
});
net.on('chat', (m) => chat.add(m));
net.on('left', (m) => {
  remotes.delete(m.id);
  if (race) race.bots = race.bots.filter((b) => b.id !== m.id);
});
net.on('error', (m) => alert(m.msg));
net.on('close', () => {
  $('disconnected').classList.remove('hidden');
  $('lobby').classList.add('hidden');
  $('results').classList.add('hidden');
});

// ───────────────────────── 로비 ─────────────────────────

$('name').value = myName;
$('name').addEventListener('change', () => {
  myName = $('name').value.trim() || myName;
  $('name').value = myName;
  store.set('dd-name', myName);
  net.send({ t: 'name', name: myName });
});

TRACKS.forEach((t, i) => $('track').add(new Option(t.name, i)));
for (let i = 1; i <= 5; i++) $('laps').add(new Option(`${i}바퀴`, i));
const sendCfg = () => net.send({
  t: 'cfg', track: +$('track').value, laps: +$('laps').value, mode: $('mode').value,
  teams: $('teams').value === '1', series: +$('series').value,
});
for (const id of ['track', 'laps', 'mode', 'teams', 'series']) $(id).addEventListener('change', sendCfg);
$('replayPodium').addEventListener('click', () => { if (lastResults) startPodium(lastResults); });

$('spec').addEventListener('change', () => net.send({ t: 'spec', on: $('spec').checked }));
for (const btn of document.querySelectorAll('[data-bot]'))
  btn.addEventListener('click', () => net.send({ t: 'addBot', level: +btn.dataset.bot }));

$('start').addEventListener('click', () => {
  sound.unlock();
  net.send({ t: 'start' });
});
$('toLobby').addEventListener('click', () => net.send({ t: 'lobby' }));

$('copy').addEventListener('click', async () => {
  const input = $('link');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');   // http(보안 연결 아님)에서는 이 방식만 됨
  }
  $('copy').textContent = '복사됨!';
  setTimeout(() => ($('copy').textContent = '복사'), 1500);
});

// 차 고르기 카드: 기본 차 4종 + 내 커스텀 차들 + "차 만들기"
function carCard({ name, desc, bars, look, selected, onPick, onEdit }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'car-card' + (selected ? ' selected' : '');
  const title = document.createElement('div');
  title.className = 'car-name';
  title.textContent = name;
  const cv = document.createElement('canvas');
  const d = document.createElement('div');
  d.className = 'car-desc';
  d.textContent = desc;
  const barBox = document.createElement('div');
  barBox.className = 'car-bars';
  for (const [label, v] of Object.entries(bars)) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = '<span></span><i><b></b></i>';
    row.querySelector('span').textContent = label;
    row.querySelector('b').style.width = `${v * 20}%`;
    barBox.append(row);
  }
  b.append(title, cv, d, barBox);
  if (onEdit) {
    const e = document.createElement('div');
    e.className = 'edit';
    e.textContent = '고치기';
    e.addEventListener('click', (ev) => { ev.stopPropagation(); onEdit(); });
    b.append(e);
  }
  b.addEventListener('click', () => { if (roster.phase !== 'race') onPick(); });
  // 카드가 화면에 붙은 뒤(크기를 알 수 있을 때) renderCars 가 그림
  b.drawPreview = () => drawPreview(cv, look, look.color ?? COLORS[(playerOf(me)?.color ?? 0) % COLORS.length]);
  return b;
}

function renderCars() {
  const box = $('cars');
  box.innerHTML = '';
  CAR_TYPES.forEach((ct, i) => box.append(carCard({
    name: ct.name, desc: ct.desc, bars: ct.bars, look: PRESET_LOOKS[i], selected: myCar === i,
    onPick: () => { myCar = i; saveCustoms(); sendCar(); renderCars(); },
  })));
  customs.forEach((cc, i) => box.append(carCard({
    name: cc.name, desc: `커스텀 · ${['세단', '스포츠카', '드리프트카', '트럭'][cc.shape]}`,
    bars: Object.fromEntries(STAT_KEYS.map((k) => [STAT_NAMES[k], cc.stats[k]])),
    look: lookOf(cc), selected: myCar === CUSTOM_TYPE && myCustomIdx === i,
    onPick: () => { myCar = CUSTOM_TYPE; myCustomIdx = i; saveCustoms(); sendCar(); renderCars(); },
    onEdit: () => garage.open(cc, i),
  })));
  if (customs.length < MAX_CUSTOM) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'car-card add';
    add.innerHTML = '<b>+</b><span>차 만들기</span>';
    add.addEventListener('click', () => { if (roster.phase !== 'race') garage.open(null, null); });
    box.append(add);
  }
  for (const card of box.children) card.drawPreview?.();
}

function shareBase() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return local && lanBase ? lanBase : location.origin;
}

function updateLink() {
  $('roomCode').textContent = roomCode;
  $('link').value = `${shareBase()}/?room=${roomCode}`;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('linkHint').textContent = local
    ? (lanBase ? '같은 와이파이에 있는 친구가 열 수 있는 주소예요. 다른 곳의 친구는 README를 보세요.' : '이 PC에서만 열리는 주소예요.')
    : '이 링크를 보내면 친구가 같은 방으로 들어와요.';
}

function renderLobby() {
  const host = isHost();
  const ul = $('players');
  ul.innerHTML = '';
  for (const p of roster.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLORS[p.color % COLORS.length];
    const name = document.createElement('span');
    name.textContent = p.name;
    const carTag = document.createElement('span');
    carTag.className = 'car-tag';
    carTag.textContent = p.car === CUSTOM_TYPE ? `${p.custom?.name ?? '커스텀'} (커스텀)` : CAR_TYPES[p.car]?.name ?? '';
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [
      p.id === me ? '나' : '', p.id === roster.host ? '방장' : '',
      p.bot ? `봇·${BOT_LEVELS[p.level]?.name}` : '', p.spec ? '관전' : '',
      p.inRace && roster.phase === 'race' ? '레이스 중' : '',
    ].filter(Boolean).join(' · ');
    li.append(dot, name, carTag, tag);

    // 팀전: 팀 배지 (나 또는 방장이 봇 것을 누르면 팀 바꾸기)
    if (roster.teams && !p.spec) {
      const team = document.createElement('button');
      team.type = 'button';
      team.className = 'team-badge';
      team.textContent = p.team >= 0 ? TEAM_NAMES[p.team] : '팀?';
      team.style.background = p.team >= 0 ? TEAM_COLORS[p.team] : '#666';
      const canChange = roster.phase !== 'race' && (p.id === me || (p.bot && host));
      team.disabled = !canChange;
      team.title = canChange ? '눌러서 팀 바꾸기' : '';
      team.addEventListener('click', () => {
        if (p.bot) net.send({ t: 'botTeam', id: p.id });
        else net.send({ t: 'team', team: p.team === 0 ? 1 : 0 });
      });
      li.append(team);
    }
    if (p.bot && host && roster.phase !== 'race') {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'remove-bot';
      x.textContent = '✕';
      x.title = '봇 빼기';
      x.addEventListener('click', () => net.send({ t: 'removeBot', id: p.id }));
      li.append(x);
    }
    ul.append(li);
  }

  $('track').value = roster.track;
  $('laps').value = roster.laps;
  $('mode').value = roster.mode ?? 'speed';
  $('teams').value = roster.teams ? '1' : '0';
  $('series').value = String(roster.series?.on ? roster.series.kind ?? 1 : 0);
  for (const id of ['track', 'laps', 'mode', 'teams', 'series']) $(id).disabled = !host;
  if (gpRunning(roster.series)) $('track').disabled = true;   // 그랑프리 도중엔 트랙이 정해진 순서대로
  const sText = seriesText(roster.series, roster.teams);
  $('seriesStatus').classList.toggle('hidden', !sText);
  $('seriesStatus').textContent = sText;
  const feat = TRACKS[roster.track].features?.note;
  $('trackDesc').textContent = TRACKS[roster.track].desc + (feat ? ` · 특징: ${feat}` : '') + (roster.mode === 'item'
    ? ' · 아이템전: ? 상자를 먹고 Shift/E 로 사용'
    : '') + (roster.teams ? ' · 팀전: 순위 점수(1위 10, 2위 8, 3위 6…)의 합으로 승부' : '');
  renderRecords();

  const meP = playerOf(me);
  $('spec').checked = !!meP?.spec;
  $('botControls').classList.toggle('hidden', !host || roster.phase === 'race');

  const racers = roster.players.filter((p) => !p.spec).length;
  $('start').classList.toggle('hidden', !host);
  $('start').disabled = roster.phase === 'race';
  $('start').textContent = racers > 1 ? `레이스 시작 (${racers}대)` : '혼자 연습 시작';
  const hostName = playerOf(roster.host)?.name ?? '방장';
  $('waitHost').textContent = host ? '' : roster.phase === 'race'
    ? '레이스가 진행 중이에요. 끝나면 다음 레이스에 참가할 수 있어요.'
    : `${hostName} 님이 시작하기를 기다리는 중...`;

  $('toLobby').classList.toggle('hidden', !host);
  $('waitLobby').textContent = host ? '' : `${hostName} 님이 로비로 돌아가기를 기다리는 중...`;
}

const isGp = (S) => S?.on && S.kind === 2;
const gpRunning = (S) => isGp(S) && S.races > 0 && !S.over;

/** 로비에 보일 시리즈(3판 2선승 / 그랑프리) 진행 상황 한 줄 */
function seriesText(S, teams) {
  if (!S?.on) return '';
  if (isGp(S)) {
    if (S.races === 0) return `그랑프리: ${S.max}라운드 포인트 합산 (1위 10, 2위 8, 3위 6…). 고른 트랙 → 무작위 2곳 → 마지막은 그랑프리 서킷`;
    if (S.over) return '지난 그랑프리가 끝났어요. 시작하면 새 그랑프리가 시작돼요.';
    const next = `${S.races + 1}/${S.max}라운드 ${TRACKS[S.tracks[S.races]]?.name ?? ''} 준비 중`;
    if (teams) return `그랑프리 · ${next} · 레드 ${S.teamPoints[0]}점 : ${S.teamPoints[1]}점 블루`;
    const top = S.players.slice(0, 3).map((p) => `${p.name} ${p.points}점`).join(', ');
    return `그랑프리 · ${next} · ${top}`;
  }
  if (S.races === 0) return '3판 2선승: 먼저 2판을 이기면 우승! (3판 뒤에도 2승이 없으면 누적 점수로)';
  if (S.over) return '지난 시리즈가 끝났어요. 시작하면 새 3판 2선승이 시작돼요.';
  const next = `${S.races + 1}판째 준비 중`;
  if (teams) return `3판 2선승 · ${next} · 레드 ${S.teamWins[0]}승 : ${S.teamWins[1]}승 블루`;
  const lead = S.players.filter((p) => p.wins > 0).map((p) => `${p.name} ${p.wins}승`).join(', ') || '아직 승자 없음';
  return `3판 2선승 · ${next} · ${lead}`;
}

// ───────────────────────── 시상식 ─────────────────────────

/** 결과 → 시상대 데이터 (개인전: 1·2·3등 / 팀전: 이긴 팀 선수들) */
function podiumData(m) {
  const S = m.series?.on ? m.series : null;
  const final = !!S?.over;
  const look = (id) => playerOf(id) ?? {};
  const place = (id, name, sub) => ({
    id, name, sub, color: COLORS[(look(id).color ?? 0) % COLORS.length], type: look(id).car ?? 0,
    look: look(id).car === CUSTOM_TYPE ? lookOf(look(id).custom) : null,
  });

  // 순위 목록: 시리즈 최종이면 (승수 → 점수), 단판이면 도착 순서
  const ranked = final
    ? S.players.map((p) => ({ ...place(p.id, p.name, isGp(S) ? `${p.points}점 · ${p.wins}승` : `${p.wins}승 · ${p.points}점`), team: look(p.id).team ?? -1 }))
    : m.list.map((r) => ({ ...place(r.id, r.name, fmtTime(r.time)), team: r.team ?? look(r.id).team ?? -1 }));

  if (!m.teams) {
    return {
      title: ranked[0] ? `${ranked[0].name} 우승!` : '완주한 사람이 없어요',
      subtitle: final ? (isGp(S) ? `그랑프리 종합 결과 · ${S.races}라운드` : `3판 2선승 최종 결과 · ${S.races}판`) : '레이스 결과',
      color: '#ffc531',
      places: ranked.slice(0, 3),
      others: ranked.slice(3).map((r, i) => `${i + 4}위 ${r.name}`).join('   '),
    };
  }

  let win, scoreLine;
  if (final) {
    const [a, b] = isGp(S) ? [0, 0] : S.teamWins, [pa, pb] = S.teamPoints;
    win = a !== b ? (a > b ? 0 : 1) : pa !== pb ? (pa > pb ? 0 : 1) : -1;
    scoreLine = isGp(S) ? `그랑프리 종합  레드 ${pa}점 : ${pb}점 블루` : `3판 2선승 최종  레드 ${a}승 : ${b}승 블루`;
  } else {
    const [a, b] = m.teamScore;
    win = a === b ? -1 : a > b ? 0 : 1;
    scoreLine = `팀 점수  레드 ${a} : ${b} 블루`;
  }
  if (win < 0) {
    return { title: '무승부!', subtitle: scoreLine, color: '#ffffff', places: ranked.slice(0, 3), others: '' };
  }
  const winners = ranked.filter((r) => r.team === win);
  const losers = ranked.filter((r) => r.team !== win).map((r) => r.name);
  return {
    title: `${TEAM_NAMES[win]} 팀 승리!`,
    subtitle: scoreLine,
    color: TEAM_COLORS[win],
    places: winners.slice(0, 3),
    others: losers.length ? `${TEAM_NAMES[1 - win]} 팀: ${losers.join(', ')}` : '',
  };
}

function startPodium(m) {
  podium = new Podium(podiumData(m), {
    land: (i) => (i === 0 ? sound.fanfare() : sound.beep(i === 1 ? 784 : 659, 0.18, 'square', 0.2)),
  });
  mode = 'podium';
  sound.silenceEngine();
  $('lobby').classList.add('hidden');
  $('results').classList.add('hidden');
  chat.placeIn(null);   // 시상식 중엔 채팅이 화면 위에 떠 있음
  updateTouchVisibility();
  clearTimeout(startPodium.timer);
  startPodium.timer = setTimeout(() => { if (mode === 'podium') endPodium(); }, 7500);
}

function endPodium() {
  podium = null;
  if (lastResults) showResults(lastResults);
}

// ───────────────────────── 랭킹 ─────────────────────────

function fetchRecords() {
  fetch('/api/records').then((r) => r.json()).then((data) => {
    records = data;
    renderRecords();
  }).catch(() => { /* 무시 */ });
}

function renderRecords() {
  const list = records[roster.track] ?? [];
  const ol = $('recordList');
  ol.innerHTML = '';
  $('recordTitle').textContent = `${TRACKS[roster.track].name} 랭킹 (스피드전 한 바퀴)`;
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 기록이 없어요. 첫 기록의 주인공이 되어 보세요!';
    ol.append(li);
    return;
  }
  list.slice(0, 5).forEach((r, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span class="place"></span><span class="nm"></span><span class="time"></span>';
    li.querySelector('.place').textContent = i + 1;
    li.querySelector('.nm').textContent = r.name + (r.name === myName ? ' (나)' : '');
    li.querySelector('.time').textContent = fmtTime(r.time);
    ol.append(li);
  });
}

function enterLobby() {
  fetchRecords();
  mode = 'lobby';
  race = null;
  remotes.clear();
  renderer.clearMarks();
  sound.silenceEngine();
  $('lobby').classList.remove('hidden');
  $('results').classList.add('hidden');
  placeChat();
  updateTouchVisibility();
}

// ───────────────────────── 레이스 시작 ─────────────────────────

function makeRemote(id) {
  const r = new RemoteCar(id);
  const p = playerOf(id);
  r.type = p?.car ?? 0;
  r.mass = carSpec(r.type, p?.custom).mass;
  r.team = race?.teams ? p?.team ?? -1 : -1;
  return r;
}

function startRace(m) {
  const track = getTrack(m.track);
  const slot = m.grid.indexOf(me);
  const myP = playerOf(me);
  race = {
    id: m.raceId, track, laps: m.laps, startAt: m.startAt, grid: m.grid, mode: m.mode, teams: !!m.teams,
    series: m.series,
    car: slot >= 0 ? new Car(track, slot, myP?.car ?? myCar, myP?.custom) : null,   // 경기 중에 들어왔거나 관전이면 null
    bots: [],             // 방장일 때 내가 운전하는 봇들
    finishers: [], myTime: null, sendTick: 0, bestLap: null, prevBoost: 0,
    sec: { idx: 0, start: 0, cur: [], best: [null, null, null], pop: null },   // 섹터 기록
    hitCooldown: new Map(), feed: [],
    items: null,
    ghost: null, ghostRec: [],
    specId: null,
    teamGauge: [0, 0], tgAcc: 0,      // 팀 부스터 게이지 / 내가 모은 몫(아직 안 보낸 것)
  };
  if (race.car) {
    race.car.id = me;
    race.car.team = race.teams ? myP?.team ?? -1 : -1;
  }

  // 봇: 방장 브라우저가 운전
  if (isHost()) {
    m.grid.forEach((id, s) => {
      const p = playerOf(id);
      if (!p?.bot) return;
      const bot = new Bot(p, track, s);
      bot.car.team = race.teams ? p.team : -1;
      bot.tgAcc = 0;
      race.bots.push(bot);
    });
  }

  if (m.mode !== 'item') {
    fetch(`/api/ghost/${m.track}`).then((r) => (r.ok ? r.json() : null)).then((g) => {
      if (race && race.id === m.raceId) race.ghost = g;
    }).catch(() => { /* 기록 없음 */ });
  } else {
    // 아이템 판정기: 나 + 내 봇마다 하나씩. 이 브라우저 안에서 생긴 아이템 이벤트는 서로에게 바로 전달
    if (race.car) {
      race.items = new Items(track, me, {
        send: (msg) => { net.send(msg); deliverLocal(msg, me); },
        hitMe: (from, why) => spinMe(from, why),
        slideMe: () => slideCar(race.car, true),
        fx: (msg) => { net.send({ t: 'fx', ...msg }); applyFx({ ...msg, id: me }); },
        sfx: (name) => sound.sfx(name),
        banner: (text, color) => showBanner(text, 1400, color),
        sameTeam: (owner) => sameTeam(owner, me),
      });
    }
    for (const bot of race.bots) {
      bot.items = new Items(track, bot.id, {
        send: (msg) => { net.send({ ...msg, as: bot.id }); deliverLocal(msg, bot.id); },
        hitMe: (from, why) => spinBot(bot, from, why),
        slideMe: () => slideCar(bot.car, false),
        fx: (msg) => { net.send({ t: 'fx', ...msg, as: bot.id }); applyFx({ ...msg, id: bot.id }); },
        sfx: () => {},
        banner: () => {},
        sameTeam: (owner) => sameTeam(owner, bot.id),
      });
    }
    // 관전자: 판정은 안 하고 상자·바나나·미사일을 보여 주기만 하는 판정기
    if (!race.car && !race.bots.length) {
      race.specItems = new Items(track, 0, { send() {}, hitMe() {}, sfx() {}, banner() {} });
    }
  }

  remotes = new Map();
  m.grid.forEach((id, s) => {
    if (id === me || race.bots.some((b) => b.id === id)) return;
    const r = makeRemote(id);
    const g = new Car(track, s);     // 출발 위치에 미리 세워 두기
    Object.assign(r, { x: g.x, y: g.y, a: g.a, visible: true });
    remotes.set(id, r);
  });

  renderer.clearMarks();
  renderer.follow(race.car ?? race.bots[0]?.car ?? remotes.values().next().value, 0, true);
  mode = 'race';
  lastCount = null;
  banner = null;
  $('lobby').classList.add('hidden');
  $('results').classList.add('hidden');
  placeChat();
  updateSpecBar();
  updateTouchVisibility();
}

function raceTime() { return race ? net.serverNow() - race.startAt : 0; }

/** 이 브라우저 안의 아이템 판정기들 (나 + 내 봇들) */
function localItems() {
  if (!race) return [];
  const list = race.bots.map((b) => b.items).filter(Boolean);
  if (race.items) list.push(race.items);
  if (race.specItems) list.push(race.specItems);
  return list;
}

/** 이 브라우저 안에서 생긴 아이템 이벤트를, 보낸 쪽을 뺀 나머지 판정기에 바로 전달 */
function deliverLocal(msg, senderId) {
  for (const it of localItems()) if (it.me !== senderId) it.onRemote({ ...msg, id: senderId }, performance.now());
}

/** 모든 차 (id → 차). 아이템 미사일 목표 찾기 등에 사용 */
function allCars() {
  const map = new Map();
  for (const r of remotes.values()) if (r.visible) map.set(r.id, r);
  for (const b of race.bots) map.set(b.id, b.car);
  if (race.car) map.set(me, race.car);
  return map;
}

/** selfId 와 부딪힐 수 있는 차들 (완주한 차는 유령처럼 통과) */
function collidables(selfId, cars) {
  const out = [];
  for (const [id, c] of cars) if (id !== selfId && !c.finished) out.push(c);
  return out;
}

/** selfId 바로 앞 순위의 상대 팀 차 (미사일 목표) */
function aheadTarget(selfId, st) {
  const i = st.findIndex((s) => s.id === selfId);
  for (let k = i - 1; k >= 0; k--) if (!sameTeam(st[k].id, selfId)) return st[k].id;
  return null;
}

/** 팀 슬립스트림: 같은 팀 차 바로 뒤(40~170px, 차선 폭 안, 같은 방향)에 붙어 빠르게 달리는 중인지 */
function isDrafting(c, selfId, cars) {
  if (!race.teams || c.speed < 250) return false;
  const fx = Math.cos(c.a), fy = Math.sin(c.a);
  for (const [id, o] of cars) {
    if (id === selfId || o.finished || !sameTeam(id, selfId)) continue;
    const dx = o.x - c.x, dy = o.y - c.y;
    const along = dx * fx + dy * fy, side = dx * -fy + dy * fx;
    if (along > 40 && along < 170 && Math.abs(side) < 24 && Math.cos(o.a - c.a) > 0.85) return true;
  }
  return false;
}

/** 팀 게이지 몫을 0.5초마다 서버로 (as: 봇이면 봇 id) */
function flushTeamGauge(holder, asId) {
  if (!race.teams || holder.tgAcc < 1) return;
  const n = Math.min(20, Math.floor(holder.tgAcc));
  holder.tgAcc -= n;
  net.send(asId ? { t: 'tg', n, as: asId } : { t: 'tg', n });
}

/** 팀 게이지 쌓기: 드리프트 초당 6, 슬립스트림 초당 4 */
function gainTeamGauge(holder, c) {
  if (!race.teams || c.finished) return;
  if (c.drifting && c.spin <= 0) holder.tgAcc += 6 * DT;
  if (c.drafting) holder.tgAcc += 4 * DT;
}

function placeOf(selfId, st) {
  const i = st.findIndex((s) => s.id === selfId);
  return st.length > 1 && i >= 0 ? i / (st.length - 1) : 0;   // 0 = 1등, 1 = 꼴찌
}

function carState(c, now) {
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    t: 'st', ts: Math.round(now),
    x: r1(c.x), y: r1(c.y), a: Math.round(c.a * 1000) / 1000, vx: r1(c.vx), vy: r1(c.vy),
    d: c.drifting, b: c.boost > 0, sp: c.spin > 0, sh: c.shield > 0,
    gh: c.ghostly, tw: c.towing, zp: c.zap > 0,
    p: c.progress(race.track), lap: c.lap, fin: c.finished,
  };
}

/** 자석: 쓴 차가 앞 차 쪽으로 끌려가도록 (800px 안에 있을 때) */
function magnetPull(c, cars) {
  if (!(c.magnetT > 0)) return null;
  c.magnetT -= DT;
  const tgt = cars.get(c.magnetTarget);
  if (!tgt || tgt.finished || Math.hypot(tgt.x - c.x, tgt.y - c.y) > 800) return null;
  return { x: tgt.x, y: tgt.y };
}

/** 빠지거나(용암·바다) 감전되면 효과 */
function trackFx(c, isMe) {
  if (c.fell) {
    const lava = c.fell.kind === 'lava', cliff = c.fell.kind === 'cliff';
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, sp = 80 + Math.random() * 260;
      renderer.puff(c.fell.x, c.fell.y, lava ? (Math.random() < 0.5 ? 'rgba(255,120,20,' : 'rgba(255,210,60,')
        : cliff ? 'rgba(170,160,145,' : 'rgba(200,235,255,',
        5 + Math.random() * 6, Math.cos(a) * sp, Math.sin(a) * sp, 0.6);
    }
    if (isMe) {
      showBanner(lava ? '용암에 빠졌어요! 견인 중…' : cliff ? '절벽에서 떨어졌어요! 견인 중…' : '바다에 빠졌어요! 견인 중…',
        1500, lava ? '#ff7a2e' : cliff ? '#d9cdb8' : '#7cc4ff');
      sound.sfx(lava ? 'lava' : cliff ? 'fall' : 'splash');
      renderer.shake = 12;
    }
  }
  if (c.zapHit) {
    renderer.sparks(c.x, c.y, 10);
    if (isMe) sound.sfx('zapHit');
  }
}

// ───────────────────────── 매 프레임 ─────────────────────────

function stepRace() {
  const car = race.car;
  const t = raceTime();
  const now = net.serverNow();
  for (const r of remotes.values()) r.update(now);
  const cars = allCars();
  const st = standings();

  stepBots(t, now, cars, st);

  if (race.items) race.items.update(DT, performance.now(), car && t >= 0 ? car : null, cars, placeOf(me, st));
  race.specItems?.update(DT, performance.now(), null, cars, 0);
  if (!car) return;

  const canDrive = t >= 0 && !car.finished;
  const input = canDrive ? readInput() : { throttle: false, brake: car.finished && car.speed > 30, steer: 0, handbrake: false };
  input.draft = canDrive && isDrafting(car, me, cars);
  input.pull = canDrive ? magnetPull(car, cars) : null;
  const prev = { x: car.x, y: car.y, a: car.a };
  car.step(input, DT, race.track, car.finished ? [] : collidables(me, cars), Math.max(0, t));
  trackFx(car, true);
  gainTeamGauge(race, car);
  if (race.sendTick % 30 === 0) flushTeamGauge(race, null);

  // 내가 상대 뒤 모서리를 박았으면 → 서버를 거쳐 상대(또는 봇의 주인)에게
  for (const h of car.hits) {
    const last = race.hitCooldown.get(h.id) ?? -1e9;
    if (now - last < 1200 || sameTeam(h.id, me)) continue;
    race.hitCooldown.set(h.id, now);
    net.send({ t: 'hit', target: h.id, side: h.side, power: Math.round(h.power) });
    renderer.sparks(h.x, h.y);
    sound.clank();
  }

  if (car.drifting) renderer.addSkid(car, prev);
  renderer.emitFor(car, DT);
  if (car.bumped > 140) {
    sound.bump(car.bumped);
    renderer.shake = Math.min(14, car.bumped / 40);
  }
  car.bumped = 0;
  if (car.boost > 0 && race.prevBoost <= 0) {
    sound.boost();
    renderer.shake = Math.max(renderer.shake, 5);
  }
  race.prevBoost = car.boost;
  sound.update(car.speed, input.throttle, car.drifting, car.boost > 0);

  // 고스트용 주행 기록 (스피드전): 이번 바퀴 시작부터 0.1초마다 위치 하나
  if (race.mode !== 'item' && t >= 0 && !car.finished && !car.justLapped) {
    const lapElapsed = t - car.lapStart;
    while (race.ghostRec.length / 3 <= lapElapsed / 100)
      race.ghostRec.push(Math.round(car.x), Math.round(car.y), Math.round(car.a * 100) / 100);
  }

  trackSectors(car, t);
  if (car.justLapped) {
    car.justLapped = false;
    const lt = car.lapTimes[car.lapTimes.length - 1];
    if (race.bestLap == null || lt < race.bestLap) race.bestLap = lt;
    if (race.mode !== 'item') net.send({ t: 'lap', time: Math.round(lt), ghost: race.ghostRec });
    race.ghostRec = [];
    if (car.lap > race.laps) {
      car.finished = true;
      race.myTime = t;
      net.send({ t: 'fin', time: Math.round(t) });
      sound.fanfare();
      showBanner('FINISH!', 4000, '#ffc531');
      race.specId = null;
      updateSpecBar();
      updateTouchVisibility();
    } else if (car.lap === race.laps) {
      showBanner('마지막 바퀴!', 1800, '#ff5a4f');
      sound.beep(988, 0.25);
    } else {
      showBanner(`LAP ${car.lap}  ·  ${fmtTime(lt)}`, 1600, '#ffffff');
      sound.beep(784, 0.15);
    }
  }

  if (++race.sendTick % 3 === 0) net.send(carState(car, now));   // 초당 20번
}

/** 방장: 봇 운전 + 위치 보내기 */
function stepBots(t, now, cars, st) {
  for (const bot of race.bots) {
    const c = bot.car;
    const others = c.finished ? [] : collidables(bot.id, cars);
    const prev = { x: c.x, y: c.y, a: c.a };
    const input = t >= 0 && !c.finished
      ? bot.think(DT, others)
      : { throttle: false, brake: c.finished && c.speed > 30, steer: 0, handbrake: false };
    input.draft = t >= 0 && !c.finished && isDrafting(c, bot.id, cars);
    input.pull = t >= 0 && !c.finished ? magnetPull(c, cars) : null;
    c.step(input, DT, race.track, others, Math.max(0, t));
    trackFx(c, false);
    gainTeamGauge(bot, c);
    if (bot.sendTick % 30 === 0) flushTeamGauge(bot, bot.id);

    for (const h of c.hits) {
      const last = bot.hitCooldown.get(h.id) ?? -1e9;
      if (now - last < 1200 || sameTeam(h.id, bot.id)) continue;
      bot.hitCooldown.set(h.id, now);
      net.send({ t: 'hit', target: h.id, side: h.side, power: Math.round(h.power), as: bot.id });
      renderer.sparks(h.x, h.y);
    }
    c.bumped = 0;
    if (c.drifting) renderer.addSkid(c, prev);
    renderer.emitFor(c, DT);

    if (c.justLapped) {
      c.justLapped = false;
      if (c.lap > race.laps) {
        c.finished = true;
        net.send({ t: 'fin', time: Math.round(t), as: bot.id });
      }
    }

    if (bot.items) {
      bot.items.update(DT, performance.now(), t >= 0 ? c : null, cars, placeOf(bot.id, st));
      const fx = Math.cos(c.a), fy = Math.sin(c.a);
      const behindClose = [...cars].some(([id, o]) => id !== bot.id && !sameTeam(id, bot.id)
        && (o.x - c.x) * fx + (o.y - c.y) * fy < 0 && Math.hypot(o.x - c.x, o.y - c.y) < 250);
      bot.thinkItem(DT, performance.now(), {
        behindClose, aheadId: aheadTarget(bot.id, st), incomingMissile: !!bot.items.incomingMissile, curve: input.curve,
        place: placeOf(bot.id, st),
      });
    }

    if (++bot.sendTick % 3 === 0) net.send({ ...carState(c, now), as: bot.id });
  }
}

function useItem() {
  if (mode !== 'race' || !race?.items || !race.car || raceTime() < 0) return;
  race.items.use(race.car, performance.now(), aheadTarget(me, standings()));
}

/** 순위: 완주한 순서 → 그다음 진행도 */
function standings() {
  if (!race) return [];
  const finIndex = (id) => race.finishers.findIndex((f) => f.id === id);
  const list = [];
  for (const id of race.grid) {
    let prog;
    if (id === me) { if (!race.car) continue; prog = race.car.progress(race.track); }
    else {
      const bot = race.bots.find((b) => b.id === id);
      if (bot) prog = bot.car.progress(race.track);
      else if (remotes.has(id)) prog = remotes.get(id).prog;
      else continue;
    }
    const fi = finIndex(id);
    list.push({ id, score: fi >= 0 ? 1e12 - fi * 1e9 : prog });
  }
  return list.sort((a, b) => b.score - a.score);
}

/** 팀전 현재 점수 (지금 순위 기준) */
function teamScores(order) {
  const s = [0, 0];
  order.forEach((id, i) => {
    const team = teamOf(id);
    if (team >= 0) s[team] += PLACE_POINTS[Math.min(i, PLACE_POINTS.length - 1)];
  });
  return s;
}

function showBanner(text, ms, color) {
  banner = { text, until: performance.now() + ms, color, start: performance.now() };
}

function showResults(m) {
  mode = 'results';
  sound.silenceEngine();
  const ol = $('resultList');
  ol.innerHTML = '';
  const add = (place, id, name, time) => {
    const li = document.createElement('li');
    const p = playerOf(id);
    li.innerHTML = '<span class="place"></span><span class="dot"></span><span class="nm"></span><span class="time"></span>';
    li.querySelector('.place').textContent = place;
    li.querySelector('.dot').style.background = COLORS[(p?.color ?? 0) % COLORS.length];
    li.querySelector('.nm').textContent = name + (id === me ? ' (나)' : '') + (p?.bot ? ' · 봇' : '');
    li.querySelector('.time').textContent = time;
    if (m.teams && p?.team >= 0) li.style.borderLeft = `5px solid ${TEAM_COLORS[p.team]}`;
    ol.append(li);
  };
  m.list.forEach((r, i) => add(i + 1, r.id, r.name, fmtTime(r.time)));
  m.dnf.forEach((r) => add('-', r.id, r.name, '완주 못함'));

  const ts = $('teamScore');
  ts.classList.toggle('hidden', !m.teams);
  if (m.teams) {
    const [r, b] = m.teamScore;
    ts.innerHTML = '<span class="red"></span><span class="vs">:</span><span class="blue"></span><div class="who"></div>';
    ts.querySelector('.red').textContent = `레드 ${r}`;
    ts.querySelector('.blue').textContent = `${b} 블루`;
    ts.querySelector('.who').textContent = r === b ? '무승부!' : r > b ? '레드 팀 승리!' : '블루 팀 승리!';
  }

  // 3판 2선승 전적표
  const S = m.series?.on ? m.series : null;
  const box = $('seriesBox');
  box.classList.toggle('hidden', !S);
  const gp = isGp(S);
  $('resultTitle').textContent = !S ? '레이스 결과' : gp
    ? (S.over ? '그랑프리 종합 결과' : `그랑프리 ${S.races}/${S.max}라운드 결과`)
    : (S.over ? '3판 2선승 최종 결과' : `${S.races}판 결과 (3판 2선승)`);
  if (S) {
    box.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = gp
      ? (m.teams ? `종합 포인트  레드 ${S.teamPoints[0]}점 : 블루 ${S.teamPoints[1]}점` : `종합 포인트 · ${S.races}/${S.max}라운드`)
      : m.teams
      ? `시리즈 전적  레드 ${S.teamWins[0]}승 (${S.teamPoints[0]}점) : 블루 ${S.teamWins[1]}승 (${S.teamPoints[1]}점)`
      : `시리즈 전적 · ${S.races}판 진행`;
    const table = document.createElement('table');
    for (const p of S.players) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td></td><td class="stars"></td><td class="num"></td>';
      const tm = playerOf(p.id)?.team;
      tr.children[0].textContent = p.name + (p.id === me ? ' (나)' : '');
      if (m.teams && tm >= 0) tr.children[0].style.color = TEAM_COLORS[tm];
      tr.children[1].textContent = gp ? (p.wins ? `🏆×${p.wins}` : '') : '★'.repeat(p.wins) + '☆'.repeat(Math.max(0, S.need - p.wins));
      tr.children[2].textContent = `${p.points}점`;
      table.append(tr);
    }
    box.append(head, table);
    if (!S.over) {
      const next = document.createElement('div');
      next.className = 'next';
      next.textContent = gp
        ? `다음은 ${S.races + 1}라운드: ${TRACKS[S.tracks[S.races]]?.name ?? ''}! 방장이 로비로 돌아가 시작해요.`
        : `다음은 ${S.races + 1}판째! 방장이 로비로 돌아가 트랙을 고르고 시작해요.`;
      box.append(next);
    }
  }
  $('toLobby').textContent = S && !S.over ? (gp ? `${S.races + 1}라운드 준비하기` : `${S.races + 1}판째 준비하기`) : '로비로 돌아가기';
  $('replayPodium').classList.toggle('hidden', !!(S && !S.over));

  renderLobby();
  $('results').classList.remove('hidden');
  placeChat();
  updateTouchVisibility();
}

// ───────────────────────── 그리기 ─────────────────────────

function nameOf(c) {
  if (c.id === me) return null;
  const p = playerOf(c.id);
  return p ? p.name : '';
}

function draw(time) {
  const t = time / 1000;
  if (mode === 'lobby' || !race) {
    const track = getTrack(roster.track);
    const i = Math.floor(t * 18) % track.n, p = track.pts[i];
    renderer.follow({ x: p.x, y: p.y, vx: p.tx * 300, vy: p.ty * 300 }, DT);
    renderer.drawWorld(track, [], () => null, t);
    return;
  }

  const cars = [];
  const decorate = (c, id) => {
    const p = playerOf(id);
    c.id = id;
    c.color = p?.color ?? 0;
    c.type = p?.car ?? c.type ?? 0;
    c.look = p?.car === CUSTOM_TYPE ? lookOf(p.custom) : null;   // 커스텀 차는 그 사람이 만든 생김새로
    c.teamColor = race.teams && p?.team >= 0 ? TEAM_COLORS[p.team] : null;
    cars.push(c);
  };
  for (const r of remotes.values()) if (r.visible && playerOf(r.id)) decorate(r, r.id);
  for (const b of race.bots) decorate(b.car, b.id);
  if (race.car) decorate(race.car, me);

  for (const r of remotes.values()) {
    if (r.drifting) renderer.addSkid(r, r.prevPos);
    renderer.emitFor({ ...r, offroad: false, driftCharge: 0, boost: r.boosting ? 1 : 0, speed: r.speed }, DT);
    r.prevPos = { x: r.x, y: r.y, a: r.a };
  }

  const st = standings();
  let target = race.car;
  if (spectating()) {
    const id = race.specId ?? st.find((s) => s.id !== me)?.id;
    target = cars.find((c) => c.id === id) ?? race.car ?? cars[0];
    if (race.specId == null && id != null) { race.specId = id; updateSpecBar(); }
  }
  renderer.follow(target, DT);
  renderer.raceTime = Math.max(0, raceTime()) / 1000;   // 바람 방향을 차 물리와 같은 시계로
  renderer.drawWorld(race.track, cars, nameOf, t, (ctx) => {
    // 아이템 상자·바나나·미사일 (판정기들은 같은 이벤트를 받으므로 하나만 그리면 됨)
    (race.items ?? localItems()[0])?.draw(ctx, t, performance.now());
    drawGhost(ctx);
  });
  drawInk();
  drawHud(st, cars);
}

/** 먹물: 앞 차가 쓴 먹물을 맞으면 화면 가운데가 3.5초 동안 얼룩짐 (마지막 1초에 서서히 걷힘) */
function drawInk() {
  const left = (race.inkUntil ?? 0) - performance.now();
  if (left <= 0 || spectating()) return;
  const R = renderer, ctx = R.ctx;
  const alpha = Math.min(1, left / 1000) * 0.92;
  let seed = race.inkSeed * 1000;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#14101e';
  for (let i = 0; i < 9; i++) {
    const x = R.w * (0.25 + rnd() * 0.5), y = R.h * (0.25 + rnd() * 0.5), r = Math.min(R.w, R.h) * (0.08 + rnd() * 0.12);
    ctx.beginPath();
    for (let k = 0; k <= 16; k++) {
      const a = (k / 16) * Math.PI * 2, rr = r * (0.75 + 0.35 * Math.sin(a * 3 + i));
      k ? ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.fill();
  }
  ctx.restore();
}

function ghostPose() {
  const g = race.ghost, car = race.car;
  if (!g || !ghostOn || !car || car.finished) return null;
  const elapsed = raceTime() - car.lapStart;
  if (elapsed < 0) return null;
  const k = elapsed / (1000 / g.hz), i = Math.floor(k), n = g.frames.length / 3;
  if (i + 1 >= n) return null;
  const f = g.frames, u = k - i;
  let da = f[i * 3 + 5] - f[i * 3 + 2];
  da = Math.atan2(Math.sin(da), Math.cos(da));
  return {
    x: f[i * 3] + (f[i * 3 + 3] - f[i * 3]) * u,
    y: f[i * 3 + 1] + (f[i * 3 + 4] - f[i * 3 + 1]) * u,
    a: f[i * 3 + 2] + da * u,
  };
}

function drawGhost(ctx) {
  const p = ghostPose();
  if (!p) return;
  ctx.save();
  ctx.globalAlpha = 0.38;
  renderer.drawCar(p, '#e9ecf5');
  ctx.globalAlpha = 0.75;
  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`고스트 · ${race.ghost.name}`, p.x, p.y - 26);
  ctx.restore();
}

// ───────────────────────── 섹터 기록 ─────────────────────────
// 한 바퀴를 체크포인트 기준으로 3등분해서 구간마다 시간을 재고, 내 최고 구간 기록과 비교한다.

function trackSectors(car, t) {
  const S = race.sec, C = race.track.cps.length;
  if (car.finished || t < 0) return;
  const bounds = [Math.round(C / 3), Math.round((2 * C) / 3)];
  if (car.justLapped) {
    const lt = car.lapTimes[car.lapTimes.length - 1];
    if (S.cur[0] != null && S.cur[1] != null) finishSector(2, lt - S.cur[0] - S.cur[1]);
    S.cur = []; S.idx = 0; S.start = car.lapStart;
    return;
  }
  if (S.idx < 2 && car.nextCp > bounds[S.idx]) {
    finishSector(S.idx, t - S.start);
    S.start = t;
    S.idx++;
  }
}

function finishSector(i, v) {
  const S = race.sec, best = S.best[i];
  const pb = best == null || v < best;
  S.cur[i] = v;
  if (pb) S.best[i] = v;
  S.pop = { i, v, delta: best == null ? null : v - best, pb, until: performance.now() + 2600 };
}

/** 화면 위쪽 가운데: S1 S2 S3 칸 (보라 = 내 최고 경신, 노랑 = 더 느림) + 방금 끝난 섹터 시간 */
function drawSectors(R, s, car, rt, suffix = '') {
  const S = race.sec, ctx = R.ctx;
  const w = 74 * s, h = 22 * s, gap = 6, x0 = R.w / 2 - (w * 3 + gap * 2) / 2, y = (race.teams ? 96 : 10) * s;   // 팀전이면 팀 점수 아래
  const now = performance.now();
  for (let i = 0; i < 3; i++) {
    const x = x0 + i * (w + gap), v = S.cur[i];
    const done = v != null, isPb = done && S.best[i] === v;
    ctx.fillStyle = !done ? (i === S.idx ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.4)') : isPb ? '#9b5cff' : '#c99a00';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 6); ctx.fill();
    R.text(done ? `S${i + 1} ${(v / 1000).toFixed(2)}` : `S${i + 1}`, x + w / 2, y + h * 0.74, 13 * s, '#ffffff', 'center', '800');
  }
  R.text(`이번 랩 ${fmtTime(Math.max(0, rt - car.lapStart))}${suffix ? ' · ' + suffix : ''}`, R.w / 2, y + h + 20 * s, 15 * s, '#ffffff', 'center', '700');
  const p = S.pop;
  if (p && now < p.until) {
    const d = p.delta == null ? '' : ` (${p.delta <= 0 ? '−' : '+'}${Math.abs(p.delta / 1000).toFixed(2)})`;
    R.text(`섹터 ${p.i + 1}  ${(p.v / 1000).toFixed(2)}${d}${p.pb && p.delta != null ? '  최고 기록!' : ''}`,
      R.w / 2, y + h + 44 * s, 18 * s, p.pb ? '#c9a2ff' : '#ffe14d', 'center', '900');
  }
}

function drawHud(st, cars) {
  const R = renderer;
  R.beginScreen();
  const car = race.car;
  const rt = raceTime();
  const s = R.w < 600 ? 0.78 : 1;
  const bottomPad = touch.active && car && !car.finished ? 150 : 24;

  if (car) {
    const lap = Math.min(car.lap, race.laps);
    R.text(`LAP ${lap}/${race.laps}`, 20, 44 * s, 34 * s);
    const place = st.findIndex((x) => x.id === me) + 1;
    R.text(`${place}위`, 20, 84 * s, 30 * s, '#ffc531');
    R.text(`/ ${st.length}`, 20 + (place >= 10 ? 62 : 46) * s, 84 * s, 18 * s, '#dddddd');
    R.text(fmtTime(car.finished ? race.myTime : Math.max(0, rt)), 20, 114 * s, 20 * s);
    if (race.bestLap != null) {
      const last = car.lapTimes[car.lapTimes.length - 1];
      R.text(`최고 랩 ${fmtTime(race.bestLap)} · 직전 ${fmtTime(last)}`, 20, 138 * s, 15 * s, '#cfd3da', 'left', '600');
    }
    const seriesLabel = !race.series?.on ? ''
      : isGp(race.series) ? `그랑프리 ${race.series.races + 1}/${race.series.max}R` : `3판 2선승 ${race.series.races + 1}판째`;
    const showSectors = !car.finished && rt >= 0;
    // 좁은 화면에서는 섹터 칸과 겹치지 않게 시리즈 표시를 "이번 랩" 줄에 붙인다
    if (seriesLabel && !(showSectors && R.w < 900))
      R.text(seriesLabel, 150 * s, 44 * s, 15 * s, '#ffe08a', 'left', '800');
    if (showSectors) drawSectors(R, s, car, rt, R.w < 900 ? seriesLabel : '');
    if (race.ghost && !race.items)
      R.text(`트랙 기록 ${fmtTime(race.ghost.time)} · ${race.ghost.name}${ghostOn ? '' : ' (G: 고스트 켜기)'}`,
        20, (race.bestLap != null ? 158 : 138) * s, 14 * s, '#ffe08a', 'left', '600');

    if (!car.finished) {
      const kmh = Math.round(car.speed * 0.36);
      const bx = R.w - 20, by = R.h - bottomPad;
      R.text(`${kmh}`, bx - 56, by, 42 * s, '#ffffff', 'right');
      R.text('km/h', bx, by, 16 * s, '#cfd3da', 'right');
      const charge = Math.min(1, car.driftCharge / 1.5);
      if (car.driftCharge > 0.1 || car.boost > 0) {
        const ctx = R.ctx, w = 150 * s;
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath(); ctx.roundRect(bx - w, by - 70 * s, w, 10, 5); ctx.fill();
        ctx.fillStyle = car.boost > 0 ? '#ff8a3d' : charge >= 1 ? '#ff9a2e' : car.driftCharge > 0.7 ? '#4fb3ff' : '#9aa3b2';
        ctx.beginPath(); ctx.roundRect(bx - w, by - 70 * s, w * (car.boost > 0 ? Math.min(1, car.boost) : charge), 10, 5); ctx.fill();
        R.text(car.boost > 0 ? '부스트!' : '드리프트 터보', bx, by - 78 * s, 13 * s, '#ffffff', 'right', '600');
      }
    }
  }
  if (spectating()) {
    const p = playerOf(race.specId);
    R.text(car ? '완주! 다른 차를 보고 있어요' : '관전 중', R.w / 2, R.h - (touch.active ? 96 : 70), 16 * s, '#ffffff', 'center', '700');
    if (p && !touch.active) R.text('[ ] 또는 ← → 로 다른 차 보기', R.w / 2, R.h - 48, 13 * s, '#cfd3da', 'center', '600');
  }

  if (race.items && car && !car.finished) drawItemSlot(R, s);

  const mapBottom = R.minimap(race.track, cars, me);

  const y = mapBottom + 26;
  race.finishers.forEach((f, i) => {
    const p = playerOf(f.id);
    R.text(`${i + 1}. ${p?.name ?? '?'}  ${fmtTime(f.time)}`, R.w - 20, y + i * 22, 15 * s, '#ffffff', 'right', '600');
  });

  // 팀전: 현재 점수 + 팀 부스터 게이지 + 화면 밖 팀원 화살표
  let feedY = 34;
  if (race.teams) {
    const [r, b] = teamScores(st.map((x) => x.id));
    R.text(`레드 ${r}`, R.w / 2 - 14, 34, 22 * s, TEAM_COLORS[0], 'right', '900');
    R.text(':', R.w / 2, 34, 22 * s, '#ffffff', 'center', '900');
    R.text(`${b} 블루`, R.w / 2 + 14, 34, 22 * s, TEAM_COLORS[1], 'left', '900');
    drawTeamGauges(R, s);
    drawTeammateArrows(R, cars, s);
    feedY = 84;
  }
  if (car && !car.finished && rt >= 0) feedY += 84 * s;   // 섹터 칸 아래로

  if (rt < 0) {
    const n = Math.ceil(-rt / 1000);
    if (n <= 3) {
      if (lastCount !== n) { sound.beep(440, 0.18); lastCount = n; }
      const frac = 1 - ((-rt / 1000) % 1);
      R.text(String(n), R.w / 2, R.h / 2 + 30, (110 + frac * 40) * s, '#ffffff', 'center', '900');
    } else {
      R.text('곧 출발합니다', R.w / 2, R.h / 2, 34 * s, '#ffffff', 'center');
    }
  } else if (rt < 900) {
    if (lastCount !== 0) { sound.beep(880, 0.35); lastCount = 0; }
    R.text('GO!', R.w / 2, R.h / 2 + 30, 130 * s, '#ffc531', 'center', '900');
  }

  const nowMs = performance.now();
  race.feed = race.feed.filter((f) => f.until > nowMs);
  race.feed.forEach((f, i) => R.text(f.text, R.w / 2, feedY + i * 24, 17 * s, f.mine ? '#ffc531' : '#ffffff', 'center', '700'));

  if (banner && nowMs < banner.until) {
    const k = Math.min(1, (nowMs - banner.start) / 250);
    R.text(banner.text, R.w / 2, R.h * 0.28, (24 + 16 * k) * s, banner.color, 'center', '900');
  }

  if (car && !car.finished && rt > 0 && rt < 6000 && !touch.active)
    R.text('Space 드리프트 → 놓으면 미니 터보!  상대 뒤 모서리를 박으면 스핀!', R.w / 2, R.h - 24, 15, '#ffffff', 'center', '600');
}

/** 팀 부스터 게이지 두 개 (레드 왼쪽, 블루 오른쪽). 꽉 차면 팀 전원 부스트 */
function drawTeamGauges(R, s) {
  const ctx = R.ctx, w = 110 * s, h = 8, y = 46;
  const myTeam = teamOf(me);
  race.teamGauge.forEach((g, team) => {
    const x = team === 0 ? R.w / 2 - 14 - w : R.w / 2 + 14;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.fill();
    const fw = w * Math.min(1, g / 100);
    ctx.fillStyle = TEAM_COLORS[team];
    ctx.beginPath();
    if (team === 0) ctx.roundRect(x + w - fw, y, fw, h, 4); else ctx.roundRect(x, y, fw, h, 4);
    ctx.fill();
    if (team === myTeam) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(x, y, w, h, 4); ctx.stroke();
    }
  });
  R.text('팀 부스터', R.w / 2, y + h + 1, 10 * s, '#e6e9ef', 'center', '700');
  if (race.car?.drafting) R.text('슬립스트림!', R.w / 2, y + h + 34, 15 * s, '#bfe3ff', 'center', '800');
}

/** 화면 밖에 있는 팀원 → 화면 가장자리에 팀 색 화살표 + 이름 */
function drawTeammateArrows(R, cars, s) {
  const myTeam = teamOf(me);
  if (myTeam < 0) return;
  const ctx = R.ctx, cam = R.cam, m = 34;
  for (const c of cars) {
    if (c.id === me || teamOf(c.id) !== myTeam || c.finished) continue;
    const sx = (c.x - cam.x) * cam.zoom + R.w / 2, sy = (c.y - cam.y) * cam.zoom + R.h / 2;
    if (sx > 0 && sx < R.w && sy > 0 && sy < R.h) continue;   // 화면 안이면 생략
    const ang = Math.atan2(sy - R.h / 2, sx - R.w / 2);
    // 화면 가운데에서 그 방향으로 가다가 가장자리(여백 m)에 닿는 점
    const k = Math.min(Math.abs((R.w / 2 - m) / Math.cos(ang) || 1e9), Math.abs((R.h / 2 - m) / Math.sin(ang) || 1e9));
    const ax = R.w / 2 + Math.cos(ang) * k, ay = R.h / 2 + Math.sin(ang) * k;
    ctx.save();
    ctx.translate(ax, ay);
    ctx.rotate(ang);
    ctx.fillStyle = TEAM_COLORS[myTeam];
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -10); ctx.lineTo(-4, 0); ctx.lineTo(-8, 10); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    const dist = Math.round(Math.hypot(c.x - (race.car?.x ?? cam.x), c.y - (race.car?.y ?? cam.y)) / 10);
    R.text(`${playerOf(c.id)?.name ?? ''} ${dist}m`, ax - Math.cos(ang) * 22, ay - Math.sin(ang) * 22 + 4, 12 * s, '#ffffff', 'center', '700');
  }
}

function drawItemSlot(R, s) {
  const ctx = R.ctx, items = race.items;
  const size = 64 * s, x = 20, y = 168 * s;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.strokeStyle = items.slot ? '#ffc531' : 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 12);
  ctx.fill();
  ctx.stroke();

  const now = performance.now();
  const kinds = Object.keys(ITEM_NAMES);
  const kind = items.rolling ? kinds[Math.floor(now / 70) % kinds.length] : items.slot;
  if (kind) drawIcon(ctx, kind, x + size / 2, y + size / 2, size * 0.7, now / 1000);
  const key = touch.active ? '' : '  [Shift/E]';
  const count = items.slot === 'boost3' && items.charges > 0 ? ` (${items.charges})` : '';
  const label = items.rolling ? '뽑는 중...' : items.slot ? `${ITEM_NAMES[items.slot]}${count}${key}` : '? 상자를 먹으세요';
  R.text(label, x + size + 10, y + size / 2 + (items.slot && !items.rolling ? -2 : 6), 15 * s, items.slot ? '#ffffff' : '#cfd3da', 'left', '700');
  if (items.slot && !items.rolling && ITEM_HELP[items.slot])
    R.text(ITEM_HELP[items.slot], x + size + 10, y + size / 2 + 18 * s, 12 * s, '#cfd3da', 'left', '600');

  if (items.incomingMissile && Math.floor(now / 150) % 2 === 0)
    R.text('⚠ 미사일 접근!  보호막이 있으면 쓰세요', R.w / 2, R.h * 0.2, 22 * s, '#ff5a4f', 'center', '900');
}

// ───────────────────────── 루프 ─────────────────────────

let acc = 0, last = performance.now();
function frame(time) {
  acc += Math.min(0.25, (time - last) / 1000);
  last = time;
  while (acc >= DT) {
    acc -= DT;
    if ((mode === 'race' || mode === 'results') && race) stepRace();
    renderer.updateParticles(DT);
  }
  if (mode === 'lobby' || mode === 'podium') sound.silenceEngine();
  if (mode === 'podium' && podium) podium.draw(renderer);
  else draw(time);
  requestAnimationFrame(frame);
}

// ───────────────────────── 시작 ─────────────────────────

updateLink();
renderCars();
renderLobby();
placeChat();
fetchRecords();
fetch('/api/info').then((r) => r.json()).then((info) => {
  if (info.lan?.length) {
    lanBase = info.lan[0];
    updateLink();
  }
}).catch(() => { /* 정적 호스팅이면 없음 */ });
net.connect(roomCode, myName);
requestAnimationFrame(frame);
