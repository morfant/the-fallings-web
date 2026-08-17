// The Fallings — 공개 웹 버전 메인 스케치.
// 상태: loading → replay(과거분 빠른 낙하) → live(폴링 + 세리머니 낙하)

let engine;
let pile;
let victims = [];        // 로드된 전체 데이터 (date 오름차순)
let spawnQueue = [];     // 낙하 대기 victimIdx (직렬화 — 한 번에 하나만 낙하)
let appState = "loading";
let cameraY = 0;
let followMode = true;
let hoverIdx = -1;
let selectedIdx = -1; // 상세 팝업이 열려 있는 블럭
// 상세를 닫은 뒤에도 "방금 본 블럭"을 표시해 둔다 — 스크롤로 돌아왔을 때 어디까지 봤는지
// 잃지 않게 (작가 요청 2026-08-01). 선택 표시보다 약하게 그린다.
let lastViewedIdx = -1;
// 알림 딥링크로 왔는데 그 블럭이 아직 낙하 전(리플레이 대기·낙하 중)인 경우의 대기표.
// 딥링크 시점에는 settled에 없어 선택·카메라를 배정할 수 없다 — 착지하는 순간 draw()가
// 배정한다. "숨졌습니다"라는 문장을 누르고 들어온 사람 앞에서 바로 그 블럭이 떨어지고,
// 떨어진 블럭에 표시가 남는다 (2026-08-07, 8/6 구미 건 실사용 보고).
let pendingDeepLinkVi = -1; // victims 배열 인덱스, -1 = 없음

// 착지 충격파 (렌더 전용 — 물리 바디는 건드리지 않음)
let shakeStart = -1e9; // millis
let shakeTopIdx = -1;  // 착지한 블럭 인덱스
const SHAKE = { DUR: 0.7, REACH: 12, AMP: 6, FREQ: 9, DECAY: 6 };

function shakeOffset(i, nowMs) {
    const elapsed = (nowMs - shakeStart) / 1000;
    if (elapsed < 0 || elapsed > SHAKE.DUR) return 0;
    const depth = shakeTopIdx - i; // 0 = 방금 착지한 블럭, 아래로 갈수록 증가
    if (depth < 0 || depth >= SHAKE.REACH) return 0;
    const depthAtten = 1 - depth / SHAKE.REACH;            // 아래로 갈수록 약하게
    const timeAtten = Math.exp(-elapsed * SHAKE.DECAY);    // 시간 감쇠
    const phase = elapsed * TWO_PI * SHAKE.FREQ - depth * 0.6; // 아래로 전파되는 위상
    return SHAKE.AMP * depthAtten * timeAtten * Math.sin(phase);
}
let lastLandAt = 0;

function setup() {
    const holder = document.getElementById("canvas-holder");
    const c = createCanvas(holder.clientWidth, holder.clientHeight);
    c.parent(holder);

    engine = Matter.Engine.create({
        enableSleeping: true,
        positionIterations: 6,
        velocityIterations: 4,
    });
    engine.world.gravity.y = CONFIG.GRAVITY_REPLAY;

    pile = new Pile(engine, width);
    cameraY = CONFIG.GROUND_Y - height + 60;

    textFont('"Apple SD Gothic Neo", "Noto Sans KR", sans-serif');
    setupDOM();
    initData();
}

async function initData() {
    try {
        victims = await loadVictimData();
    } catch (e) {
        console.error(e);
        appState = "error";
        return;
    }

    const replayN = Math.min(CONFIG.REPLAY_N, victims.length);
    const preCount = victims.length - replayN;

    // 과거분은 즉시 지층으로, 최근 replayN건은 낙하 리플레이로
    pile.prestack(Array.from({ length: preCount }, (_, i) => i));
    for (let i = preCount; i < victims.length; i++) spawnQueue.push(i);

    const since = checkRevisit(victims);
    if (since) showRevisitBanner(since);

    // "들었습니다" 카운터 — 로드되면 통계(기록된 애도)도 갱신
    loadAcks().then(() => {
        renderStats(victims, pile.settled.length);
        if (detailPid) updateAckRow(detailPid); // 딥링크로 먼저 열린 상세 뷰의 카운트 반영
    });
    computeAckIds(victims).then(openFromHash); // 확인 카운터·#/record/<id> 딥링크용 id 사전 계산
    computePeriodCounts(); // 월/연 경계 요약 오버레이용

    renderStats(victims, pile.settled.length);
    appState = "replay";
    startPolling();

    // ?demo=1 — 사운드/낙하 튜닝용: 6초마다 무작위 기록을 다시 떨어뜨림
    // (화면·통계 숫자가 부풀어 보임 — 새로고침하면 원상복구되는 클라이언트 전용 모드)
    if (getParam("demo")) {
        setInterval(() => {
            if (appState === "live" && !pile.falling && spawnQueue.length === 0) {
                spawnQueue.push(Math.floor(Math.random() * victims.length));
            }
        }, 6000);
    }
}

// =====================[ 메인 루프 ]=====================

function draw() {
    background(...CONFIG.COLORS.bg);

    if (appState === "loading" || appState === "error") {
        fill(...CONFIG.COLORS.textDim);
        noStroke();
        textAlign(CENTER, CENTER);
        textSize(14);
        text(appState === "loading" ? "기록을 불러오는 중…" : "데이터를 불러오지 못했습니다.", width / 2, height / 2);
        return;
    }

    const now = millis();

    // 낙하 스폰 (직렬화)
    if (!pile.falling && spawnQueue.length > 0) {
        const interval = appState === "replay" ? CONFIG.REPLAY_INTERVAL : 800;
        if (now - lastLandAt > interval) {
            const vi = spawnQueue.shift();
            const spawnY = pile.topY() - height * 0.9;
            pile.spawn(vi, spawnY);
        }
    }

    // 리플레이 종료 → 라이브 전환 (세리머니 중력)
    if (appState === "replay" && spawnQueue.length === 0 && !pile.falling) {
        appState = "live";
        engine.world.gravity.y = CONFIG.GRAVITY_LIVE;
        // 리플레이로 떨어진 블럭의 착지 하이라이트를 걷어낸다 — 처음 화면을 열었을 때
        // 마지막 블럭에 표시가 남아 선택된 것처럼 보였다 (작가 보고 2026-08-01).
        // 세리머니 하이라이트는 '보고 있는 동안 도착한 죽음'의 것이지 과거분 재생의 것이 아니다.
        // settledAt 0 = 프리스택(하이라이트 없음)이라는 기존 의미를 그대로 쓴다.
        for (const s of pile.settled) s.settledAt = 0;
    }

    Matter.Engine.update(engine, 1000 / 60);

    const landedIdx = pile.update(now);
    if (landedIdx !== null) {
        lastLandAt = now;
        renderStats(victims, pile.settled.length);
        // 착지음은 '보고 있는 동안 도착한 죽음'에만 울린다. 페이지를 열 때 과거분이
        // 다시 떨어지며 소리가 나는 것은 도착이 아니라 재생이다 (작가 결정 2026-08-01).
        if (appState === "live") playThud();
        shakeStart = now; // 아래 블럭들로 전파되는 충격파
        shakeTopIdx = pile.settled.length - 1;
        // 딥링크가 기다리던 블럭이면 이제 선택 표시를 배정한다 (열려 있는 상세 뷰의 블럭).
        // followMode(기본 켬)가 더미 꼭대기를 따라가므로 낙하는 이미 화면 안에서 일어났다.
        if (landedIdx === pendingDeepLinkVi) {
            pendingDeepLinkVi = -1;
            selectedIdx = pile.settled.length - 1;
            lastViewedIdx = selectedIdx;
        }
    }

    // 터치 관성(플링) 스크롤 — 손을 뗀 뒤 감쇠하며 이어짐. 경계 밖에서는 저항을 받아
    // 살짝 넘어갔다가 updateCamera의 고무줄로 되돌아온다 (바운스).
    if (_touch.fling !== 0) {
        cameraY += resistDelta(_touch.fling);
        _touch.fling *= 0.94;
        if (Math.abs(_touch.fling) < 0.3) _touch.fling = 0;
    }

    updateCamera();

    push();
    translate(0, -cameraY);
    drawGround();
    drawSettledBlocks(now);
    drawFallingBlock();
    pop();

    if (DEBUG) drawHUD();
}

