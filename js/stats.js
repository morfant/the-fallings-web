// 누적 통계 집계 + DOM 렌더. settledCount 기준(착지한 만큼만 집계 — 카운터가 낙하와 함께 오름).

function aggregateStats(victims, uptoCount) {
    const list = victims.slice(0, uptoCount);
    const now = new Date();
    const thisYear = String(now.getFullYear());
    const thisMonth = `${thisYear}-${String(now.getMonth() + 1).padStart(2, "0")}`;

    const agg = {
        total: list.length,
        thisYear: 0,
        thisMonth: 0,
        daysSinceLast: null,
        byType: new Map(),
        byDecade: new Map(),
        byRegion: new Map(), // 시도 단위
        monthly: new Map(), // "YYYY-MM" -> count
        immigrant: 0,
    };

    let lastDate = null;
    for (const v of list) {
        const d = String(v.date || "");
        if (d.startsWith(thisYear)) agg.thisYear++;
        if (d.startsWith(thisMonth)) agg.thisMonth++;
        if (!lastDate || d > lastDate) lastDate = d;

        const type = (v.accType || "").trim() || "확인 안 됨";
        agg.byType.set(type, (agg.byType.get(type) || 0) + 1);

        const dec = ageDecadeLabel(v.age) || "미상";
        agg.byDecade.set(dec, (agg.byDecade.get(dec) || 0) + 1);

        const sido = sidoLabel(v.region);
        agg.byRegion.set(sido, (agg.byRegion.get(sido) || 0) + 1);

        const ym = d.slice(0, 7);
        if (ym) agg.monthly.set(ym, (agg.monthly.get(ym) || 0) + 1);

        if (v.immigrant) agg.immigrant++;
    }

    if (lastDate) {
        const ms = now - new Date(lastDate + "T00:00:00");
        agg.daysSinceLast = Math.max(0, Math.floor(ms / 86400000));
        agg.lastDate = lastDate;
    }

    // 수집된 산재 사망의 평균 속도: 사망자 수 ÷ 수집 기간 → "N.N명 / 1일" (하루 고정)
    // 체계적 수집 시작(COLLECTION_SINCE) 이후만 센다 — 그 이전 사망은 판결·성명 기사로
    // 뒤늦게 발견된 것들이라 전수가 아니고, 포함하면 기간만 늘어나 속도가 실제보다 낮게 나온다.
    const since = CONFIG.COLLECTION_SINCE;
    const inWindow = since ? list.filter((v) => v.date && v.date >= since) : list;
    if (inWindow.length >= 2) {
        const dates = inWindow.map((v) => v.date).sort();
        const spanDays =
            (new Date(dates[dates.length - 1] + "T00:00:00") - new Date(dates[0] + "T00:00:00")) / 86400000;
        if (spanDays > 0) agg.deathsPerDay = inWindow.length / spanDays;
    }
    return agg;
}

// region의 첫 토큰을 시도 표준 약칭으로 정규화 — 데이터에 "경기도/경기", "서울특별시/서울",
// "강원도/강원특별자치도" 같은 표기가 혼재해 그대로 세면 같은 시도가 쪼개진다.
// 첫 토큰이 시도인 것은 추출 규칙(시도+시군구)의 전제 — displayRegion도 같은 가정을 쓴다.
function sidoLabel(region) {
    const t = String(region || "").trim().split(/\s+/)[0];
    if (!t) return "미상";
    const map = [
        ["서울", "서울"], ["부산", "부산"], ["대구", "대구"], ["인천", "인천"],
        ["광주", "광주"], ["대전", "대전"], ["울산", "울산"], ["세종", "세종"],
        ["경기", "경기"], ["강원", "강원"], ["제주", "제주"],
        ["충청북", "충북"], ["충북", "충북"], ["충청남", "충남"], ["충남", "충남"],
        ["전라북", "전북"], ["전북", "전북"], ["전라남", "전남"], ["전남", "전남"],
        ["경상북", "경북"], ["경북", "경북"], ["경상남", "경남"], ["경남", "경남"],
    ];
    for (const [prefix, label] of map) if (t.startsWith(prefix)) return label;
    return "미상";
}

// 애도 표식은 추모 꽃(flower.js — 설치 버전 FloralArc 이식)으로 통일 (2026-08-08, 구 추모 리본 SVG)

function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function barRows(map, { unknownKey = null, max = 8 } = {}) {
    const entries = [...map.entries()].sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, max);
    const maxV = Math.max(1, ...top.map(([, c]) => c));
    return top.map(([label, count]) => {
        const w = Math.round((count / maxV) * 100);
        const cls = label === unknownKey ? "bar-row unknown" : "bar-row";
        return `<div class="${cls}">
            <span class="bar-label">${esc(label)}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${w}%"></span></span>
            <span class="bar-count">${count}</span>
        </div>`;
    }).join("");
}

