// victims_web.json fetch + 신규 diff. 정적 호스팅이라 폴링으로 갱신 감지.

async function loadVictimData() {
    const res = await fetch(`${CONFIG.DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`data fetch failed: ${res.status}`);
    const json = await res.json();
    let list = Array.isArray(json.victims) ? json.victims : [];

    // ?stress=N — 성능 테스트용 데이터 증폭 (식별자인 link만 달리해 복제)
    const stress = parseInt(getParam("stress") || "0", 10);
    if (stress > list.length) {
        const out = [];
        for (let i = 0; i < stress; i++) {
            const src = list[i % list.length];
            out.push({ ...src, link: `${src.link}#s${i}` });
        }
        list = out;
    }
    return list;
}

// 레코드 식별자 = 기사 link (공개 JSON은 최소 필드라 별도 id가 없음)
function victimKey(v) {
    return v.link || `${v.date}|${v.region}|${v.accType}`;
}

// 이미 알고 있는 레코드를 제외한 신규만 (date순 유지)
function diffNewVictims(knownList, nextList) {
    const seen = new Set(knownList.map(victimKey));
    return nextList.filter((v) => !seen.has(victimKey(v)));
}

// ---- 재방문 메시지 (localStorage) ----
const LAST_SEEN_KEY = "tf:lastSeenKey";

function checkRevisit(list) {
    if (!list.length) return null;
    const lastSeen = localStorage.getItem(LAST_SEEN_KEY);
    let sinceCount = null;
    if (lastSeen) {
        const idx = list.findIndex((v) => victimKey(v) === lastSeen);
        if (idx >= 0 && idx < list.length - 1) sinceCount = list.length - 1 - idx;
    }
    localStorage.setItem(LAST_SEEN_KEY, victimKey(list[list.length - 1]));
    return sinceCount;
}

function markLatestSeen(list) {
    if (list.length) localStorage.setItem(LAST_SEEN_KEY, victimKey(list[list.length - 1]));
}

// ---- 표시용 헬퍼 ----
function formatKoreanDate(dateStr) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr || "");
    if (!m) return dateStr || "날짜 미상";
    return `${m[1]}년 ${parseInt(m[2], 10)}월 ${parseInt(m[3], 10)}일`;
}

function ageDecadeLabel(age) {
    if (typeof age !== "number" || !isFinite(age)) return "";
    if (age < 20) return "10대";
    return `${Math.floor(age / 10) * 10}대`;
}

// 블럭/상세에 쓸 지역 문자열 (공개 JSON에는 region만 존재 — 주소 원문 비공개)
function displayRegion(v) {
    return v.region || "";
}