// =====================[ 카메라 ]=====================

// 카메라 스크롤 경계 — 맨 위(최근)로 끝까지 올려도 블럭이 최소 3개는 화면에 남는다
// (작가 요청 2026-08-08: 빈 하늘만 남지 않게).
function camBounds() {
    const maxY = CONFIG.GROUND_Y - height + 60;
    const minY = Math.min(pile.topY() - height + 3 * CONFIG.BLOCK_H, maxY);
    return { minY, maxY };
}

// 경계 밖으로 당길 때의 저항 — 밀수록 덜 움직인다 (iOS 오버스크롤 감).
function resistDelta(d) {
    const { minY, maxY } = camBounds();
    if ((d < 0 && cameraY < minY) || (d > 0 && cameraY > maxY)) return d * 0.55;
    return d;
}

function updateCamera() {
    if (followMode) {
        const target = pile.topY() - height * CONFIG.FOLLOW_ANCHOR;
        cameraY = lerp(cameraY, target, CONFIG.FOLLOW_LERP);
    }
    // 경계 밖이면 고무줄처럼 되돌아온다 — 당겼다 놓았을 때의 바운스
    const { minY, maxY } = camBounds();
    if (cameraY < minY) {
        cameraY = lerp(cameraY, minY, 0.3);
        if (minY - cameraY < 0.5) cameraY = minY;
    } else if (cameraY > maxY) {
        cameraY = lerp(cameraY, maxY, 0.3);
        if (cameraY - maxY < 0.5) cameraY = maxY;
    }
}

function mouseWheel(event) {
    // 모바일 레이아웃은 캔버스가 화면 전체를 덮어 overCanvas()가 늘 참 — 열린 정보 뷰
    // 위에서의 휠까지 가로채 패널 스크롤이 죽는다. 실제 이벤트 대상으로 판별한다.
    if (event && event.target && event.target.tagName !== "CANVAS") return true;
    if (!overCanvas()) return true; // 패널 스크롤은 그대로
    cameraY += resistDelta(event.delta);
    setFollow(false);
    return false;
}

function overCanvas() {
    return mouseX >= 0 && mouseX <= width && mouseY >= 0 && mouseY <= height;
}

function setFollow(on) {
    followMode = on;
    const btn = document.getElementById("follow-btn");
    if (btn) btn.hidden = on;
}

// =====================[ 렌더 ]=====================

function drawGround() {
    stroke(...CONFIG.COLORS.ground);
    strokeWeight(2);
    line(0, CONFIG.GROUND_Y, width, CONFIG.GROUND_Y);
    noStroke();
    fill(...CONFIG.COLORS.textDim);
    textAlign(LEFT, TOP);
    textSize(11);
    text(CONFIG.COUNT_SINCE_LABEL, CONFIG.BLOCK_MARGIN + 8, CONFIG.GROUND_Y + 10);
}

// ---- 블럭 렌더링: 금속 바 ----
// 채움색이 가로 방향 가운데를 기준으로 양쪽으로 어두워지는 그라데이션 —
// 무광 금속 막대가 쌓이는 느낌. (캔버스 네이티브 linearGradient, 폭 기준 캐시)

// ---- 블럭별 미세 변주 (렌더 전용, 작가 결정 2026-08-17) ----
// 수평 ±1.5px 오프셋 + 금속 밝기 5단계: 기계로 찍은 스택이 아니라 손으로 쌓은
// 석판처럼 가장자리와 결이 켜마다 미세하게 어긋난다. 시드는 pid — 꽃(flower.js)과
// 같은 원리로, 이 미세한 어긋남과 결이 그 사람 고유의 형태가 된다 (작가 승인).
// 물리·격자(yOfCenter, 히트테스트)는 건드리지 않는다 — shakeOffset과 같은
// 렌더 전용 레이어.
const _blockVarCache = new Map(); // victimIdx -> {jx, lum}
function blockVariation(victimIdx) {
    let bv = _blockVarCache.get(victimIdx);
    if (!bv) {
        const v = victims[victimIdx];
        const seed = String(v?.pid || v?.link || victimIdx);
        const rand = _mulberry32(_flowerHash(seed));
        bv = { jx: (rand() - 0.5) * 3, lum: Math.floor(rand() * 5) };
        _blockVarCache.set(victimIdx, bv);
    }
    return bv;
}

let _metalGrads = [], _metalGradW = 0;
function metalGradient(w, lum = 2) { // translate된 좌표계(-w/2 ~ w/2) 기준 — 밝기 단계별 캐시
    if (_metalGradW !== w) { _metalGrads = []; _metalGradW = w; }
    let g = _metalGrads[lum];
    if (!g) {
        const d = (lum - 2) * 1.5; // 켜마다 결이 미세하게 다르게 — 밝기 ±3%
        g = drawingContext.createLinearGradient(-w / 2, 0, w / 2, 0);
        g.addColorStop(0.0, `hsl(228, 6%, ${11 + d}%)`);
        g.addColorStop(0.5, `hsl(228, 7%, ${30 + d}%)`); // 중앙 하이라이트
        g.addColorStop(1.0, `hsl(228, 6%, ${11 + d}%)`);
        _metalGrads[lum] = g;
    }
    return g;
}

let _bevelGrad = null, _bevelGradH = 0;
function bevelGradient(H) { // 입체감: 윗면 하이라이트 → 아랫면 그림자 (수직 오버레이)
    if (_bevelGradH !== H) {
        const g = drawingContext.createLinearGradient(0, -H / 2, 0, H / 2);
        g.addColorStop(0.0, "rgba(255,255,255,0.13)");
        g.addColorStop(0.18, "rgba(255,255,255,0.03)");
        g.addColorStop(0.55, "rgba(0,0,0,0)");
        g.addColorStop(1.0, "rgba(0,0,0,0.28)");
        _bevelGrad = g;
        _bevelGradH = H;
    }
    return _bevelGrad;
}

// ---- 화강암 모자이크 프로토타입 (?granite=1, 작가 결정 2026-08-17) ----
// "죽음의 데이터를 디지털적인 처리를 통해 고유한 것으로 만들어 보관" — 무늬는 장식이
// 아니라 안치(安置). 앞쪽 셀들에 기록의 정본 문자열(pid|사고일|유형|나이)이 2비트/셀로
// 새겨지고(팔레트 4단계 = 2비트), 나머지는 pid 시드 PRNG로 같은 팔레트에서 채워진다.
// 표준 스캐너는 못 읽지만 규칙을 알면 화면 캡처에서도 기록을 복원할 수 있는 비문(銘文).
// 진짜 QR은 넣지 않는다 (작가 확정 — 파인더·대비가 곧 'QR스러움'이라 화강암과 양립 불가).
// ?stone=mosaic|hatch|weave|braille|morse|wave 로 표면 문법을 갈아끼운다 (전부 비교용 프로토타입).
// ?granite=1은 mosaic의 별칭 (기존 링크 호환).
const STONE_STYLE = (typeof getParam === "function" &&
    (getParam("stone") || (getParam("granite") ? "mosaic" : ""))) || "";
const GRANITE_ON = !!STONE_STYLE;
const GRANITE = {
    CELL: 6, // px — 블럭 셀 크기
    CELL_CARD: 12, // px — 상세 카드 배경 셀 (같은 돌의 확대판)
    // 4단계 회색 (금속 톤 hsl 228 주변) — 인덱스가 곧 2비트 값.
    // 조율 이력: 9~21%(은은) → 7~30%(또렷하게) → 12~40%(밝게) → 30~85%("흰색에 가깝게").
    // 밝은 돌에는 글자를 어둡게 새긴다 (drawBlockLabels·sharecard의 GRANITE_ON 분기).
    SHADES: ["hsl(228, 5%, 30%)", "hsl(228, 5%, 50%)", "hsl(226, 6%, 68%)", "hsl(220, 8%, 85%)"],
    CACHE_MAX: 80, // 보이는 범위 + 여유 (LRU)
};