function monthChart(monthly) {
    // 최근 12개월 — 세로축(0/중간/최대) + 가로 그리드
    const now = new Date();
    const cols = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        cols.push({ ym, label: `${d.getMonth() + 1}`, count: monthly.get(ym) || 0 });
    }
    const maxV = Math.max(1, ...cols.map((c) => c.count));
    const niceMax = Math.max(5, Math.ceil(maxV / 5) * 5); // 5 단위로 올림 → 눈금이 깔끔
    return `<div class="month-wrap">
        <div class="month-axis"><span>${niceMax}</span><span>${niceMax / 2}</span><span>0</span></div>
        <div class="month-main">
            <div class="month-plot">
                <div class="m-grid" style="top:0"></div>
                <div class="m-grid" style="top:50%"></div>
                <div class="m-grid" style="bottom:0"></div>
                ${cols.map((c) => `<div class="m-bar" style="height:${(c.count / niceMax) * 100}%"
                    title="${c.ym}: ${c.count}명"></div>`).join("")}
            </div>
            <div class="month-labels">${cols.map((c) => `<span>${c.label}월</span>`).join("")}</div>
        </div>
    </div>`;
}

// 그래프 섹션 접힘 상태 — renderStats가 innerHTML을 새로 그려도 유지 (기본 접힘)
let _chartsOpen = false;

function renderStats(victims, uptoCount) {
    const el = document.getElementById("stats-content");
    if (!el) return;
    const a = aggregateStats(victims, uptoCount);

    // 전체 애도 수 — 라벨 없이 추모 꽃 + 숫자만.
    // 카운터 테이블 전체를 더하지 않고 **지금 화면에 있는 기록의 것만** 센다.
    // 감사에서 잘못된 기록을 지운 적이 있어(2026-07-31) 사라진 id의 카운트가 테이블에
    // 남아 있고, 그걸 합치면 있지도 않은 죽음에 대한 애도가 숫자에 섞인다.
    let totalAcks = 0;
    if (typeof _acks === "object") {
        for (const v of victims) {
            if (v._ackId) totalAcks += _acks[v._ackId] | 0;
        }
    }
    const acksHtml = `
        <div class="stat-cell">
            <div class="num ack-num">${flowerImgHTML(FLOWER_TOTAL_SEED, 25)} ${totalAcks}</div>
        </div>`;

    el.innerHTML = `
        <div class="stat-big">
            <span class="num">${a.total}</span>
            <span class="label">명 사망 (${esc(CONFIG.COUNT_SINCE_LABEL)})</span>
        </div>
        <div class="stat-row">
            <div class="stat-cell"><div class="num">${a.thisYear}</div><div class="label">올해</div></div>
            <div class="stat-cell"><div class="num">${a.thisMonth}</div><div class="label">이번 달</div></div>
            ${acksHtml}
        </div>
        ${a.deathsPerDay ? `<div class="stat-speed">
            <div class="speed-value">${a.deathsPerDay.toFixed(1)}명<span class="per">/</span>1일</div>
            <div class="label">산재 사망의 평균 속도 (수집된 데이터 기준)</div>
        </div>` : ""}
        <button id="charts-toggle" aria-expanded="${_chartsOpen}">통계</button>
        <div class="stat-section">
            <h3>사고 유형</h3>
            ${barRows(a.byType, { unknownKey: "확인 안 됨" })}
        </div>
        <div class="stat-section">
            <h3>연령대</h3>
            ${barRows(a.byDecade, { unknownKey: "미상" })}
        </div>
        <div class="stat-section">
            <h3>지역</h3>
            ${barRows(a.byRegion, { unknownKey: "미상", max: 18 })}
        </div>
        <div class="stat-section wide">
            <h3>최근 12개월</h3>
            ${monthChart(a.monthly)}
        </div>
    `;

    // '통계'를 누르면 그래프 섹션이 펼쳐진다 (작가 요청 2026-08-16) —
    // 접힘/펼침은 CSS(.charts-open)가 담당, 상태는 _chartsOpen이 재렌더를 넘어 유지.
    el.classList.toggle("charts-open", _chartsOpen);
    const toggle = document.getElementById("charts-toggle");
    toggle.addEventListener("click", () => {
        _chartsOpen = !_chartsOpen;
        el.classList.toggle("charts-open", _chartsOpen);
        toggle.setAttribute("aria-expanded", String(_chartsOpen));
    });
}
