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
    loadAcks().then(() => renderStats(victims, pile.settled.length));
    computeAckIds(victims); // 블럭 위 ♥N 표시용 id 사전 계산

    renderStats(victims, pile.settled.length);
    appState = "replay";
    startPolling();
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
    }

    Matter.Engine.update(engine, 1000 / 60);

    const landedIdx = pile.update(now);
    if (landedIdx !== null) {
        lastLandAt = now;
        renderStats(victims, pile.settled.length);
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

function drawSettledBlocks(now) {
    const [lo, hi] = pile.visibleRange(cameraY, height);
    const w = pile.blockW();
    const H = CONFIG.BLOCK_H;

    for (let i = lo; i <= hi; i++) {
        const s = pile.settled[i];
        if (!s) continue;
        const v = victims[s.victimIdx];
        const cy = pile.yOfCenter(i);

        drawMetalBlock(width / 2, cy);

        // 선택된 블럭: 은은한 앰버 틴트 + 테두리
        if (i === selectedIdx) {
            fill(...CONFIG.COLORS.accent, 34);
            stroke(...CONFIG.COLORS.accent, 200);
            strokeWeight(1.5);
            rect(width / 2 - w / 2 + 1, cy - H / 2 + 1, w - 2, H - 2, 3);
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

    noStroke();
    textSize(18);
    const region = displayRegion(v);
    const dow = dayOfWeek(v.date);
    const dateLabel = dow ? `${v.date} ${dow}` : `${v.date}`;
    const leftLabel = region ? `${dateLabel}   ${region}` : dateLabel;
    const rightParts = [];
    if (v.accType) rightParts.push(v.accType);
    const dec = ageDecadeLabel(v.age);
    if (dec) rightParts.push(dec);
    if (v.immigrant) rightParts.push("이주노동자");
    const rightLabel = rightParts.join(" · ");

    fill(...CONFIG.COLORS.text);
    textAlign(LEFT, CENTER);
    text(leftLabel, cx - w / 2 + 18, cy);

    // 우측: [유형 · 연령 · 이주노동자]  ♥N (애도 수 — 흰색 하트 글리프)
    textSize(16);
    let rightX = cx + w / 2 - 18;
    const n = v._ackId ? (_acks[v._ackId] || 0) : 0;
    textAlign(RIGHT, CENTER);
    if (n > 0) {
        fill(...CONFIG.COLORS.text);
        const heart = `♥ ${n}`;
        text(heart, rightX, cy);
        rightX -= textWidth(heart) + 16;
    }
    if (rightLabel) {
        fill(...CONFIG.COLORS.text);
        textSize(18);
        const leftEnd = cx - w / 2 + 18 + textWidth(leftLabel);
        textSize(16);
        if (rightX - textWidth(rightLabel) > leftEnd + 24) {
            text(rightLabel, rightX, cy);
        }
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

function mouseMoved() {
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
    if (s) { selectedIdx = idx; showDetail(victims[s.victimIdx]); }
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

    const overlay = document.getElementById("detail-overlay");
    document.getElementById("detail-close").addEventListener("click", hideDetail);
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
            if (s) { selectedIdx = idx; showDetail(victims[s.victimIdx]); return; }
        }
        hideDetail();
    });
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") hideDetail();
    });
}

function showDetail(v) {
    // 공개 데이터는 최소 필드(date/region/accType/age/immigrant/link)만 담는다 —
    // 상세한 내용은 기사 원문 링크로 안내.
    const dec = ageDecadeLabel(v.age);
    const parts = [];
    if (dec) parts.push(dec);
    if (v.immigrant) parts.push("이주노동자");
    parts.push("노동자");
    const title = `${parts.join(" ")}${v.accType ? `, ${v.accType} 사고로` : ""} 사망`;

    document.getElementById("detail-date").textContent = formatKoreanDate(v.date);
    document.getElementById("detail-title").textContent = title;
    document.getElementById("detail-meta").textContent = displayRegion(v);
    const summaryEl = document.getElementById("detail-summary");
    summaryEl.textContent = v.accSummary || "자세한 내용은 기사 원문에서 확인할 수 있습니다.";
    const link = document.getElementById("detail-link");
    const realLink = String(v.link || "").split("#s")[0]; // stress 테스트 접미사 제거
    if (realLink) {
        link.href = realLink;
        link.hidden = false;
    } else {
        link.hidden = true;
        summaryEl.textContent = "";
    }

    detailLink = realLink || null;
    document.getElementById("detail-ack").hidden = !detailLink;
    if (detailLink) updateAckRow(detailLink);

    document.getElementById("detail-overlay").hidden = false;
}

// ---- "들었습니다" ----
let detailLink = null;

async function updateAckRow(link) {
    const id = await ackId(link);
    if (link !== detailLink) return; // 그 사이 다른 카드가 열렸으면 무시
    const n = _acks[id] || 0;
    document.getElementById("ack-count").textContent =
        n > 0 ? `이 죽음을 ${n}명이 들었습니다` : "이 소식을 들었다면, 눌러주세요";
    const btn = document.getElementById("ack-btn");
    btn.disabled = hasAcked(id);
    btn.textContent = hasAcked(id) ? "🖤 들었습니다 ✓" : "🖤 들었습니다";
}

async function onAckClick() {
    if (!detailLink) return;
    const id = await ackId(detailLink);
    if (hasAcked(id)) return;
    const btn = document.getElementById("ack-btn");
    btn.disabled = true;
    try {
        const count = await sendAck(detailLink);
        markAcked(id);
        document.getElementById("ack-count").textContent = `이 죽음을 ${count}명이 들었습니다`;
        btn.textContent = "🖤 들었습니다 ✓";
        renderStats(victims, pile.settled.length); // '기록된 애도' 즉시 반영
    } catch {
        btn.disabled = false; // 실패 시 다시 시도 가능
    }
}

function hideDetail() {
    selectedIdx = -1;
    document.getElementById("detail-overlay").hidden = true;
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
    setInterval(async () => {
        if (appState !== "live") return;
        loadAcks().then(() => renderStats(victims, pile.settled.length)); // 애도 카운터·통계 주기 갱신
        try {
            const next = await loadVictimData();
            const fresh = diffNewVictims(victims, next);
            if (fresh.length > 0) {
                for (const v of fresh) {
                    victims.push(v);
                    spawnQueue.push(victims.length - 1);
                }
                markLatestSeen(victims);
            }
        } catch (e) {
            console.warn("poll failed:", e);
        }
    }, ms);
}
