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

// ---- "들었습니다" 카운터 ----
// id = 기사 link의 SHA-256 앞 16자리(hex). 발송 스크립트(node)와 동일 규칙.

// crypto.subtle은 보안 컨텍스트(HTTPS/localhost) 전용 — LAN IP 등 http 접속에서는
// 순수 JS SHA-256으로 대체한다. id 규칙이 서버와 같아야 하므로 해시 자체를 구현.
function sha256HexSync(str) {
    const rr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bytes = new TextEncoder().encode(str);
    const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const dv0 = new DataView(padded.buffer);
    dv0.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 4294967296));
    dv0.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
    const w = new Array(64);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv0.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        const out = [a, b, c, d, e, f, g, hh];
        h = h.map((x, i) => (x + out[i]) >>> 0);
    }
    return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

const _ackIdCache = new Map();
async function ackId(link) {
    const clean = String(link || "").split("#s")[0];
    let id = _ackIdCache.get(clean);
    if (!id) {
        if (crypto.subtle) {
            const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clean));
            id = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
        } else {
            id = sha256HexSync(clean).slice(0, 16);
        }
        _ackIdCache.set(clean, id);
    }
    return id;
}

// 블럭 위 ♥N 표시용 — 각 레코드에 카운터 id를 붙임.
// 데이터가 사람 단위가 된 뒤로는 서버가 pid를 내려준다 (한 기사가 여러 사람일 수 있어
// 링크만으로는 사람을 구분할 수 없다). pid가 없는 옛 데이터는 링크 해시로 폴백.
async function computeAckIds(list) {
    for (const v of list) {
        if (v._ackId) continue;
        if (v.pid) v._ackId = v.pid;
        else if (v.link) v._ackId = await ackId(v.link);
    }
}

let _acks = {};
async function loadAcks() {
    try {
        const res = await fetch(`${CONFIG.ACK_URL}/acks`);
        if (res.ok) _acks = await res.json();
    } catch { /* 카운터 서버 불통은 치명적이지 않음 */ }
    return _acks;
}

async function sendAck(id) {
    const res = await fetch(`${CONFIG.ACK_URL}/ack/${id}`, { method: "POST" });
    if (!res.ok) throw new Error(`ack ${res.status}`);
    const data = await res.json();
    _acks[id] = data.count;
    return data.count;
}

function hasAcked(id) {
    return localStorage.getItem(`tf:acked:${id}`) === "1";
}
function markAcked(id) {
    localStorage.setItem(`tf:acked:${id}`, "1");
}
