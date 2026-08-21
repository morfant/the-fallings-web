// rs.js — 돌에 새기는 기록의 오류정정 여벌 (리드-솔로몬, GF(256)).
//
// 왜: 실물 스크린샷 판독은 칸을 거의 다 맞히지만(2026-08-21 실측 2,104칸 중 4칸 오독,
// 99.81%) **한 바이트가 틀리면 UTF-8 경계가 밀려 그 뒤가 다 어긋난다**. 실제로 526바이트
// 중 4바이트 오독이 뒤 23바이트를 한 글자씩 시프트시켜 글자 정확도가 94.8%로 떨어졌다.
// 필요한 것은 판독기 개선이 아니라 여벌이다 — 칸→바이트 대응이 자리로 고정돼 있어
// 오류가 항상 '치환'이고 삽입·삭제가 없으므로, 리드-솔로몬이 그대로 잘 듣는다.
//
// 작가 결정 (2026-08-18): 지터는 **남긴다**(의미는 방향으로 양자화돼 있어 흔들려도 값이
// 불변 — 지터 제거와 오류정정은 다른 축이고, 여벌은 오히려 지터를 지키는 방법이다).
// 여벌은 **꼬리에 붙인다** — 본문 사이에 섞으면 되짚기가 어려워져 "필요한 사람은
// 스스로 알아낸다"는 원칙을 우리 손으로 막는 셈이 된다.
//
// 새김 형식 (v1):
//   [머리말 5바이트 × 3벌][본문 len바이트][여벌 nsym × 블록수][pid 시드 채움]
//   머리말 = [ver=1, lenHi, lenLo, nsym, k8]  (k8 = 블록 데이터 길이 / 8)
//   머리말은 세 벌을 새기고 판독 시 바이트별 다수결 — 머리말이 깨지면 나머지를 읽는
//   방법 자체를 잃으므로, 짧고 확실한 삼중화가 리드-솔로몬보다 낫다.
// 본문은 앞에서부터 K바이트씩 나눠 블록마다 여벌을 만들고, 여벌들은 본문이 다 끝난 뒤
// 블록 순서대로 잇는다(꼬리 규칙). 블록당 nsym/2 바이트까지 정정된다.

const RS_VER = 1;
const RS_K = 160;        // 블록 데이터 길이
const RS_NSYM = 32;      // 블록당 여벌 — 16바이트 오류 정정
const RS_NSYM_STEPS = [32, 24, 16, 8]; // 용량이 모자라면 이 순서로 낮춘다
const RS_HEAD = 5;       // 머리말 1벌 길이
const RS_HEAD_COPIES = 3;

const _gfExp = new Uint8Array(512);
const _gfLog = new Uint8Array(256);
(function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
        _gfExp[i] = x;
        _gfLog[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d; // 원시 다항식 (QR과 동일)
    }
    for (let i = 255; i < 512; i++) _gfExp[i] = _gfExp[i - 255];
})();
function _gmul(a, b) {
    if (a === 0 || b === 0) return 0;
    return _gfExp[_gfLog[a] + _gfLog[b]];
}
function _polyMul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let i = 0; i < p.length; i++)
        for (let j = 0; j < q.length; j++) r[i + j] ^= _gmul(p[i], q[j]);
    return r;
}
const _genCache = new Map();
function rsGenPoly(nsym) {
    let g = _genCache.get(nsym);
    if (g) return g;
    g = [1];
    for (let i = 0; i < nsym; i++) g = _polyMul(g, [1, _gfExp[i]]);
    _genCache.set(nsym, g);
    return g;
}
// 한 블록의 여벌 (조직적 부호 — 본문은 그대로 두고 나머지만 돌려준다)
function rsParity(data, nsym) {
    const gen = rsGenPoly(nsym);
    const buf = new Uint8Array(data.length + nsym);
    buf.set(data);
    for (let i = 0; i < data.length; i++) {
        const coef = buf[i];
        if (coef) for (let j = 1; j < gen.length; j++) buf[i + j] ^= _gmul(gen[j], coef);
    }
    return buf.slice(data.length);
}

// 용량(capBytes) 안에 들어가는 가장 큰 여벌을 고른다. 하나도 못 넣으면 nsym=0 —
// 그때도 머리말은 새겨서 판독기가 "여벌 없음"을 알 수 있게 한다.
function rsPickNsym(len, capBytes, k = RS_K) {
    const head = RS_HEAD * RS_HEAD_COPIES;
    for (const nsym of RS_NSYM_STEPS) {
        if (head + len + nsym * Math.ceil(len / k) <= capBytes) return nsym;
    }
    return 0;
}

// 기록 바이트열 → 새길 바이트열 (머리말 + 본문 + 여벌). capBytes는 격자 용량.
function rsFrame(payload, capBytes, k = RS_K) {
    const len = payload.length;
    const nsym = rsPickNsym(len, capBytes, k);
    const head = [RS_VER, (len >> 8) & 0xff, len & 0xff, nsym, k / 8];
    const out = [];
    for (let c = 0; c < RS_HEAD_COPIES; c++) out.push(...head);
    out.push(...payload);
    if (nsym > 0) {
        for (let off = 0; off < len; off += k) {
            out.push(...rsParity(payload.subarray(off, Math.min(off + k, len)), nsym));
        }
    }
    return new Uint8Array(out);
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { rsFrame, rsParity, rsGenPoly, rsPickNsym, _gfExp, _gfLog, _gmul,
        RS_VER, RS_K, RS_NSYM, RS_HEAD, RS_HEAD_COPIES };
}