// 기록의 정본 문자열 → 비트열. 이 규칙이 공개될 '비문의 문법'이다 (data.html, 2단계).
// 작가 결정(2026-08-17): 공개 기록 전체를 새긴다 — 요약문까지. 공간이 모자라면
// 앞에서부터 들어가는 만큼 새겨지고(잘림), 남으면 pid 시드 채움이 잇는다.
function _recordBits(v) {
    const s = [v?.pid, v?.date, v?.region, v?.accType, v?.age ?? "", v?.immigrant || "",
        v?.ofDeaths || "", v?.accSummary || ""].map((x) => x ?? "").join("|");
    const bytes = new TextEncoder().encode(s);
    const bits = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    return bits;
}
function _recordBytes(v) { // 바이트 단위 문법(점자·파형)용
    const bits = _recordBits(v);
    const bytes = [];
    for (let i = 0; i + 7 < bits.length; i += 8) {
        let b = 0;
        for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
        bytes.push(b);
    }
    return bytes;
}

// 핵심 렌더 — 블럭과 상세 카드 배경이 공유한다 (같은 돌, 셀 크기만 다름).
// 데이터는 잘리지 않은 온전한 셀에만 새긴다 — 가장자리의 부분 셀은 화면 캡처
// 해독이 불안정하므로 채움 전용 (해독 규칙: 온전한 셀만, 행 우선, 좌상단부터).
function graniteRender(v, w, H, cell, scale) {
    const rand = _mulberry32(_flowerHash(String(v?.pid || v?.link || "")));
    const bits = _recordBits(v);
    const cols = Math.ceil(w / cell), rows = Math.ceil(H / cell);
    const fullCols = Math.floor(w / cell), fullRows = Math.floor(H / cell);
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(H * scale);
    const ctx = c.getContext("2d");
    ctx.scale(scale, scale);
    let bi = 0;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const isFull = col < fullCols && row < fullRows;
            const shade = isFull && bi + 1 < bits.length
                ? (bits[bi++] << 1) | bits[bi++]
                : Math.floor(rand() * 4);
            ctx.fillStyle = GRANITE.SHADES[shade];
            ctx.fillRect(col * cell, row * cell, cell, cell);
        }
    }
    return c;
}

// ---- 대안 표면 문법들 (?stone=…, 전부 비교용 프로토타입 2026-08-17) ----
// 공통: 밝은 돌 기조(어두운 글자 유지), 데이터를 앞에서부터 새기고 남으면 pid 시드 채움.

function _stoneCanvas(w, H, scale, base) {
    const c = document.createElement("canvas");
    c.width = Math.ceil(w * scale);
    c.height = Math.ceil(H * scale);
    const ctx = c.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, H);
    return [c, ctx];
}
function _stoneRand(v) {
    return _mulberry32(_flowerHash(String(v?.pid || v?.link || "")));
}

// 사선 해칭 — 빗금의 방향이 값 (작가 제안). 석공이 정으로 쪼은 잔다듬 자국.
// 2비트/셀: 0=╱ 1=╲ 2=─ 3=│
function _stoneHatch(v, w, H, cell, scale) {
    const [c, ctx] = _stoneCanvas(w, H, scale, "hsl(224, 7%, 74%)");
    const bits = _recordBits(v), rand = _stoneRand(v);
    const cols = Math.ceil(w / cell), rows = Math.ceil(H / cell);
    const fullCols = Math.floor(w / cell), fullRows = Math.floor(H / cell);
    ctx.strokeStyle = "hsl(228, 8%, 34%)";
    ctx.lineWidth = Math.max(1, cell * 0.18);
    ctx.lineCap = "round";
    const m = cell * 0.24;
    let bi = 0;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const isFull = col < fullCols && row < fullRows;
        const o = isFull && bi + 1 < bits.length ? (bits[bi++] << 1) | bits[bi++] : Math.floor(rand() * 4);
        const x = col * cell, y = row * cell;
        ctx.beginPath();
        if (o === 0) { ctx.moveTo(x + m, y + cell - m); ctx.lineTo(x + cell - m, y + m); }
        else if (o === 1) { ctx.moveTo(x + m, y + m); ctx.lineTo(x + cell - m, y + cell - m); }
        else if (o === 2) { ctx.moveTo(x + m, y + cell / 2); ctx.lineTo(x + cell - m, y + cell / 2); }
        else { ctx.moveTo(x + cell / 2, y + m); ctx.lineTo(x + cell / 2, y + cell - m); }
        ctx.stroke();
    }
    return c;
}

// 직조 — 씨실·날실의 교차(어느 실이 위인가)가 값. 1비트/셀. 수의(壽衣)의 삼베.
function _stoneWeave(v, w, H, cell, scale) {
    const [c, ctx] = _stoneCanvas(w, H, scale, "hsl(225, 6%, 56%)"); // 실 사이 그늘
    const bits = _recordBits(v), rand = _stoneRand(v);
    const cols = Math.ceil(w / cell), rows = Math.ceil(H / cell);
    const fullCols = Math.floor(w / cell), fullRows = Math.floor(H / cell);
    const t = cell * 0.72, g = (cell - t) / 2;
    const HOR = "hsl(224, 8%, 78%)", VER = "hsl(226, 6%, 66%)";
    let bi = 0;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const isFull = col < fullCols && row < fullRows;
        const over = isFull && bi < bits.length ? bits[bi++] : (rand() < 0.5 ? 0 : 1);
        const x = col * cell, y = row * cell;
        if (over === 0) { // 세로 실이 위
            ctx.fillStyle = HOR; ctx.fillRect(x, y + g, cell, t);
            ctx.fillStyle = VER; ctx.fillRect(x + g, y, t, cell);
        } else {          // 가로 실이 위
            ctx.fillStyle = VER; ctx.fillRect(x + g, y, t, cell);
            ctx.fillStyle = HOR; ctx.fillRect(x, y + g, cell, t);
        }
    }
    return c;
}

// 점자 — 바이트 하나 = 8점(2×4) 점자 셀. 기계가 아니라 인간의 촉각 문자 문법.
// (프로토타입은 바이트 점자 — 실제 한글 점자 변환은 확정 후.)
function _stoneBraille(v, w, H, cell, scale) {
    const [c, ctx] = _stoneCanvas(w, H, scale, "hsl(224, 7%, 76%)");
    const bytes = _recordBytes(v), rand = _stoneRand(v);
    const bw = cell, bh = cell * 2;
    const cols = Math.ceil(w / bw), rows = Math.ceil(H / bh);
    ctx.fillStyle = "hsl(228, 9%, 32%)";
    const r = cell * 0.13, s = cell * 0.5, off = cell * 0.25;
    let i = 0;
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
        const byte = i < bytes.length ? bytes[i++] : Math.floor(rand() * 256);
        for (let k = 0; k < 8; k++) {
            if (!((byte >> (7 - k)) & 1)) continue;
            ctx.beginPath();
            ctx.arc(col * bw + off + (k % 2) * s, row * bh + off + ((k / 2) | 0) * s, r, 0, Math.PI * 2);
            ctx.fill();
        }
    }
    return c;
}

// 모스 — 점(0)과 선(1)의 행. 부고 전보(訃告電報)의 문자.
function _stoneMorse(v, w, H, cell, scale) {
    const [c, ctx] = _stoneCanvas(w, H, scale, "hsl(224, 7%, 76%)");
    const bits = _recordBits(v), rand = _stoneRand(v);
    const u = Math.max(2, cell * 0.5), th = Math.max(2, cell * 0.45), rowH = cell * 1.5;
    ctx.fillStyle = "hsl(228, 9%, 32%)";
    let bi = 0;
    for (let y = rowH * 0.4; y + th <= H; y += rowH) {
        let x = u;
        while (x < w - u) {
            const b = bi < bits.length ? bits[bi++] : (rand() < 0.5 ? 1 : 0);
            const len = b ? u * 3 : u;
            if (x + len > w - u * 0.4) break;
            ctx.beginPath();
            ctx.roundRect(x, y, len, th, th / 2);
            ctx.fill();
            x += len + u;
        }
    }
    return c;
}

