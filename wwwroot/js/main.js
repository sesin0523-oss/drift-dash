// Drift Dash 메인: 로비 → 카운트다운 → 레이스 → 결과
// 내 차는 내 브라우저에서 계산(렉 없음), 상대 차는 서버가 중계한 위치를 보간해서 그림.

import { TRACKS, buildTrack } from './track.js';
import { Car } from './car.js';
import { Net, RemoteCar } from './net.js';
import { Renderer, COLORS, fmtTime } from './render.js';
import { Sound } from './audio.js';
import { Chat } from './chat.js';
import { Items, drawIcon, ITEM_NAMES } from './items.js';

const DT = 1 / 60;
const $ = (id) => document.getElementById(id);
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* 무시 */ } },
};

// ───────────────────────── 방 코드 / 이름 ─────────────────────────

const params = new URLSearchParams(location.search);
let roomCode = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
if (roomCode.length < 3) {
  roomCode = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  history.replaceState(null, '', `?room=${roomCode}`);
}
let myName = store.get('dd-name') || `드라이버${Math.floor(Math.random() * 90 + 10)}`;

// ───────────────────────── 상태 ─────────────────────────

const net = new Net();
const renderer = new Renderer($('game'));
const sound = new Sound();

let me = 0;
let roster = { host: 0, phase: 'lobby', track: 0, laps: 3, players: [] };
let mode = 'lobby';            // lobby | race | results
let race = null;               // 진행 중인 레이스
let remotes = new Map();       // id → RemoteCar
const trackCache = new Map();
let lanBase = null;            // localhost 로 열었을 때 친구에게 줄 주소
let banner = null;             // { text, until, color }
let lastCount = null;
let records = [];              // 트랙별 TOP 10 [{name, time}]
let ghostOn = store.get('dd-ghost') !== '0';

const getTrack = (i) => {
  if (!trackCache.has(i)) trackCache.set(i, buildTrack(i));
  return trackCache.get(i);
};
const playerOf = (id) => roster.players.find((p) => p.id === id);
const isHost = () => roster.host === me;

// ───────────────────────── 입력 ─────────────────────────

const keys = new Set();

const chat = new Chat({
  send: (text) => net.send({ t: 'chat', text }),
  colorOf: (c) => COLORS[(c ?? 0) % COLORS.length],
  onOpenChange: () => keys.clear(),            // 채팅 여닫을 때 눌려 있던 키 초기화
  onIncoming: (m) => { if (m.id !== me) sound.beep(1320, 0.06, 'sine', 0.12); },
});

function placeChat() {
  chat.placeIn(mode === 'lobby' ? $('lobby') : mode === 'results' ? $('results') : null);
}
const touch = { left: false, right: false, brake: false, drift: false, active: false };
const GAME_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight', 'KeyE'];
const ITEM_KEYS = ['ShiftLeft', 'ShiftRight', 'KeyE'];   // Ctrl 은 W 와 같이 누르면 탭이 닫혀서 안 씀

