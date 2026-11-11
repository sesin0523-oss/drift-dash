// 차 그림: 모양(차체 실루엣) 4가지 + 무늬 6가지 + 번호.
// 충돌 크기는 모두 같고(38x20), 그림만 다르다. 앞(코)이 +x 방향.
// 게임 화면, 시상식, 차고 미리보기가 모두 이 함수로 그린다.

export const SHAPES = ['세단', '스포츠카', '드리프트카', '트럭'];
export const PATTERNS = ['없음', '가운데 줄', '두 줄', '체크', '불꽃', '사선'];

/** 기본 차 4종의 생김새 (CAR_TYPES 와 같은 순서) */
export const PRESET_LOOKS = [
  { shape: 0, accent: '#ffffff', pattern: 1 },   // 밸런스: 세단
  { shape: 1, accent: '#151515', pattern: 2 },   // 스피드: 스포츠카
  { shape: 2, accent: '#ffffff', pattern: 5 },   // 드리프트: 드리프트카
  { shape: 3, accent: '#2a2a2a', pattern: 0 },   // 탱크: 트럭
];

// 모양별 차체 외곽선 (한 번만 만들어 둠)
const BODY = [
  // 0 세단: 둥근 직사각형
  (() => { const p = new Path2D(); p.roundRect(-19, -10, 38, 20, 6); return p; })(),
  // 1 스포츠카: 뾰족한 코, 뒤가 넓음
  (() => {
    const p = new Path2D();
    p.moveTo(22, 0); p.lineTo(15, -8); p.lineTo(-15, -10); p.quadraticCurveTo(-19, -10, -19, -6);
    p.lineTo(-19, 6); p.quadraticCurveTo(-19, 10, -15, 10); p.lineTo(15, 8); p.closePath();
    return p;
  })(),
  // 2 드리프트카: 바퀴 위가 불룩한 와이드 펜더
  (() => {
    const p = new Path2D();
    p.roundRect(-18, -9, 36, 18, 5);
    for (const [x, y] of [[-11, -9], [-11, 9], [11, -9], [11, 9]]) p.ellipse(x, y, 6.5, 3, 0, 0, Math.PI * 2);
    return p;
  })(),
  // 3 트럭: 각진 차체
  (() => { const p = new Path2D(); p.roundRect(-20, -10.5, 40, 21, 2.5); return p; })(),
];

const WHEELS = [
  [[-12, -11], [-12, 11], [11, -11], [11, 11]],
  [[-12, -11.5], [-12, 11.5], [10, -10], [10, 10]],
  [[-11, -11.5], [-11, 11.5], [11, -11.5], [11, 11.5]],
  [[-13, -12], [-13, 12], [12, -12], [12, 12]],
];