// 파형 — 바이트가 진폭. 심전도이자 소리의 모양 (사운드 오브제와 같은 데이터).
function _stoneWave(v, w, H, cell, scale) {
    const [c, ctx] = _stoneCanvas(w, H, scale, "hsl(224, 7%, 76%)");
    const bytes = _recordBytes(v), rand = _stoneRand(v);
    const rowH = cell * 2.6, amp = rowH * 0.42, step = Math.max(3, cell * 0.5);
    ctx.strokeStyle = "hsl(228, 9%, 32%)";
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    let i = 0;
    for (let yc = rowH * 0.6; yc + amp * 0.5 < H; yc += rowH) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += step) {
            const byte = i < bytes.length ? bytes[i++] : Math.floor(rand() * 256);
            const y = yc + ((byte - 127.5) / 127.5) * amp * 0.5;
            if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
    }
    return c;
}

// 문법 선택 — sharecard.js(상세 카드 배경)도 이 함수를 쓴다
function stoneRender(v, w, H, cell, scale) {
    switch (STONE_STYLE) {
        case "hatch": return _stoneHatch(v, w, H, cell, scale);
        case "weave": return _stoneWeave(v, w, H, cell, scale);
        case "braille": return _stoneBraille(v, w, H, cell, scale);
        case "morse": return _stoneMorse(v, w, H, cell, scale);
        case "wave": return _stoneWave(v, w, H, cell, scale);
        default: return graniteRender(v, w, H, cell, scale); // mosaic
    }
}

const _graniteCache = new Map(); // "victimIdx:w" -> offscreen canvas (LRU)
function graniteCanvas(victimIdx, w, H) {
    const key = `${victimIdx}:${Math.round(w)}`;
    let c = _graniteCache.get(key);
    if (c) { // LRU 갱신
        _graniteCache.delete(key);
        _graniteCache.set(key, c);
        return c;
    }
    c = stoneRender(victims[victimIdx], w, H, GRANITE.CELL, 2);
    if (_graniteCache.size >= GRANITE.CACHE_MAX) {
        _graniteCache.delete(_graniteCache.keys().next().value); // 가장 오래된 것 제거
    }
    _graniteCache.set(key, c);
    return c;
}

// depthN(0~1): 위에서 얼마나 깊이 묻혔나 — 깊을수록 살짝 어둡고 모서리가 눌린다
// (오래 쌓인 지층이 압착되는 느낌, 작가 선택 2026-08-17). 랜덤이 아니라 규칙.
function drawMetalBlock(cx, cy, lum = 2, depthN = 0, victimIdx = -1) {
    const w = pile.blockW();
    const H = CONFIG.BLOCK_H;
    const r = 3 + depthN * 2; // 아래로 갈수록 모서리가 조금 더 둥글게 — 닳은 켜
    push();
    translate(cx, cy);
    if (GRANITE_ON && victimIdx >= 0) {
        // 화강암 모자이크 — 둥근 모서리로 클리핑해 오프스크린 캐시를 얹는다
        const dc = drawingContext;
        dc.save();
        dc.beginPath();
        dc.roundRect(-w / 2, -H / 2, w, H, r);
        dc.clip();
        dc.drawImage(graniteCanvas(victimIdx, w, H), -w / 2, -H / 2, w, H);
        dc.restore();
        // 밝은 돌들 사이의 줄눈 — 배경색의 굵은 경계로 켜를 분리 (작가: 경계가 안 보임)
        stroke(...CONFIG.COLORS.bg);
        strokeWeight(3);
        noFill();
        rect(-w / 2, -H / 2, w, H, r);
    } else {
        drawingContext.fillStyle = metalGradient(w, lum);
        stroke(0, 110); // 켜 사이 가는 어두운 경계
        strokeWeight(1);
        rect(-w / 2, -H / 2, w, H, r);
    }
    drawingContext.fillStyle = bevelGradient(H);
    noStroke();
    rect(-w / 2 + 0.5, -H / 2 + 0.5, w - 1, H - 1, r);
    if (depthN > 0) { // 깊이 그늘 — 최대 12% 어둡게
        fill(0, 0, 0, 30 * depthN);
        rect(-w / 2, -H / 2, w, H, r);
    }
    pop();
}

// ---- 월/연 경계 요약 오버레이 ----
let _monthCounts = new Map(); // "YYYY-MM" → n
let _yearCounts = new Map();  // "YYYY" → n
function computePeriodCounts() {
    _monthCounts = new Map();
    _yearCounts = new Map();
    for (const v of victims) {
        const ym = String(v.date || "").slice(0, 7);
        if (ym.length !== 7) continue;
        _monthCounts.set(ym, (_monthCounts.get(ym) || 0) + 1);
        const y = ym.slice(0, 4);
        _yearCounts.set(y, (_yearCounts.get(y) || 0) + 1);
    }
}

function dateOfSettled(i) {
    const s = pile.settled[i];
    return s ? victims[s.victimIdx].date : null;
}

function drawPeriodMarker(label, y, size, strong, alpha) {
    if (alpha <= 0.01) return;
    textStyle(BOLD);
    textSize(size);
    const tw = textWidth(label);
    const ph = size + 14;
    fill(13, 13, 15, 235 * alpha);
    noStroke();
    rect(width / 2 - tw / 2 - 16, y - ph / 2, tw + 32, ph, ph / 2);
    noStroke();
    fill(255, 255, 255, 255 * alpha);
    textAlign(CENTER, CENTER);
    text(label, width / 2, y);
    textStyle(NORMAL);
}

// 경계가 화면 중앙에 있을 때 가장 진하고, 위아래로 멀어지면 사라진다.
// 스크롤하면서 그 시기를 지나갈 때만 보이고 블럭을 계속 가리지 않는다 (작가 결정 2026-07-31).
function markerAlpha(worldY) {
    const screenY = worldY - cameraY;
    const d = Math.abs(screenY - height / 2);
    const full = height * 0.12;  // 이 안에서는 완전 불투명
    const fade = height * 0.34;  // 여기서 0
    if (d <= full) return 1;
    if (d >= fade) return 0;
    return 1 - (d - full) / (fade - full);
}

function drawPeriodMarkers(lo, hi) {
    const H = CONFIG.BLOCK_H;
    for (let i = Math.max(1, lo); i <= hi; i++) {
        const cur = dateOfSettled(i);
        const prev = dateOfSettled(i - 1);
        if (!cur || !prev) continue;
        if (cur.slice(0, 7) === prev.slice(0, 7)) continue;

        // i(위, 새 달)와 i-1(아래, 이전 달) 사이 경계 — 이전 달의 요약을 표시
        const by = pile.yOfCenter(i) + H / 2;
        const a = markerAlpha(by);
        if (a <= 0.01) continue;
        const ym = prev.slice(0, 7);
        drawPeriodMarker(`${parseInt(ym.slice(5, 7), 10)}월 · ${_monthCounts.get(ym) || 0}명`, by, 16, false, a);
        if (cur.slice(0, 4) !== prev.slice(0, 4)) {
            const yy = prev.slice(0, 4);
            drawPeriodMarker(`${yy}년 · ${_yearCounts.get(yy) || 0}명`, by - 38, 20, true, markerAlpha(by - 38));
        }
    }
}