addEventListener('keydown', (e) => {
  sound.unlock();
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Enter' && chat.floating && !chat.isOpen) {   // 레이스 중 Enter → 채팅
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
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
addEventListener('pointerdown', () => sound.unlock());

// 휴대폰: 화면을 처음 만지면 터치 버튼 표시 (가속은 자동)
addEventListener('touchstart', () => {
  if (!touch.active) {
    touch.active = true;
    updateTouchVisibility();
  }
}, { passive: true });
for (const btn of document.querySelectorAll('#touch button')) {
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
  $('touch').classList.toggle('hidden', !(touch.active && mode === 'race'));
  document.body.classList.toggle('touch', touch.active);
}

function readInput() {
  const k = (c) => keys.has(c);
  const left = k('ArrowLeft') || k('KeyA') || touch.left;
  const right = k('ArrowRight') || k('KeyD') || touch.right;
  const brake = k('ArrowDown') || k('KeyS') || touch.brake;
  return {
    throttle: k('ArrowUp') || k('KeyW') || (touch.active && !touch.brake),
    brake,
    steer: (right ? 1 : 0) - (left ? 1 : 0),
    handbrake: k('Space') || touch.drift,
  };
}

// ───────────────────────── 네트워크 ─────────────────────────

net.on('welcome', (m) => {
  me = m.you;
  roomCode = m.room;
  updateLink();
});

net.on('roster', (m) => {
  roster = m;
  if (m.phase === 'lobby' && mode !== 'lobby') enterLobby();
  renderLobby();
});

net.on('race', (m) => startRace(m));

net.on('st', (m) => {
  if (!race || m.id === me) return;
  let r = remotes.get(m.id);
  if (!r) remotes.set(m.id, (r = new RemoteCar(m.id)));
  r.push(m);
});

net.on('fin', (m) => {
  if (!race) return;
  race.finishers.push(m);
  const p = playerOf(m.id);
  if (m.id !== me) showBanner(`${p ? p.name : '?'} 완주! (${m.place}위)`, 2000, '#ffffff');
});

/**
 * 내 차를 스핀시킴 (뒤 모서리 박힘 / 바나나 / 미사일 공통).
 * 스핀 중·직후거나 보호막이 있으면 막힘. 실제로 돌았으면 모두에게 알림.
 */
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

// 누가 내 뒤 모서리를 박았다
net.on('hit', (m) => spinMe(m.from, 'bump', m.side, m.power));

// 누군가 스핀 → 화면 위쪽 알림
net.on('spun', (m) => {
  if (!race) return;
  const from = playerOf(m.from)?.name ?? '?', to = playerOf(m.id)?.name ?? '?';
  const text = m.why === 'banana' ? `${from}의 바나나 → ${to} 스핀!`
             : m.why === 'missile' ? `${from}의 미사일 → ${to} 명중!`
             : `${from} → ${to} 스핀!`;
  race.feed.push({ text, until: performance.now() + 3500, mine: m.from === me && m.id !== me });
  if (race.feed.length > 4) race.feed.shift();
  if (m.from === me && m.id !== me) showBanner('명중! 상대가 돌았어요', 1400, '#ffc531');
});

// 아이템전: 다른 사람의 상자 줍기 / 바나나·미사일 / 맞음
for (const t of ['box', 'obj', 'objHit']) net.on(t, (m) => race?.items?.onRemote(m, performance.now()));

function useItem() {
  if (mode !== 'race' || !race?.items || !race.car || raceTime() < 0) return;
  const st = standings();
  const idx = st.findIndex((x) => x.id === me);
  race.items.use(race.car, performance.now(), idx > 0 ? st[idx - 1].id : null);
}

// 내 랩 기록 결과
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

net.on('results', (m) => showResults(m));
net.on('chat', (m) => chat.add(m));
net.on('left', (m) => remotes.delete(m.id));
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
const sendCfg = () => net.send({ t: 'cfg', track: +$('track').value, laps: +$('laps').value, mode: $('mode').value });
$('track').addEventListener('change', sendCfg);
$('laps').addEventListener('change', sendCfg);
$('mode').addEventListener('change', sendCfg);

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

function shareBase() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  return local && lanBase ? lanBase : location.origin;
}

function updateLink() {
  $('roomCode').textContent = roomCode;
  $('link').value = `${shareBase()}/?room=${roomCode}`;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  $('linkHint').textContent = local
    ? (lanBase ? '같은 와이파이에 있는 친구가 열 수 있는 주소예요. 다른 곳의 친구는 README의 "인터넷으로 공개하기"를 보세요.'
               : '이 PC에서만 열리는 주소예요.')
    : '이 링크를 보내면 친구가 같은 방으로 들어와요.';
}

function renderLobby() {
  const ul = $('players');
  ul.innerHTML = '';
  for (const p of roster.players) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = COLORS[p.color % COLORS.length];
    const name = document.createElement('span');
    name.textContent = p.name;
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = [p.id === me ? '나' : '', p.id === roster.host ? '방장' : '', p.inRace && roster.phase === 'race' ? '레이스 중' : '']
      .filter(Boolean).join(' · ');
    li.append(dot, name, tag);
    ul.append(li);
  }

  $('track').value = roster.track;
  $('laps').value = roster.laps;
  $('mode').value = roster.mode ?? 'speed';
  $('track').disabled = $('laps').disabled = $('mode').disabled = !isHost();
  $('trackDesc').textContent = TRACKS[roster.track].desc + (roster.mode === 'item'
    ? ' · 아이템전: ? 상자를 먹고 Shift/E 로 사용 (바나나·미사일·보호막·부스터)'
    : '');
  renderRecords();

  const host = isHost();
  $('start').classList.toggle('hidden', !host);
  $('start').disabled = roster.phase === 'race';
  $('start').textContent = roster.players.length > 1 ? `레이스 시작 (${roster.players.length}명)` : '혼자 연습 시작';
  const hostName = playerOf(roster.host)?.name ?? '방장';
  $('waitHost').textContent = host ? '' : roster.phase === 'race'
    ? '레이스가 진행 중이에요. 끝나면 다음 레이스에 참가할 수 있어요.'
    : `${hostName} 님이 시작하기를 기다리는 중...`;

  $('toLobby').classList.toggle('hidden', !host);
  $('waitLobby').textContent = host ? '' : `${hostName} 님이 로비로 돌아가기를 기다리는 중...`;
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

// ───────────────────────── 레이스 ─────────────────────────

function startRace(m) {
  const track = getTrack(m.track);
  const slot = m.grid.indexOf(me);
  race = {
    id: m.raceId, track, laps: m.laps, startAt: m.startAt, grid: m.grid,
    car: slot >= 0 ? new Car(track, slot) : null,   // 경기 중에 들어왔으면 관전
    finishers: [], myTime: null, sendTick: 0, bestLap: null, prevBoost: 0,
    hitCooldown: new Map(), feed: [], mode: m.mode,
    items: null,
    ghost: null,          // 트랙 1위의 주행 경로 (스피드전)
    ghostRec: [],         // 이번 바퀴 내 주행 기록 [x, y, a, ...] 0.1초 간격
  };
  if (m.mode !== 'item') {
    fetch(`/api/ghost/${m.track}`).then((r) => (r.ok ? r.json() : null)).then((g) => {
      if (race && race.id === m.raceId) race.ghost = g;
    }).catch(() => { /* 기록 없음 */ });
  }
  if (m.mode === 'item') {
    race.items = new Items(track, me, {
      send: (msg) => net.send(msg),
      hitMe: (from, why) => spinMe(from, why),
      sfx: (name) => sound.sfx(name),
      banner: (text, color) => showBanner(text, 1400, color),
    });
  }
  remotes = new Map();
  m.grid.forEach((id, s) => {
    if (id === me) return;
    const r = new RemoteCar(id);
    const g = new Car(track, s);     // 출발 위치에 미리 세워 두기
    Object.assign(r, { x: g.x, y: g.y, a: g.a, visible: true });
    remotes.set(id, r);
  });
  renderer.clearMarks();
  renderer.follow(race.car ?? remotes.values().next().value, 0, true);
  mode = 'race';
  lastCount = null;
  banner = null;
  $('lobby').classList.add('hidden');
  $('results').classList.add('hidden');
  placeChat();
  updateTouchVisibility();
}

function raceTime() { return race ? net.serverNow() - race.startAt : 0; }

function stepRace() {
  const car = race.car;
  const t = raceTime();
  const now = net.serverNow();
  for (const r of remotes.values()) r.update(now);

  if (race.items) {
    const st = standings();
    const idx = st.findIndex((x) => x.id === me);
    const place = st.length > 1 && idx >= 0 ? idx / (st.length - 1) : 0;   // 0 = 1등, 1 = 꼴찌
    race.items.update(DT, performance.now(), car && t >= 0 ? car : null, remotes, place);
  }

  if (!car) return;
  const canDrive = t >= 0 && !car.finished;
  let input = canDrive ? readInput() : { throttle: false, brake: car.finished && car.speed > 30, steer: 0, handbrake: false };

  const others = [...remotes.values()].filter((r) => r.visible);
  const prev = { x: car.x, y: car.y, a: car.a };
  car.step(input, DT, race.track, others, Math.max(0, t));

  // 내가 상대 뒤 모서리를 박았으면 → 서버를 거쳐 상대에게 (같은 상대는 1.2초에 한 번)
  for (const h of car.hits) {
    const last = race.hitCooldown.get(h.id) ?? -1e9;
    if (now - last < 1200) continue;
    race.hitCooldown.set(h.id, now);
    net.send({ t: 'hit', target: h.id, side: h.side, power: Math.round(h.power) });
    renderer.sparks(h.x, h.y);
    sound.clank();
  }

  // 효과
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

  // 고스트용 주행 기록: 이번 바퀴 시작부터 0.1초마다 위치 하나
  if (race.mode !== 'item' && t >= 0 && !car.finished && !car.justLapped) {
    const lapElapsed = t - car.lapStart;
    while (race.ghostRec.length / 3 <= lapElapsed / 100)
      race.ghostRec.push(Math.round(car.x), Math.round(car.y), Math.round(car.a * 100) / 100);
  }

  // 바퀴 / 완주
  if (car.justLapped) {
    car.justLapped = false;
    const lt = car.lapTimes[car.lapTimes.length - 1];
    if (race.bestLap == null || lt < race.bestLap) race.bestLap = lt;
    // 스피드전이면 이 바퀴 기록 + 주행 경로를 서버 랭킹에 제출
    if (race.mode !== 'item') net.send({ t: 'lap', time: Math.round(lt), ghost: race.ghostRec });
    race.ghostRec = [];
    if (car.lap > race.laps) {
      car.finished = true;
      race.myTime = t;
      net.send({ t: 'fin', time: Math.round(t) });
      sound.fanfare();
      showBanner('FINISH!', 4000, '#ffc531');
    } else if (car.lap === race.laps) {
      showBanner('마지막 바퀴!', 1800, '#ff5a4f');
      sound.beep(988, 0.25);
    } else {
      showBanner(`LAP ${car.lap}  ·  ${fmtTime(lt)}`, 1600, '#ffffff');
      sound.beep(784, 0.15);
    }
  }

  // 내 상태를 초당 20번 보냄
  if (++race.sendTick % 3 === 0) {
    const r1 = (v) => Math.round(v * 10) / 10;
    net.send({
      t: 'st', ts: Math.round(now),
      x: r1(car.x), y: r1(car.y), a: Math.round(car.a * 1000) / 1000, vx: r1(car.vx), vy: r1(car.vy),
      d: car.drifting, b: car.boost > 0, sp: car.spin > 0, sh: car.shield > 0,
      p: car.progress(race.track), lap: car.lap, fin: car.finished,
    });
  }
}

/** 순위: 완주한 순서 → 그다음 진행도 */
function standings() {
  if (!race) return [];
  const finIndex = (id) => race.finishers.findIndex((f) => f.id === id);
  const list = race.grid.filter((id) => id === me ? !!race.car : remotes.has(id)).map((id) => {
    const fi = finIndex(id);
    const prog = id === me ? race.car.progress(race.track) : remotes.get(id).prog;
    return { id, score: fi >= 0 ? 1e12 - fi * 1e9 : prog };
  });
  return list.sort((a, b) => b.score - a.score);
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
    li.innerHTML = `<span class="place">${place}</span><span class="dot"></span><span class="nm"></span><span class="time"></span>`;
    li.querySelector('.dot').style.background = COLORS[(p?.color ?? 0) % COLORS.length];
    li.querySelector('.nm').textContent = name + (id === me ? ' (나)' : '');
    li.querySelector('.time').textContent = time;
    ol.append(li);
  };
  m.list.forEach((r, i) => add(i + 1, r.id, r.name, fmtTime(r.time)));
  m.dnf.forEach((r) => add('-', r.id, r.name, '완주 못함'));
  renderLobby();
  $('results').classList.remove('hidden');
  placeChat();
  updateTouchVisibility();
}

