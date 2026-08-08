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

    // 터치 관성(플링) 스크롤 — 손을 뗀 뒤 감쇠하며 이어짐
    if (_touch.fling !== 0) {
        cameraY += _touch.fling;
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

function updateCamera() {
    if (followMode) {
        const target = pile.topY() - height * CONFIG.FOLLOW_ANCHOR;
        cameraY = lerp(cameraY, target, CONFIG.FOLLOW_LERP);
    }
    const minY = pile.topY() - height * 0.9;
    const maxY = CONFIG.GROUND_Y - height + 60;
    cameraY = constrain(cameraY, Math.min(minY, maxY), maxY);
}

function mouseWheel(event) {
    // 모바일 레이아웃은 캔버스가 화면 전체를 덮어 overCanvas()가 늘 참 — 열린 정보 뷰
    // 위에서의 휠까지 가로채 패널 스크롤이 죽는다. 실제 이벤트 대상으로 판별한다.
    if (event && event.target && event.target.tagName !== "CANVAS") return true;
    if (!overCanvas()) return true; // 패널 스크롤은 그대로
    cameraY += event.delta;
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

let _metalGrad = null, _metalGradW = 0;
function metalGradient(w) { // translate된 좌표계(-w/2 ~ w/2) 기준 — 모든 블럭이 공유
    if (_metalGradW !== w) {
        const g = drawingContext.createLinearGradient(-w / 2, 0, w / 2, 0);
        g.addColorStop(0.0, "hsl(228, 6%, 11%)");
        g.addColorStop(0.5, "hsl(228, 7%, 30%)"); // 중앙 하이라이트
        g.addColorStop(1.0, "hsl(228, 6%, 11%)");
        _metalGrad = g;
        _metalGradW = w;
    }
    return _metalGrad;
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

function drawMetalBlock(cx, cy) {
    const w = pile.blockW();
    const H = CONFIG.BLOCK_H;
    push();
    translate(cx, cy);
    drawingContext.fillStyle = metalGradient(w);
    stroke(0, 110); // 켜 사이 가는 어두운 경계
    strokeWeight(1);
    rect(-w / 2, -H / 2, w, H, 3);
    drawingContext.fillStyle = bevelGradient(H);
    noStroke();
    rect(-w / 2 + 0.5, -H / 2 + 0.5, w - 1, H - 1, 3);
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

        drawMetalBlock(width / 2, cy);

        // 선택된 블럭: 은은한 앰버 틴트 + 테두리
        if (i === selectedIdx) {
            fill(...CONFIG.COLORS.accent, 34);
            stroke(...CONFIG.COLORS.accent, 200);
            strokeWeight(1.5);
            rect(width / 2 - w / 2 + 1, cy - H / 2 + 1, w - 2, H - 2, 3);
        } else if (i === lastViewedIdx) {
            // 방금 보고 나온 블럭 — 좌측 세로 표식 하나. 테두리를 두르면 선택과 구별이
            // 안 되고 여러 개가 강조된 것처럼 보이므로, 읽던 자리를 가리키는 정도로만.
            noStroke();
            fill(...CONFIG.COLORS.accent, 150);
            rect(width / 2 - w / 2 + 1, cy - H / 2 + 10, 3, H - 20, 1.5);
        }

        const highlight = s.settledAt > 0 && now - s.settledAt < CONFIG.HIGHLIGHT_MS
            ? 1 - (now - s.settledAt) / CONFIG.HIGHLIGHT_MS : 0;
        if ((highlight > 0 || i === hoverIdx) && i !== selectedIdx) {
            noFill();
            if (i === hoverIdx) { stroke(...CONFIG.COLORS.text); strokeWeight(1.2); }
            else { stroke(...CONFIG.COLORS.accent, 90 + 165 * highlight); strokeWeight(1.5); }
            rect(width / 2 - w / 2 + 2, cy - H / 2 + 2, w - 4, H - 4, 4);
        }

        drawBlockLabels(width / 2, cy, v);
    }

    drawPeriodMarkers(lo, hi); // 월/연 경계 요약 (블럭 위에 오버랩)
}

function drawFallingBlock() {
    if (!pile.falling) return;
    const v = victims[pile.falling.victimIdx];
    const p = pile.falling.body.position;
    drawMetalBlock(p.x, p.y);
    drawBlockLabels(p.x, p.y, v);
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

    // 윗줄: 날짜 요일 장소
    fill(...CONFIG.COLORS.text);
    textAlign(LEFT, CENTER);
    textSize(18);
    text(whenWhere, leftX, yTop);

    // 아랫줄: 사인 · 연령 · 이주노동자 — 그래도 넘치면 뒤에서부터 덜어낸다
    if (infoParts.length) {
        textSize(16);
        fill(...CONFIG.COLORS.textDim);
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
        cameraY += dy;
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
    followBtn.addEventListener("click", () => setFollow(true));
    document.getElementById("ack-btn").addEventListener("click", onAckClick);
    document.getElementById("post-ack-btn").addEventListener("click", onAckClick);
    document.getElementById("post-share-btn").addEventListener("click", onShareClick);
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
    // 모바일: 제목을 누르면 정보 뷰(공지/통계/구독)가 열린다 — 구 i 버튼 대체 (2026-08-08).
    // 눌린다는 표시는 모바일 CSS의 밑줄이 담당. 데스크톱은 패널이 항상 펼쳐져 있어 무시.
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
}

// ---- 정보 뷰 — 모바일에서 제목을 누르면 패널 전체(공지/통계/구독)를 펼침 ----

function openInfo() {
    document.body.classList.add("info-open");
    history.pushState({ tfInfo: 1 }, "", "#/about");
}

function hideInfoUI() {
    document.body.classList.remove("info-open");
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

// 모바일 여부는 열리는 시점에 판정 (회전/리사이즈 대응)
function isMobileView() {
    return window.matchMedia("(max-width: 800px)").matches;
}

function showDetail(v) {
    // 공개 데이터는 최소 필드(date/region/accType/age/immigrant/link)만 담는다 —
    // 상세한 내용은 기사 원문 링크로 안내.
    const dec = ageDecadeLabel(v.age);
    const parts = [];
    if (dec) parts.push(dec);
    if (v.immigrant) parts.push("이주노동자");
    parts.push("노동자");
    // 사인이 밝혀지지 않았으면 그냥 비워둔다 — 채우지 않는다 (작가 결정 2026-08-01)
    const title = `${parts.join(" ")}${v.accType ? `, ${v.accType} 사고로` : ""} 사망`;
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
    requestAnimationFrame(() =>
        fitSummary(summaryEl, document.getElementById("post-image"), summary));
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
        try { await navigator.share({ title: "떨어지고, 끼이고, 깔린", text, url }); }
        catch { /* 사용자가 공유 시트를 닫음 */ }
        return;
    }
    const ok = await copyText(url);
    if (ok) flashShareMsg();
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