function drawSettledBlocks(now) {
    const [lo, hi] = pile.visibleRange(cameraY, height);
    const w = pile.blockW();
    const H = CONFIG.BLOCK_H;

    for (let i = lo; i <= hi; i++) {
        const s = pile.settled[i];
        if (!s) continue;
        const v = victims[s.victimIdx];
        const cy = pile.yOfCenter(i) + shakeOffset(i, now); // 착지 충격파 (렌더 전용)
        const bv = blockVariation(s.victimIdx);
        const bx = width / 2 + bv.jx; // 블럭별 수평 변주 — 오버레이도 같이 따라간다
        // 깊이 = 위에 쌓인 블럭 수. 150켜쯤이면 완전히 '오래된 층'
        const depthN = Math.min(1, (pile.settled.length - 1 - i) / 150);

        drawMetalBlock(bx, cy, bv.lum, depthN, s.victimIdx);

        // 선택된 블럭: 은은한 앰버 틴트 + 테두리
        if (i === selectedIdx) {
            fill(...CONFIG.COLORS.accent, 34);
            stroke(...CONFIG.COLORS.accent, 200);
            strokeWeight(1.5);
            rect(bx - w / 2 + 1, cy - H / 2 + 1, w - 2, H - 2, 3);
        } else if (i === lastViewedIdx) {
            // 방금 보고 나온 블럭 — 좌측 세로 표식 하나. 테두리를 두르면 선택과 구별이
            // 안 되고 여러 개가 강조된 것처럼 보이므로, 읽던 자리를 가리키는 정도로만.
            noStroke();
            fill(...CONFIG.COLORS.accent, 150);
            rect(bx - w / 2 + 1, cy - H / 2 + 10, 3, H - 20, 1.5);
        }

        const highlight = s.settledAt > 0 && now - s.settledAt < CONFIG.HIGHLIGHT_MS
            ? 1 - (now - s.settledAt) / CONFIG.HIGHLIGHT_MS : 0;
        if ((highlight > 0 || i === hoverIdx) && i !== selectedIdx) {
            noFill();
            if (i === hoverIdx) { stroke(...CONFIG.COLORS.text); strokeWeight(1.2); }
            else { stroke(...CONFIG.COLORS.accent, 90 + 165 * highlight); strokeWeight(1.5); }
            rect(bx - w / 2 + 2, cy - H / 2 + 2, w - 4, H - 4, 4);
        }

        drawBlockLabels(bx, cy, v);
    }

    drawPeriodMarkers(lo, hi); // 월/연 경계 요약 (블럭 위에 오버랩)
}

function drawFallingBlock() {
    if (!pile.falling) return;
    const v = victims[pile.falling.victimIdx];
    const p = pile.falling.body.position;
    const bv = blockVariation(pile.falling.victimIdx); // 떨어질 때부터 착지 후와 같은 모양
    drawMetalBlock(p.x + bv.jx, p.y, bv.lum, 0, pile.falling.victimIdx); // 갓 떨어진 블럭은 깊이 0
    drawBlockLabels(p.x + bv.jx, p.y, v);
}

const _DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];
const _dowCache = new Map();
function dayOfWeek(dateStr) {
    let d = _dowCache.get(dateStr);
    if (d === undefined) {
        const t = new Date(`${dateStr}T00:00:00`);
        d = isNaN(t) ? "" : _DAY_NAMES[t.getDay()];
        _dowCache.set(dateStr, d);
    }
    return d;
}

function drawBlockLabels(cx, cy, v) {
    const w = pile.blockW();

    // 한 블럭에 2줄 (작가 결정 2026-08-01):
    //   윗줄 = 언제·어디서 (날짜 요일 장소)
    //   아랫줄 = 더 구체적인 것 (사인 · 연령 · 이주노동자)
    // 예전에는 한 줄에 좌(날짜+지역)/우(사인·연령)로 나눠서, 좁은 화면에서 가로가 모자라면
    // 우측이 통째로 사라졌다 — 사인·나이가 없는 것처럼 보이던 원인.
    // 사인이 밝혀지지 않은 경우(쓰러진 채 발견·심정지 등)는 그냥 비워둔다.
    const region = displayRegion(v);
    const dow = dayOfWeek(v.date);
    const whenWhere = [dow ? `${v.date} ${dow}` : `${v.date}`, region].filter(Boolean).join("   ");
    const infoParts = [];
    if (v.accType) infoParts.push(v.accType);
    const dec = ageDecadeLabel(v.age);
    if (dec) infoParts.push(dec);
    if (v.immigrant) infoParts.push("이주노동자");

    noStroke();
    const leftX = cx - w / 2 + 18;
    const lineGap = 22;               // 88px 블럭에 2줄 — 위 -11, 아래 +11
    const yTop = cy - lineGap / 2;
    const yBottom = cy + lineGap / 2;

    // 블럭에는 확인 표식·수를 아무것도 올리지 않는다 (2026-08-08 작가 결정) —
    // 표식(추모 꽃)은 통계 패널과 상세 뷰에, 수는 상세 뷰 문장("N명이 확인했습니다")에 있다.
    const rightX = cx + w / 2 - 18;

    // 윗줄: 날짜 요일 장소 — 화강암(밝은 돌)에는 어둡게 새긴다 (비석의 음각처럼)
    if (GRANITE_ON) fill(18, 18, 22);
    else fill(...CONFIG.COLORS.text);
    textAlign(LEFT, CENTER);
    textSize(18);
    text(whenWhere, leftX, yTop);

    // 아랫줄: 사인 · 연령 · 이주노동자 — 그래도 넘치면 뒤에서부터 덜어낸다
    if (infoParts.length) {
        textSize(16);
        if (GRANITE_ON) fill(45, 46, 52);
        else fill(...CONFIG.COLORS.textDim);
        const room = rightX - 12 - leftX;
        let parts = infoParts.slice();
        while (parts.length > 1 && textWidth(parts.join(" · ")) > room) parts.pop();
        text(parts.join(" · "), leftX, yBottom);
    }
}

function drawHUD() {
    noStroke();
    fill(0, 160);
    rect(6, 6, 190, 58, 4);
    fill(255);
    textAlign(LEFT, TOP);
    textSize(11);
    text(
        `fps ${nf(frameRate(), 2, 1)}\n` +
        `settled ${pile.settled.length} / ${victims.length}  queue ${spawnQueue.length}\n` +
        `state ${appState}  follow ${followMode}`,
        14, 12
    );
}

// =====================[ 인터랙션 ]=====================

// hover는 마우스만의 개념이다. 터치에서는 p5가 합성 마우스 이벤트를 보내 hoverIdx가
// 설정되고, 손을 떼도 지워지지 않아 블럭에 흰 테두리가 남아 있었다 —
// 선택 표시로 오인됨 (작가 보고 2026-08-01). 터치를 한 번이라도 쓴 기기에서는 hover를 끈다.
let usingTouch = false;

function mouseMoved() {
    if (usingTouch) { hoverIdx = -1; return; }
    if (!overCanvas() || pile === undefined) { hoverIdx = -1; return; }
    hoverIdx = pile.indexAtWorldY(mouseY + cameraY);
    cursor(hoverIdx >= 0 ? "pointer" : "default");
}

function mousePressed(event) {
    // 캔버스 위 DOM 요소('현재로' 버튼, 오버레이 등) 클릭이 블럭 클릭으로 새지 않게
    if (event && event.target && event.target.tagName !== "CANVAS") return;
    if (DEBUG) console.log("[tf] mousePressed", mouseX, mouseY, "cameraY", cameraY, "over", overCanvas());
    if (!overCanvas() || !pile) return;
    // 터치/클릭이 mouseMoved 없이 올 수 있으므로 hoverIdx에 의존하지 않고 직접 계산
    const idx = pile.indexAtWorldY(mouseY + cameraY);
    if (DEBUG) console.log("[tf] click idx", idx, "settled", pile.settled.length);
    if (idx < 0) return;
    const s = pile.settled[idx];
    if (s) { selectedIdx = idx; lastViewedIdx = idx; showDetail(victims[s.victimIdx]); }
}

// ---- 모바일: 캔버스 터치 드래그 스크롤 + 상단 헤더 숨김/표시 ----
// 탭(이동 거의 없음)은 touchEnded에서 블럭 선택으로, 드래그는 카메라 스크롤로 처리.
const _touch = { lastY: 0, moved: 0, headerAccum: 0, vel: 0, fling: 0 };

function isCanvasEvent(event) {
    return event && event.target && event.target.tagName === "CANVAS";
}

function setMobileHeader(show) {
    document.body.classList.toggle("hdr-hidden", !show);
}

