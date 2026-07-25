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
    if (list.length >= 2) {
        const dates = list.map((v) => v.date).filter(Boolean).sort();
        const spanDays =
            (new Date(dates[dates.length - 1] + "T00:00:00") - new Date(dates[0] + "T00:00:00")) / 86400000;
        if (spanDays > 0) agg.deathsPerDay = list.length / spanDays;
    }
    return agg;
}

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
    // 최근 12개월
    const now = new Date();
    const cols = [];
    for (let i = 11; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        cols.push({ ym, label: `${d.getMonth() + 1}`, count: monthly.get(ym) || 0 });
    }
    const maxV = Math.max(1, ...cols.map((c) => c.count));
    return `<div class="month-chart">` + cols.map((c) => `
        <div class="m-col">
            <div class="m-bar" style="height:${Math.round((c.count / maxV) * 100)}%"
                 title="${c.ym}: ${c.count}명"></div>
            <div class="m-label">${c.label}</div>
        </div>`).join("") + `</div>`;
}

function renderStats(victims, uptoCount) {
    const el = document.getElementById("stats-content");
    if (!el) return;
    const a = aggregateStats(victims, uptoCount);

    const daysHtml = a.daysSinceLast === null ? "" : `
        <div class="stat-cell">
            <div class="num">${a.daysSinceLast}일</div>
            <div class="label">마지막 사망으로부터 (${esc(formatKoreanDate(a.lastDate))})</div>
        </div>`;

    el.innerHTML = `
        <div class="stat-big">
            <span class="num">${a.total}</span>
            <span class="label">명 사망<br>${esc(CONFIG.COUNT_SINCE_LABEL)}</span>
        </div>
        <div class="stat-row">
            <div class="stat-cell"><div class="num">${a.thisYear}</div><div class="label">올해</div></div>
            <div class="stat-cell"><div class="num">${a.thisMonth}</div><div class="label">이번 달</div></div>
            ${daysHtml}
        </div>
        ${a.deathsPerDay ? `<div class="stat-speed">
            <div class="speed-value">${a.deathsPerDay.toFixed(1)}명<span class="per">/</span>1일</div>
            <div class="label">수집된 산재 사망의 평균 속도</div>
        </div>` : ""}
        <div class="stat-section">
            <h3>사고 유형</h3>
            ${barRows(a.byType, { unknownKey: "확인 안 됨" })}
        </div>
        <div class="stat-section">
            <h3>연령대</h3>
            ${barRows(a.byDecade, { unknownKey: "미상" })}
        </div>
        <div class="stat-section wide">
            <h3>최근 12개월</h3>
            ${monthChart(a.monthly)}
        </div>
        ${a.immigrant > 0 ? `<div class="stat-section wide">
            <h3>이주노동자</h3>
            <div class="bar-row"><span class="bar-label">확인된 수</span>
            <span class="bar-track"><span class="bar-fill" style="width:${Math.round((a.immigrant / Math.max(1, a.total)) * 100)}%"></span></span>
            <span class="bar-count">${a.immigrant}</span></div>
        </div>` : ""}
    `;
}
