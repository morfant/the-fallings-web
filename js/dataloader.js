// victims_web.json fetch + 신규 diff. 정적 호스팅이라 폴링으로 갱신 감지.

async function loadVictimData() {
    const res = await fetch(`${CONFIG.DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`data fetch failed: ${res.status}`);
    const json = await res.json();
    let list = Array.isArray(json.victims) ? json.victims : [];

    // ?stress=N — 성능 테스트용 데이터 증폭 (id만 달리해 복제)
    const stress = parseInt(getParam("stress") || "0", 10);
    if (stress > list.length) {
        const out = [];
        for (let i = 0; i < stress; i++) {
            const src = list[i % list.length];
            out.push({ ...src, id: `${src.id}#s${i}` });
        }
        list = out;
    }
    return list;
}

// 이미 알고 있는 id를 제외한 신규 레코드만 (date순 유지)
function diffNewVictims(knownList, nextList) {
    const seen = new Set(knownList.map((v) => v.id));
    return nextList.filter((v) => !seen.has(v.id));
}

// ---- 재방문 메시지 (localStorage) ----
const LAST_SEEN_KEY = "tf:lastSeenId";

function checkRevisit(list) {
    if (!list.length) return null;
    const lastSeenId = localStorage.getItem(LAST_SEEN_KEY);
    let sinceCount = null;
    if (lastSeenId) {
        const idx = list.findIndex((v) => v.id === lastSeenId);
        if (idx >= 0 && idx < list.length - 1) sinceCount = list.length - 1 - idx;
    }
    localStorage.setItem(LAST_SEEN_KEY, list[list.length - 1].id);
    return sinceCount;
}

function markLatestSeen(list) {
    if (list.length) localStorage.setItem(LAST_SEEN_KEY, list[list.length - 1].id);
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

// 블럭/상세에 쓸 지역 문자열 — region이 없으면 address에서 방어적으로 자름
function displayRegion(v) {
    if (v.region) return v.region;
    const addr = String(v.address || "").trim();
    if (!addr) return "";
    // 정제 전 데이터 방어: 한글 행정단위 토큰만 인정
    const tok = addr.split(/\s+/)[0];
    if (/^[가-힣]{1,4}(특별시|광역시|도|시|군|구)$/.test(tok) && !/^(또다시|다시)/.test(tok)) {
        return tok;
    }
    return "";
}