function touchStarted(event) {
    usingTouch = true;   // 이후 hover 테두리를 그리지 않는다
    hoverIdx = -1;
    if (!isCanvasEvent(event)) return true;
    _touch.lastY = mouseY;
    _touch.moved = 0;
    _touch.headerAccum = 0;
    _touch.vel = 0;
    _touch.fling = 0; // 진행 중이던 관성 스크롤은 손이 닿는 순간 멈춤
    return true; // touchstart 기본동작 유지 (오디오 언락 등)
}

function touchMoved(event) {
    if (!isCanvasEvent(event)) return true;
    const dy = _touch.lastY - mouseY; // 손가락 위로 = 아래(과거) 지층으로 스크롤
    _touch.lastY = mouseY;
    _touch.moved += Math.abs(dy);
    if (_touch.moved > 4) {
        cameraY += resistDelta(dy); // 경계 밖에서는 저항 — 놓으면 updateCamera가 되돌림
        setFollow(false);
        _touch.vel = 0.7 * dy + 0.3 * _touch.vel; // 놓았을 때 관성으로 이어질 속도
        // 스크롤 방향에 따라 헤더 토글 — 방향이 바뀌면 누적을 리셋 (히스테리시스)
        if ((dy > 0) !== (_touch.headerAccum > 0)) _touch.headerAccum = 0;
        _touch.headerAccum += dy;
        if (_touch.headerAccum > 24) setMobileHeader(false);
        else if (_touch.headerAccum < -24) setMobileHeader(true);
    }
    return false; // 페이지 스크롤/바운스 방지
}

function touchEnded(event) {
    if (!isCanvasEvent(event)) return true;
    if (_touch.moved < 10 && pile) {
        const idx = pile.indexAtWorldY(mouseY + cameraY);
        const s = idx >= 0 ? pile.settled[idx] : null;
        if (s) { selectedIdx = idx; lastViewedIdx = idx; showDetail(victims[s.victimIdx]); }
    } else if (Math.abs(_touch.vel) > 1.5) {
        _touch.fling = _touch.vel; // 관성 스크롤 시작 (draw에서 감쇠)
    }
    return false; // 합성 마우스 이벤트(mousePressed 중복 선택) 방지
}

function windowResized() {
    const holder = document.getElementById("canvas-holder");
    resizeCanvas(holder.clientWidth, holder.clientHeight);
    if (pile) pile.resize(width);
}

// =====================[ DOM ]=====================

function setupDOM() {
    const followBtn = document.getElementById("follow-btn");
    followBtn.addEventListener("click", () => {
        setFollow(true);
        setMobileHeader(true); // 현재로 돌아오면 상단 바도 함께 돌아온다 (작가 요청 2026-08-17)
    });
    document.getElementById("ack-btn").addEventListener("click", onAckClick);
    document.getElementById("post-ack-btn").addEventListener("click", onAckClick);
    document.getElementById("post-share-btn").addEventListener("click", onShareClick);
    document.getElementById("project-share").addEventListener("click", onProjectShareClick);
    document.getElementById("post-back").addEventListener("click", closeDetail);

    const overlay = document.getElementById("detail-overlay");
    document.getElementById("detail-close").addEventListener("click", closeDetail);
    overlay.addEventListener("click", (e) => {
        if (e.target !== overlay) return;
        // 팝업이 열린 상태에서 다른 블럭을 누르면 그 블럭의 내용으로 교체
        const canvas = document.querySelector("#canvas-holder canvas");
        const r = canvas ? canvas.getBoundingClientRect() : null;
        if (r && pile &&
            e.clientX >= r.left && e.clientX <= r.right &&
            e.clientY >= r.top && e.clientY <= r.bottom) {
            const idx = pile.indexAtWorldY((e.clientY - r.top) + cameraY);
            const s = idx >= 0 ? pile.settled[idx] : null;
            if (s) { selectedIdx = idx; lastViewedIdx = idx; showDetail(victims[s.victimIdx]); return; }
        }
        closeDetail();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (document.body.classList.contains("info-open")) closeInfo();
        else closeDetail();
    });
    // 모바일: 우상단 '정보' 버튼이 정보 뷰(공지/통계/구독)를 연다 — 열리면 ✕(닫기)로 바뀜
    // (2026-08-16 작가 결정: 제목에 캐럿·화살표를 붙이는 시도가 다 어색해 명시적 손잡이로).
    // 제목 클릭도 여전히 같은 토글로 동작한다.
    document.getElementById("info-toggle").addEventListener("click", () => {
        if (document.body.classList.contains("info-open")) closeInfo();
        else openInfo();
    });
    // 상세 뷰 우상단 '+' — 정보 뷰를 상세 위에 얹는다 (작가 요청 2026-08-17).
    // 상세를 닫지 않으므로 정보 뷰의 ✕(= history.back)가 보던 상세로 그대로 돌아간다.
    // 겹침은 body.info-open #panel의 z-index가 post-view 위로 올라가며 성립.
    document.getElementById("post-info").addEventListener("click", openInfo);
    document.querySelector("#panel-header h1").addEventListener("click", () => {
        if (!isMobileView()) return;
        if (document.body.classList.contains("info-open")) closeInfo();
        else openInfo();
    });
    // 시스템 뒤로가기(제스처 포함)로 상세/정보 뷰가 닫히게 — 사이트 이탈 방지
    window.addEventListener("popstate", (e) => {
        const st = e.state || {};
        if (!st.tfDetail) hideDetailUI();
        if (!st.tfInfo) hideInfoUI();
    });
    // 알림 클릭 딥링크 — 서비스 워커(sw.js notificationclick)가 이미 열려 있는 이 창에
    // 보내는 메시지. iOS가 WindowClient.navigate를 거부하는 경우의 경로 (2026-08-17).
    if ("serviceWorker" in navigator) {
        navigator.serviceWorker.addEventListener("message", (e) => {
            const d = e.data || {};
            if (d.type !== "open-url" || typeof d.url !== "string") return;
            let u;
            try { u = new URL(d.url, location.href); } catch { return; }
            if (u.origin !== location.origin) return;
            if (u.pathname === location.pathname) {
                // 같은 페이지면 리로드 없이 해시만 바꿔 그 기록을 연다 (데이터는 이미 로드됨)
                history.replaceState(null, "", u.hash || "#");
                openFromHash();
            } else {
                location.href = u.href;
            }
        });
    }
}

// ---- 정보 뷰 — 모바일에서 제목을 누르면 패널 전체(공지/통계/구독)를 펼침 ----

// 정보(+) 버튼의 접근성 라벨을 상태에 맞춘다 — 시각적으로는 CSS가 +를 45° 돌려 ✕로 만든다
function syncInfoToggle() {
    const btn = document.getElementById("info-toggle");
    if (!btn) return;
    const open = document.body.classList.contains("info-open");
    btn.setAttribute("aria-label", open ? "정보 닫기" : "정보 열기");
}

function openInfo() {
    document.body.classList.add("info-open");
    syncInfoToggle();
    history.pushState({ tfInfo: 1 }, "", "#/about");
}

function hideInfoUI() {
    document.body.classList.remove("info-open");
    syncInfoToggle();
}

function closeInfo() {
    if (history.state && history.state.tfInfo) {
        history.back(); // popstate가 hideInfoUI를 호출
    } else {
        hideInfoUI();
        if (location.hash.startsWith("#/about")) {
            history.replaceState(null, "", location.pathname + location.search);
        }
    }
}

// 항상 모바일(포스트 뷰) 경로 — 데스크톱도 같은 레이아웃을 가운데 480px 기둥으로
// 세우기로 하면서 별도 데스크톱 뷰(팝업 상세)를 폐지 (작가 결정 2026-08-16).
// 함수와 데스크톱 경로 코드는 되돌리기 쉽게 남겨 둔다.
function isMobileView() {
    return true;
}

