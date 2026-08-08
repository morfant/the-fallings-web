// 추모 꽃 — 설치 버전(class/FloralArc.js, 루트 sketch.js createFallingArc)의 형태를 이식.
// 반투명 부채꼴 수백 개를 겹쳐 국화 다발 같은 형체를 만든다. 추모 리본을 대신하는 표식
// (2026-08-08 작가 결정 — 블럭 위에는 붙이지 않고 통계 패널·상세 뷰 확인 버튼에만).
//
// 시드가 pid이므로 **한 사람에게는 언제나 같은 꽃**이 핀다 — 새로고침해도, 누가 봐도
// 그 사람의 꽃은 그 모양. 렌더는 pid당 1회(오프스크린 캔버스 → data URL 캐시).

const FLOWER_TOTAL_SEED = "떨어지고, 끼이고, 깔린"; // 통계 패널의 애도 총합 옆 — 특정인이 아닌 공용 꽃

// FNV-1a 32비트 — 문자열 시드를 정수로
function _flowerHash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

// mulberry32 — 결정론적 PRNG
function _mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const _flowerCache = new Map(); // "seed:size" -> dataURL

// 파라미터는 설치 버전 createFallingArc 기반:
//   기준 반지름 45–50, 아크 지름 1.1r–1.8r, 호 길이 0–PI/8.
//   꽃잎 수는 원본(200–600)의 절반인 100–300 — 25px로 줄이면서 결이 뭉개지지 않게 (2026-08-08).
//   색은 흰색, 낮은 알파 — 어두운 배경 위에서 겹칠수록 중심이 밝아지는 질감
//   (원본은 청록/알파 30이었지만 다크 테마에서 검정·청록 모두 묻혀서 흰색으로 — 작가 선택 2026-08-08).
function flowerDataURL(seedStr, sizePx) {
    const key = `${seedStr}:${sizePx}`;
    let url = _flowerCache.get(key);
    if (url) return url;

    const rand = _mulberry32(_flowerHash(String(seedStr)));
    const r0 = 45 + rand() * 5;
    const petals = 100 + Math.floor(rand() * 200);
    const maxD = r0 * 1.8; // 가장 큰 아크 지름 = 꽃 전체 지름

    const scale = 2; // 고해상도 화면 대비 2배 렌더
    const c = document.createElement("canvas");
    c.width = c.height = sizePx * scale;
    const ctx = c.getContext("2d");
    ctx.translate(c.width / 2, c.height / 2);
    const k = (sizePx * scale) / maxD;
    ctx.fillStyle = "rgba(255, 255, 255, 0.10)";
    for (let i = 0; i < petals; i++) {
        const d = (r0 * 1.1 + rand() * r0 * 0.7) * k;
        const a0 = rand() * Math.PI * 2;
        const a1 = a0 + rand() * (Math.PI / 8);
        // p5의 arc() 기본 채우기(중심까지 닫히는 부채꼴)를 재현
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, d / 2, a0, a1);
        ctx.closePath();
        ctx.fill();
    }
    url = c.toDataURL("image/png");
    _flowerCache.set(key, url);
    return url;
}

// DOM용 <img> 태그 문자열 (innerHTML에 끼워 넣는 용도)
function flowerImgHTML(seedStr, sizePx = 25) {
    return `<img class="flower-ic" src="${flowerDataURL(seedStr, sizePx)}" ` +
        `width="${sizePx}" height="${sizePx}" alt="추모 꽃">`;
}
