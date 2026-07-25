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

    loadAcks(); // "들었습니다" 카운터 (실패해도 무해)
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

// ---- 블럭 렌더링: 채움 없는 와이어프레임 ----
// 개별 블럭에는 채움/외곽선이 없고, "같은 날짜"의 연속 블럭들이 하나의 외곽선으로
// 묶인다. 그룹 안의 블럭 사이에는 옅은 구분선만. 요일 구분은 외곽선 밝기로 (모노톤 유지).

const _DOW_STROKE_L = [78, 34, 41, 48, 55, 62, 70]; // index = getDay() (0=일, 1=월 ... 6=토)
const _strokeColorCache = new Map();
function dateStroke(dateStr) {
    let c = _strokeColorCache.get(dateStr);
    if (!c) {
        const t = new Date(`${dateStr}T00:00:00`);
        const l = isNaN(t) ? 45 : _DOW_STROKE_L[t.getDay()];
        c = color(`hsl(228, 8%, ${l}%)`);
        _strokeColorCache.set(dateStr, c);
    }
    return c;
}

function dateOfSettled(i) {
    const s = pile.settled[i];
    return s ? victims[s.victimIdx].date : null;
}

function drawSettledBlocks(now) {
    const [lo, hi] = pile.visibleRange(cameraY, height);
    const w = pile.blockW();
    const H = CONFIG.BLOCK_H;

    // 1) 개별 블럭: 라벨 + 그룹 내부 구분선 + 하이라이트/호버
    for (let i = lo; i <= hi; i++) {
        const s = pile.settled[i];
        if (!s) continue;
        const v = victims[s.victimIdx];
        const cy = pile.yOfCenter(i);

        // 같은 날짜 그룹 내부 구분선 (아래 블럭과 날짜가 같으면 경계에 옅은 선)
        if (i > 0 && dateOfSettled(i - 1) === v.date) {
            stroke(255, 22);
            strokeWeight(1);
            line(width / 2 - w / 2 + 10, cy + H / 2, width / 2 + w / 2 - 10, cy + H / 2);
        }

        const highlight = s.settledAt > 0 && now - s.settledAt < CONFIG.HIGHLIGHT_MS
            ? 1 - (now - s.settledAt) / CONFIG.HIGHLIGHT_MS : 0;
        if (highlight > 0 || i === hoverIdx) {
            noFill();
            if (i === hoverIdx) { stroke(...CONFIG.COLORS.text); strokeWeight(1.2); }
            else { stroke(...CONFIG.COLORS.accent, 90 + 165 * highlight); strokeWeight(1.5); }
            rect(width / 2 - w / 2 + 2, cy - H / 2 + 2, w - 4, H - 4, 4);
        }

        drawBlockLabels(width / 2, cy, v);
    }

    // 2) 날짜 그룹 외곽선 — 그룹 시작점을 화면 밖까지 거슬러 찾은 뒤 그룹 단위로 그림
    let i = Math.max(0, lo);
    while (i > 0 && dateOfSettled(i - 1) === dateOfSettled(i)) i--;
    while (i < pile.settled.length && i <= hi) {
        let j = i;
        while (j + 1 < pile.settled.length && dateOfSettled(j + 1) === dateOfSettled(j)) j++;
        const top = pile.yOfCenter(j) - H / 2 + 1.5;
        const bottom = pile.yOfCenter(i) + H / 2 - 1.5;
        noFill();
        stroke(dateStroke(dateOfSettled(i)));
        strokeWeight(1);
        rect(width / 2 - w / 2, top, w, bottom - top, 5);
        i = j + 1;
    }
}

function drawFallingBlock() {
    if (!pile.falling) return;
    const v = victims[pile.falling.victimIdx];
    const p = pile.falling.body.position;
    const w = pile.blockW();
    const H = CONFIG.BLOCK_H;
    push();
    translate(p.x, p.y);
    if (pile.falling.body.angle) rotate(pile.falling.body.angle);
    noFill();
    stroke(dateStroke(v.date));
    strokeWeight(1.2);
    rect(-w / 2, -H / 2, w, H, 5);
    pop();
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
    textSize(15);
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

    // 우측: [유형 · 연령 · 이주노동자]  🖤N (애도 수)
    textSize(13.5);
    let rightX = cx + w / 2 - 18;
    const n = v._ackId ? (_acks[v._ackId] || 0) : 0;
    textAlign(RIGHT, CENTER);
    if (n > 0) {
        fill(...CONFIG.COLORS.textDim);
        const heart = `🖤 ${n}`;
        text(heart, rightX, cy);
        rightX -= textWidth(heart) + 16;
    }
    if (rightLabel) {
        fill(...CONFIG.COLORS.textDim);
        textSize(15);
        const leftEnd = cx - w / 2 + 18 + textWidth(leftLabel);
        textSize(13.5);
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
    if (s) showDetail(victims[s.victimIdx]);
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
        if (e.target === overlay) hideDetail();
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
    } catch {
        btn.disabled = false; // 실패 시 다시 시도 가능
    }
}

function hideDetail() {
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
        loadAcks(); // 애도 카운터도 주기 갱신
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