function showDetail(v) {
    // 공개 데이터는 최소 필드(date/region/accType/age/immigrant/link)만 담는다 —
    // 상세한 내용은 기사 원문 링크로 안내.
    const dec = ageDecadeLabel(v.age);
    const parts = [];
    if (dec) parts.push(dec);
    // "이주노동자"는 이미 노동자를 포함 — 병기하면 "이주노동자 노동자"가 된다
    // (notify_subscribers.mjs buildBody와 같은 규칙: 택일, accType "기타"는 정보가 없으므로 생략)
    parts.push(v.immigrant ? "이주노동자" : "노동자");
    // 사인이 밝혀지지 않았으면 그냥 비워둔다 — 채우지 않는다 (작가 결정 2026-08-01)
    const showType = v.accType && v.accType !== "기타";
    const title = `${parts.join(" ")}${showType ? `, ${v.accType} 사고로` : ""} 사망`;
    const realLink = String(v.link || "").split("#s")[0]; // stress 테스트 접미사 제거
    let summary = "";
    if (realLink) {
        summary = stripByline(v.accSummary);
        // 원본이 300자에서 중간에 잘린 경우 — 문장이 끝나지 않았으면 …로 마무리
        if (summary && !/[.!?…]["'”’]?$/.test(summary)) summary += "…";
        if (!summary) summary = "자세한 내용은 기사 원문에서 확인할 수 있습니다.";
    }

    detailPid = v._ackId || null;
    if (isMobileView()) populatePostView(v, title, summary, realLink);
    else populateDetailCard(v, title, summary, realLink);
    if (detailPid) updateAckRow(detailPid);
    pushDetailHistory(v);
}

function populateDetailCard(v, title, summary, realLink) {
    document.getElementById("detail-date").textContent = formatKoreanDate(v.date);
    document.getElementById("detail-title").textContent = title;
    document.getElementById("detail-meta").textContent =
        v.ofDeaths > 1
            ? `${displayRegion(v)} · 이 사고로 ${v.ofDeaths}명이 숨졌습니다`
            : displayRegion(v);
    document.getElementById("detail-summary").textContent = summary;
    const link = document.getElementById("detail-link");
    if (realLink) {
        link.href = realLink;
        link.hidden = false;
    } else {
        link.hidden = true;
    }
    document.getElementById("detail-ack").hidden = !realLink;
    document.getElementById("post-view").hidden = true;
    document.getElementById("detail-overlay").hidden = false;
}

// 모바일: 팝업 대신 화면을 가득 채우는 포스트 형식 —
// 요약이 이미지 영역을(사진 없이 문장이 초상), 메타데이터가 캡션 영역을 차지.
function populatePostView(v, title, summary, realLink) {
    const summaryEl = document.getElementById("post-summary");
    summaryEl.textContent = summary;
    // 이전 기록의 카드 이미지가 새 기록 위에 잠깐 보이지 않게 — 새 카드가 완성되면 다시 표시
    const staleCard = document.getElementById("post-card");
    if (staleCard) staleCard.hidden = true;
    document.getElementById("post-title").textContent = title;
    // 여럿이 숨진 사고는 그 사실을 밝힌다 — 블럭 하나가 한 사람이므로,
    // 같은 사고의 다른 블럭들이 왜 나란히 쌓여 있는지 여기서만 알 수 있다.
    document.getElementById("post-meta").textContent =
        v.ofDeaths > 1
            ? `${displayRegion(v)} · 이 사고로 ${v.ofDeaths}명이 숨졌습니다`
            : displayRegion(v);
    const dow = dayOfWeek(v.date);
    document.getElementById("post-date").textContent =
        `${formatKoreanDate(v.date)}${dow ? ` ${dow}요일` : ""}`;
    const link = document.getElementById("post-link");
    if (realLink) {
        link.href = realLink;
        link.hidden = false;
    } else {
        link.hidden = true;
    }
    document.getElementById("post-actions").hidden = !realLink;
    document.getElementById("detail-overlay").hidden = true;
    document.getElementById("post-view").hidden = false;

    // 글자 크기는 고정 — 레이아웃이 잡힌 뒤 공간에 맞춰 텍스트를 자름
    requestAnimationFrame(() => {
        fitSummary(summaryEl, document.getElementById("post-image"), summary);
        // 같은 내용을 캔버스로 그려 <img>로 얹는다 — 길게 누르면 '이미지 저장' (sharecard.js)
        updatePostCard(v, summary);
    });
}

// 이미지 영역에 들어가지 않는 요약은 텍스트를 잘라 " …"로 마무리.
// 잘린 마지막 줄이 블록의 실제 마지막 줄이 되므로 justify가 늘리지 않아 …가 겹치지 않는다.
function fitSummary(el, box, full) {
    el.textContent = full;
    const avail = box.clientHeight - 60; // 상하 패딩 30px
    if (el.scrollHeight <= avail + 2) return; // 전부 들어감
    let lo = 0, hi = full.length;
    while (lo < hi) { // 들어가는 최대 길이를 이분 탐색 (~9회 재측정)
        const mid = Math.ceil((lo + hi) / 2);
        el.textContent = full.slice(0, mid).trimEnd() + " …";
        if (el.scrollHeight <= avail + 2) lo = mid;
        else hi = mid - 1;
    }
    el.textContent = full.slice(0, lo).trimEnd() + " …";
}

// 표시용 바이라인 제거 — "(안동=연합뉴스) 황수빈 기자 = " 류의 도입부.
// 출처·기자는 '기사 원문 보기'가 담당하므로 초상 영역에서는 사고 서술만 남긴다.
function stripByline(s) {
    return String(s || "")
        .replace(/^\s*[\[(][^\])]*(?:=|뉴스|일보|신문)[^\])]*[\])]\s*/, "")
        .replace(/^\s*[가-힣a-zA-Z·\s]{2,20}(?:기자|특파원)\s*=\s*/, "")
        .trim();
}

// ---- 히스토리/딥링크 ----
// 상세 뷰를 열 때 히스토리 항목을 쌓아 시스템 뒤로가기가 "닫기"로 동작하게 한다.
// URL은 #/record/<ackId> — 알림·공유 링크가 특정 기록으로 바로 열릴 수 있는 형태.

async function pushDetailHistory(v) {
    const id = v._ackId || v.pid || (v.link ? await ackId(v.link) : null);
    const hash = id ? `#/record/${id}` : location.hash;
    if (history.state && history.state.tfDetail) history.replaceState({ tfDetail: id }, "", hash);
    else history.pushState({ tfDetail: id }, "", hash);
}

function openFromHash() {
    // #/about — 정보 뷰가 열린 채 새로 로드된 경우(알림 안내 페이지의 '돌아가기'가
    // history.back()으로 돌아왔는데 bfcache 미스) 정보 뷰를 복원한다.
    // 아래 딥링크와 같은 구조: 블럭 화면을 밑에 깔아 뒤로가기가 그리로 돌아가게 한다.
    if (/^#\/about/.test(location.hash || "")) {
        const base = location.pathname + location.search;
        history.replaceState(null, "", base);
        history.pushState({ tfInfo: 1 }, "", "#/about");
        document.body.classList.add("info-open");
        syncInfoToggle();
        return;
    }
    const m = /^#\/record\/([0-9a-f]{16})/.exec(location.hash || "");
    if (!m) return;
    const v = victims.find((x) => x._ackId === m[1]);
    if (!v) return;
    const si = pile.settled.findIndex((s) => victims[s.victimIdx] === v);
    if (si >= 0) {
        selectedIdx = si;
        lastViewedIdx = si;
        setFollow(false);
        cameraY = pile.yOfCenter(si) - height / 2; // 닫았을 때 해당 블럭이 보이도록
    } else {
        // 아직 착지 전(방금 배포된 최신 기록 = 리플레이 대상) — 예전에는 여기서 아무것도
        // 못 해서, 알림을 누르고 들어온 사람이 상세를 닫으면 표식 없는 블럭 더미만 보였다.
        // 착지 시 draw()가 선택을 배정한다. 카메라는 followMode가 꼭대기를 따라가므로 그대로 둔다.
        pendingDeepLinkVi = victims.indexOf(v);
    }
    // 딥링크(텔레그램·ntfy 알림, 공유 링크)로 바로 들어온 경우 히스토리에 항목이 하나뿐이라,
    // 예전에는 뒤로가기가 아무 일도 하지 않았다(back으로 돌아갈 곳이 없음).
    // 블럭 화면을 밑에 깔고 그 위에 상세를 얹어서, 뒤로가기·닫기 버튼이 블럭 전체 화면으로
    // 돌아오게 한다 (2026-08-01 텔레그램 실사용 보고).
    const base = location.pathname + location.search;
    history.replaceState(null, "", base);            // 아래: 블럭 화면
    history.pushState({ tfDetail: m[1] }, "", `#/record/${m[1]}`); // 위: 상세
    showDetail(v);
}

