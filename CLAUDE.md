# Drift Dash — 프로젝트 메모 (Claude용)

탑다운 레이싱 웹게임. 친구에게 링크를 주면 브라우저에서 멀티플레이. 사용자와는 **한국어**로 대화.
작업이 끝나면 항상 **마지막에 접속 링크를 띄워줄 것** (터널 URL + Render URL은 사용자가 대시보드 Resources → drift-dash 에서 확인).
다른 게임(마리오카트·카트라이더 등)의 이름·에셋을 베끼지 말고 독자적인 아이템/연출로 만들 것.

## 스택 / 실행
- 서버: ASP.NET Core (.NET 9) minimal API + WebSocket. `Program.cs`(정적파일 no-cache, /ws, /api/info, /api/records, /api/ghost/{track}), `Rooms.cs`(Client, Lobby), `Room.cs`(방 로직), `CustomCar.cs`(커스텀 차 검증), `Records.cs`(기록, `TrackLength` 배열 — 트랙 추가 시 갱신).
- 클라이언트: `wwwroot/` HTML5 Canvas + ES 모듈 (`wwwroot/js/*.js`). JS는 no-cache라 수정 후 새로고침만 하면 됨. **C# 수정 시에만 서버 재시작**.
- 로컬 실행: 브라우저 프리뷰 `.claude/launch.json` 의 `driftdash` (포트 5080).
- 외부 공유: cloudflared quick tunnel (`cloudflared tunnel --no-autoupdate --url http://localhost:5080`, 로그는 scratchpad/tunnel.log 에서 trycloudflare URL 확인).
- 배포: Render (Dockerfile + render.yaml), GitHub 공개 저장소에 push 하면 자동 배포.
- 서버 실행 중 빌드 확인: `dotnet build -o "$env:TEMP\...\scratchpad\ddbuild"` (실행 중 bin 잠김 회피).
- 이 PC에는 **node 없음** → JS 문법/로직 테스트는 브라우저에서 `await import('/js/x.js?v=' + Date.now())` 로.

## 권한 모델 (중요)
- 각 브라우저가 **자기 차**를 시뮬레이션. 방장 브라우저는 **봇**도 시뮬레이션하고 `as: botId` 로 보냄.
- 맞았는지/스핀은 **피해자 쪽이 판정**. 서버는 중계 + 검증(커스텀 차, 랩 기록, 시리즈, 팀 게이지)만.
- 원격 차: 100ms 지연 보간 + 현재 시각까지 추측항법 (`net.js` RemoteCar). `st` 메시지 플래그: d(드리프트) b(부스트) sp(스핀) sh(보호막) gh(유령/투명) tw(견인) zp(감전).

## 주요 클라이언트 모듈
- `track.js`: 13개 트랙(그랑프리 서킷=12번, 초대형 scale 3 · 선셋 서킷, 협곡 헤어핀, 네온 시티, 도넛 링, 스노우 밸리, 해안 고속도로, 화산 분지, 숲속 와인딩, 공항 활주로, 사막 오아시스, 항구 부두, 절벽 고개). 트랙 추가 시 Room.cs `TrackCount`·`TrackNames`, Records.cs `TrackLength`(= buildTrack().length)도 갱신. Catmull-Rom 중심선 8px 샘플, `nearest()`, 체크포인트, 벽 = half+SHOULDER(70).
  트랙 특색은 `FEATURES[이름]` → `t.features` (note, obstacles, patches, hazards, wind, zapWalls). buildTrack 결과에 obstacles/patches/hazards(Path2D)/hazardSide/wind/zapWalls. `windAt(track,i)`.
  - 사막: 모래 패치(sand)·모래 폭풍·오아시스 / 항구: 부두 바다·화물 상자(crate) / 절벽: 낭떠러지(cliff)·낙석
  - 협곡: 바위 / 네온: 감전 벽 / 도넛: 범퍼 / 스노우: 눈·빙판 패치 / 해안: 바다(빠지면 견인) / 화산: 용암 4구간(빠지면 견인 후 12포인트 뒤 도로 중앙에서 재시작, 잠시 유령) / 숲: 진흙·통나무 / 공항: 측풍.
- `car.js`: 아케이드 드리프트 물리(follow 0.93/핸드브레이크 0.55), OBB/SAT 충돌, 후방 모서리 스핀. `fall()`, towT/ghost/zap/slide/surface, getter `ghostly`·`towing`, `input.pull`(자석), `input.draft`(슬립스트림).
- `items.js`: banana, missile, shield, boost + 신규 oil, zap(전체 감전), ink(앞 차들 화면 먹물), magnet, cloak(3초 통과), boost3. hooks: send/hitMe/slideMe/fx/sfx/banner/sameTeam.
- `main.js`: 전체 연결. `applyFx`(zap/ink 수신 → 내 차+내 봇만 판정), `slideCar`, `magnetPull`, `trackFx`(빠짐/감전 효과), `drawInk`, HUD(아이템 설명·boost3 남은 횟수), 로비 트랙 설명에 특징 표시.
- `bot.js`(BOT_LEVELS, think, thinkItem — 신규 아이템 사용 규칙, 먹물 맞으면 흔들림 `inkT`), `render.js`, `audio.js`(sfx), `carart.js`/`garage.js`(커스텀 차), `podium.js`, `chat.js`, `net.js`.
- 시리즈 `_seriesKind`: 0 단판, 1 3판 2선승, 2 그랑프리(4라운드 포인트제, `_gpTracks` = 고른 트랙 + 무작위 2 + 그랑프리 서킷). 클라이언트 `isGp`/`gpRunning`, `series` cfg 값은 숫자.
- 섹터 기록: main.js `trackSectors`/`drawSectors` (체크포인트 3등분, 내 최고 구간과 비교).
- 서버 `Room.cs`: 아이템전 `obj` kind 는 banana/missile/oil 만 허용, `fx` kind 는 zap/ink 만 중계.

## 테스트 패턴
- 모듈 테스트: 새로 navigate 후 import (모듈 캐시 회피). 숨겨진 패널에선 rAF가 안 돌고 스크린샷이 오래된 것일 수 있음 → 값으로 검증.
- 서버 흐름: 가짜 WebSocket 클라이언트로 검증.
- 봇 9트랙 완주 시뮬레이션(4봇 3랩)으로 트랙/물리 변경 회귀 확인.

## 커밋
- noreply 신원으로 커밋, 메시지 끝에 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## 진행 상태 (2026-11-11)
"아이템 다양화 + 트랙별 특색" 작업: 코드 구현 완료, 봇 9트랙 완주·용암 견인 테스트 통과, 서버 빌드 OK.
남은 일: 아이템/특색 시각 확인(스크린샷), 서버 fx/oil 중계 테스트, README에 아이템·트랙 특색 섹션 추가, git commit & push, 터널이 새 코드를 서비스하는지 확인 후 링크 안내.