/** look: { shape, color?, accent, pattern, number? }  color 가 없으면 baseColor(플레이어 색) */
export function drawCarArt(ctx, look, baseColor) {
  const shape = Math.max(0, Math.min(3, look?.shape ?? 0));
  const body = BODY[shape];
  const color = look?.color || baseColor;
  const accent = look?.accent || '#ffffff';

  // 그림자
  ctx.save();
  ctx.translate(3, 4);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill(body);
  ctx.restore();

  // 바퀴 (트럭은 크고 두툼)
  ctx.fillStyle = '#151515';
  const [ww, wh] = shape === 3 ? [12, 7] : shape === 2 ? [10, 6.5] : [10, 6];
  for (const [x, y] of WHEELS[shape]) ctx.fillRect(x - ww / 2, y - wh / 2, ww, wh);

  // 차체
  ctx.fillStyle = color;
  ctx.fill(body);

  // 무늬 (차체 안쪽에만)
  ctx.save();
  ctx.clip(body);
  ctx.fillStyle = accent;
  switch (look?.pattern ?? 0) {
    case 1: ctx.fillRect(-22, -2.5, 46, 5); break;
    case 2: ctx.fillRect(-22, -6, 46, 3); ctx.fillRect(-22, 3, 46, 3); break;
    case 3:
      for (let x = -22; x < 24; x += 4)
        for (let y = -12; y < 12; y += 4)
          if (((x + y) / 4) % 2 === 0) ctx.fillRect(x, y, 4, 4);
      break;
    case 4:   // 불꽃: 코에서 뒤로 뻗는 뾰족한 모양
      ctx.beginPath();
      ctx.moveTo(22, -9); ctx.lineTo(4, -9); ctx.lineTo(-6, -5); ctx.lineTo(2, -4); ctx.lineTo(-10, 0);
      ctx.lineTo(2, 4); ctx.lineTo(-6, 5); ctx.lineTo(4, 9); ctx.lineTo(22, 9);
      ctx.closePath();
      ctx.fill();
      break;
    case 5:
      for (let k = -3; k <= 3; k++) {
        ctx.beginPath();
        ctx.moveTo(k * 7 - 3, -12); ctx.lineTo(k * 7 + 1, -12); ctx.lineTo(k * 7 + 6, 12); ctx.lineTo(k * 7 + 2, 12);
        ctx.fill();
      }
      break;
  }
  ctx.restore();

  // 모양별 부품
  const glass = 'rgba(25,35,55,0.88)';
  if (shape === 0) {                 // 세단: 앞유리 + 지붕 + 뒷유리
    ctx.fillStyle = glass;
    ctx.beginPath(); ctx.roundRect(3, -7, 7, 14, 2); ctx.fill();
    ctx.fillRect(-13, -6, 4, 12);
  } else if (shape === 1) {          // 스포츠카: 작은 물방울 캐노피 + 큰 뒷날개
    ctx.fillStyle = glass;
    ctx.beginPath(); ctx.ellipse(1, 0, 8, 5.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.fillRect(-23, -12, 4, 24);
    ctx.fillRect(-20, -4, 3, 2); ctx.fillRect(-20, 2, 3, 2);
  } else if (shape === 2) {          // 드리프트카: 짧은 지붕 + 앞 립
    ctx.fillStyle = glass;
    ctx.beginPath(); ctx.roundRect(2, -6.5, 6, 13, 2); ctx.fill();
    ctx.fillRect(-10, -5.5, 3, 11);
    ctx.fillStyle = '#111';
    ctx.fillRect(17, -9, 3, 18);
    ctx.fillRect(-20, -6, 2, 12);
  } else {                           // 트럭: 운전석 + 짐칸 + 범퍼 가드
    ctx.fillStyle = glass;
    ctx.beginPath(); ctx.roundRect(9, -8, 5, 16, 1.5); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(-18, -8.5, 22, 17);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    for (let x = -15; x < 4; x += 5) { ctx.beginPath(); ctx.moveTo(x, -8); ctx.lineTo(x, 8); ctx.stroke(); }
    ctx.fillStyle = '#2a2a2a';
    ctx.fillRect(20, -11, 3, 22);
    ctx.fillStyle = '#9aa0a8';
    ctx.fillRect(21, -8, 1.5, 16);
  }

  // 외곽선
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 1;
  ctx.stroke(body);

  // 번호 (지붕 위 동그라미)
  if (look?.number != null && look.number !== '') {
    const nx = shape === 3 ? -7 : shape === 1 ? -9 : -3;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(nx, 0, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = 'bold 7px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(nx, 0);
    ctx.rotate(Math.PI / 2);      // 위에서 봤을 때 읽히게
    ctx.fillText(String(look.number), 0, 0.5);
    ctx.restore();
  }

  // 헤드라이트
  ctx.fillStyle = '#fff6c4';
  const front = shape === 1 ? 16 : shape === 3 ? 18 : 16;
  ctx.fillRect(front, -7, 3, 3.5);
  ctx.fillRect(front, 3.5, 3, 3.5);
}