// ---- "들었습니다" ----
// 데이터가 사람 단위가 된 뒤로는 링크가 사람을 특정하지 못한다(한 기사에 여러 사람).
// 확인(ack)의 키는 레코드의 pid.
let detailPid = null;

// 데스크톱 팝업과 모바일 포스트 뷰의 확인 버튼/카운트를 함께 갱신
const ACK_UI = [["ack-count", "ack-btn"], ["post-ack-count", "post-ack-btn"]];

function updateAckRow(id) {
    if (id !== detailPid) return; // 그 사이 다른 카드가 열렸으면 무시
    const n = _acks[id] || 0;
    const acked = hasAcked(id);

    // 데스크톱 팝업: 아이콘 버튼 + 안내문
    document.getElementById("ack-count").textContent =
        n > 0 ? `이 죽음을 ${n}명이 확인했습니다` : "이 죽음을 확인했다면, 눌러주세요";
    const dBtn = document.getElementById("ack-btn");
    dBtn.disabled = acked;
    dBtn.innerHTML = acked ? `${flowerImgHTML(id, 25)} ✓` : flowerImgHTML(id, 25);

    // 모바일 포스트 뷰: 문장 버튼 + 카운트
    document.getElementById("post-ack-count").textContent =
        n > 0 ? `이 죽음을 ${n}명이 확인했습니다` : "아직 아무도 이 죽음을 확인하지 않았습니다";
    const mBtn = document.getElementById("post-ack-btn");
    mBtn.disabled = acked;
    mBtn.innerHTML = acked
        ? `${flowerImgHTML(id, 25)} 이 죽음을 확인했습니다 ✓`
        : `${flowerImgHTML(id, 25)} 이 죽음을 확인합니다`;
}

async function onAckClick() {
    if (!detailPid) return;
    const id = detailPid;
    if (hasAcked(id)) return;
    for (const [, btnId] of ACK_UI) document.getElementById(btnId).disabled = true;
    try {
        await sendAck(id);
        markAcked(id);
        updateAckRow(id);
        renderStats(victims, pile.settled.length); // '기록된 애도' 즉시 반영
    } catch {
        for (const [, btnId] of ACK_UI) document.getElementById(btnId).disabled = false; // 재시도 가능
    }
}

// ---- 공유 ----
// 네이티브 공유 시트(Web Share API)를 우선 쓰고, 미지원 환경은 딥링크 복사로 폴백.

async function onShareClick() {
    if (!detailPid) return;
    const url = `${location.origin}${location.pathname}#/record/${detailPid}`;
    const title = document.getElementById("post-title").textContent;
    const date = document.getElementById("post-date").textContent;
    const text = `${date}. ${title} — 떨어지고, 끼이고, 깔린`;
    if (navigator.share) {
        // 카드 이미지가 있으면 파일로 첨부 — 링크만이 아니라 사고 경위 카드가 함께 퍼진다
        let files;
        try {
            const f = typeof getCardFile === "function" ? await getCardFile() : null;
            if (f && navigator.canShare && navigator.canShare({ files: [f] })) files = [f];
        } catch { /* 첨부 실패는 링크 공유로 폴백 */ }
        try { await navigator.share({ title: "떨어지고, 끼이고, 깔린", text, url, ...(files ? { files } : {}) }); }
        catch { /* 사용자가 공유 시트를 닫음 */ }
        return;
    }
    const ok = await copyText(url);
    if (ok) flashShareMsg();
}

// 프로젝트 자체 공유 — 정보 뷰의 '알리기' (작가 선택 A, 2026-08-17).
// 문구에 누적 숫자를 넣어 홍보가 아니라 증언이 되게 한다.
async function onProjectShareClick(e) {
    e.preventDefault();
    const url = `${location.origin}${location.pathname}`;
    const n = victims.length;
    const text = `떨어지고, 끼이고, 깔린 — 일하다 죽은 사람들의 기록.${n ? ` 지금까지 ${n}명.` : ""}`;
    if (navigator.share) {
        try { await navigator.share({ title: "떨어지고, 끼이고, 깔린", text, url }); }
        catch { /* 사용자가 공유 시트를 닫음 */ }
        return;
    }
    const ok = await copyText(`${text}\n${url}`);
    if (ok) {
        const msg = document.getElementById("project-share-msg");
        msg.hidden = false;
        clearTimeout(onProjectShareClick._t);
        onProjectShareClick._t = setTimeout(() => { msg.hidden = true; }, 1800);
    }
}

async function copyText(t) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(t);
            return true;
        }
    } catch { /* 아래 폴백 시도 */ }
    try { // http(LAN 테스트 등) — clipboard API가 없는 환경용 구식 폴백
        const ta = document.createElement("textarea");
        ta.value = t;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
    } catch { return false; }
}

let _shareMsgTimer = 0;
function flashShareMsg() {
    const msg = document.getElementById("post-share-msg");
    msg.hidden = false;
    clearTimeout(_shareMsgTimer);
    _shareMsgTimer = setTimeout(() => { msg.hidden = true; }, 2000);
}

// UI만 닫는다 (히스토리는 건드리지 않음 — popstate에서 호출됨)
function hideDetailUI() {
    selectedIdx = -1;   // lastViewedIdx는 남긴다 — 돌아왔을 때 어디까지 봤는지 보이게
    document.getElementById("detail-overlay").hidden = true;
    document.getElementById("post-view").hidden = true;
}

// 닫기 버튼/ESC용 — 우리가 쌓은 히스토리 항목이 있으면 back으로 되돌린다
function closeDetail() {
    if (history.state && history.state.tfDetail) {
        history.back(); // popstate가 hideDetailUI를 호출
    } else {
        hideDetailUI();
        if (location.hash.startsWith("#/record")) {
            history.replaceState(null, "", location.pathname + location.search);
        }
    }
}

function showRevisitBanner(n) {
    const el = document.getElementById("revisit-banner");
    el.textContent = `지난 방문 이후 ${n}명의 노동자가 더 사망했습니다.`;
    el.hidden = false;
}

// =====================[ 폴링 ]=====================

function startPolling() {
    const sec = parseInt(getParam("poll") || "0", 10);
    const ms = sec > 0 ? sec * 1000 : CONFIG.POLL_MS;
    // 확인(ack)은 신규 데이터보다 훨씬 자주 본다 — 누군가 확인한 순간을 소리로
    // 전하려면 10분 주기로는 너무 늦다.
    setInterval(pollAcks, sec > 0 ? sec * 1000 : CONFIG.ACK_POLL_MS);
    setInterval(async () => {
        if (appState !== "live") return;
        try {
            const next = await loadVictimData();
            const fresh = diffNewVictims(victims, next);
            if (fresh.length > 0) {
                for (const v of fresh) {
                    victims.push(v);
                    spawnQueue.push(victims.length - 1);
                }
                markLatestSeen(victims);
                computeAckIds(fresh);   // 신규 블럭 ♥ 표시용
                computePeriodCounts();  // 월/연 요약 갱신
            }
        } catch (e) {
            console.warn("poll failed:", e);
        }
    }, ms);
}

async function pollAcks() {
    await loadAcks();
    renderStats(victims, pile.settled.length); // 애도 카운터·통계 갱신
    if (detailPid) updateAckRow(detailPid);    // 열려 있는 상세 뷰 카운트도 갱신
    // 누군가 어떤 죽음을 확인했다 — 페이지가 열려 있으면 소리로 전한다.
    // (푸시 알림을 걷어내고 그 자리를 이 소리에 넘겼다 — 작가 결정 2026-08-01)
    if (acksAdded > 0) playAckChime(acksAdded);
}