// ───────────────────────── 그리기 ─────────────────────────

function nameOf(c) {
  if (c.id === me) return null;
  return playerOf(c.id)?.name ?? '';
}

function draw(time) {
  const t = time / 1000;
  if (mode === 'lobby' || !race) {
    // 로비 배경: 트랙을 따라 천천히 날아다니는 카메라
    const track = getTrack(roster.track);
    const i = Math.floor(t * 18) % track.n, p = track.pts[i];
    renderer.follow({ x: p.x, y: p.y, vx: p.tx * 300, vy: p.ty * 300 }, DT);
    renderer.drawWorld(track, [], () => null, t);
    return;
  }

  const track = race.track;
  const cars = [];
  for (const r of remotes.values()) {
    const p = playerOf(r.id);
    if (r.visible && p) cars.push(Object.assign(r, { color: p.color }));
  }
  if (race.car) cars.push(Object.assign(race.car, { id: me, color: playerOf(me)?.color ?? 0 }));

  // 상대 차 효과 (드리프트 자국, 부스트 불꽃)
  for (const r of remotes.values()) {
    if (r.drifting) renderer.addSkid(r, r.prevPos);
    renderer.emitFor({ ...r, offroad: false, driftCharge: 0, boost: r.boosting ? 1 : 0, speed: r.speed }, DT);
    r.prevPos = { x: r.x, y: r.y, a: r.a };
  }

  const st = standings();
  const target = race.car ?? remotes.get(st[0]?.id);
  renderer.follow(target, DT);
  renderer.drawWorld(track, cars, nameOf, t, (ctx) => {
    race.items?.draw(ctx, t, performance.now());
    drawGhost(ctx);
  });
  drawHud(st);
}

/** 고스트: 트랙 1위가 달린 한 바퀴를, 내 이번 바퀴와 같은 시간으로 맞춰 반투명하게 재생 */
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

function drawHud(st) {
  const R = renderer;
  R.beginScreen();
  const car = race.car;
  const rt = raceTime();
  const small = R.w < 600;
  const s = small ? 0.8 : 1;

  if (car) {
    const lap = Math.min(car.lap, race.laps);
    R.text(`LAP ${lap}/${race.laps}`, 20, 44 * s, 34 * s);
    const place = st.findIndex((x) => x.id === me) + 1;
    R.text(`${place}위`, 20, 84 * s, 30 * s, '#ffc531');
    R.text(`/ ${st.length}`, 20 + (place >= 10 ? 62 : 46) * s, 84 * s, 18 * s, '#dddddd');
    R.text(fmtTime(car.finished ? race.myTime : Math.max(0, rt)), 20, 114 * s, 20 * s);
    if (race.bestLap != null) R.text(`최고 랩 ${fmtTime(race.bestLap)}`, 20, 138 * s, 15 * s, '#cfd3da', 'left', '600');
    if (race.ghost && !race.items)
      R.text(`트랙 기록 ${fmtTime(race.ghost.time)} · ${race.ghost.name}${ghostOn ? '' : ' (G: 고스트 켜기)'}`,
        20, (race.bestLap != null ? 158 : 138) * s, 14 * s, '#ffe08a', 'left', '600');

    // 속도계 + 부스트/드리프트 게이지
    const kmh = Math.round(car.speed * 0.36);
    const bx = R.w - 20, by = R.h - (touch.active ? 130 : 24);
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
  } else {
    R.text('관전 중 · 다음 레이스부터 참가할 수 있어요', R.w / 2, 40, 18 * s, '#ffffff', 'center');
  }

  // 아이템 칸
  if (race.items && car) drawItemSlot(R, s, rt);

  const mapBottom = R.minimap(race.track, [...remotes.values()].filter((r) => r.visible).concat(car ? [car] : []), me);

  // 완주자 목록 (미니맵 아래)
  const y = mapBottom + 26;
  race.finishers.forEach((f, i) => {
    const p = playerOf(f.id);
    R.text(`${i + 1}. ${p?.name ?? '?'}  ${fmtTime(f.time)}`, R.w - 20, y + i * 22, 15 * s, '#ffffff', 'right', '600');
  });

  // 카운트다운
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

  // 스핀 알림 (화면 위 가운데)
  const nowMs = performance.now();
  race.feed = race.feed.filter((f) => f.until > nowMs);
  race.feed.forEach((f, i) => R.text(f.text, R.w / 2, 34 + i * 24, 17 * s, f.mine ? '#ffc531' : '#ffffff', 'center', '700'));

  if (banner && performance.now() < banner.until) {
    const age = (performance.now() - banner.start) / 250;
    const k = Math.min(1, age);
    R.text(banner.text, R.w / 2, R.h * 0.28, (24 + 16 * k) * s, banner.color, 'center', '900');
  }

  if (car && rt > 0 && rt < 6000 && !touch.active)
    R.text('Space 드리프트 → 놓으면 미니 터보!  상대 뒤 모서리를 박으면 스핀!', R.w / 2, R.h - 24, 15, '#ffffff', 'center', '600');
}

function drawItemSlot(R, s, rt) {
  const ctx = R.ctx, items = race.items;
  const size = 64 * s, x = 20, y = 156 * s;
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
  const label = items.rolling ? '뽑는 중...' : items.slot ? `${ITEM_NAMES[items.slot]}  [Shift/E]` : '? 상자를 먹으세요';
  R.text(label, x + size + 10, y + size / 2 + 6, 15 * s, items.slot ? '#ffffff' : '#cfd3da', 'left', '700');

  // 미사일이 날 쫓아오는 중
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
    if (mode !== 'lobby' && race) stepRace();
    renderer.updateParticles(DT);
  }
  if (mode === 'lobby') sound.silenceEngine();
  draw(time);
  requestAnimationFrame(frame);
}

// ───────────────────────── 시작 ─────────────────────────

updateLink();
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
