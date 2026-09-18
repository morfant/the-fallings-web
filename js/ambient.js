// 앰비언트 — 돌 소리를 기록 순서의 역방향으로 이어 연주한다 (작가 결정 2026-09-18).
//
// 왜: 라이브 낙하는 하루 1건 미만이라, 열어 둔 페이지에는 소리가 거의 없었다. 이제 페이지가
// 열려 있는 동안 **가장 최근 사람부터 그 전, 그 전으로** 돌 소리가 이어진다 — 지층을 위에서
// 아래로 읽어 내려가는 것. 가장 오래된 기록(집계 시작)에 닿으면 다시 최근부터 반복한다.
//
// 시작: 첫 사용자 제스처(오디오 잠금 해제)에 맞춰 최근 블럭이 떨어지며 그 돌 소리가 첫 소리다
// (sketch.js — 리플레이 낙하를 제스처까지 붙들어 둔다). 제스처가 오래 없으면 낙하는 무음으로
// 진행하고(보기만 하는 사람), 나중에 제스처가 오면 그때 최근 사람부터 소리가 시작된다.
// 새 죽음이 도착하면(라이브 착지) 그 돌이 울리고, 이어짐은 그 사람부터 다시 거슬러 간다.
//
// 화면: 지금 울리는 사람의 블럭에 착지 하이라이트와 같은 테두리가 소리 길이만큼 켜진다
// (sketch.js drawBlocks — 상세 뷰가 열려 있어도 뒤에서 켜진다). 카메라는 움직이지 않는다.
//
// 손잡이: `?gap=초` 또는 `?gap=최소-최대`(돌과 돌 사이 침묵 — 기본 3.5~4초 사이 무작위, 작가
// 조율 2026-09-18; 고정값을 주면 그 값으로), `?ambient=off`(끄기 — 착지음만).

const AMBIENT_ON = (typeof getParam === "function" ? getParam("ambient") : null) !== "off";
const AMBIENT_GAP = (() => { // [최소, 최대] 초
    const raw = typeof getParam === "function" ? getParam("gap") : null;
    if (raw) {
        const [a, b] = raw.split("-").map(parseFloat);
        if (Number.isFinite(a) && a >= 0) return [a, Number.isFinite(b) && b >= a ? b : a];
    }
    return [3.5, 4.0];
})();
function _ambGapMs() {
    const [a, b] = AMBIENT_GAP;
    return (a + Math.random() * (b - a)) * 1000;
}

let _ambTimer = null;
let _ambCursor = -1;      // 다음에 울릴 victims 인덱스 (아래로 내려간다)
let ambientIdx = -1;      // 지금 울리는 블럭의 pile.settled 인덱스 (그리기용)
let ambientAt = 0;        // 그 소리가 시작된 millis()
let ambientLenMs = 2200;  // 그 소리의 길이 — 테두리가 이만큼 켜진다

function _ambStoneLenMs() {
    return (typeof STONE !== "undefined" ? STONE.END : 2.2) * 1000;
}

// vi(victims 인덱스)의 돌이 방금 울렸다(착지음 등) — 그 다음 사람부터 이어 간다.
function ambientRestart(vi) {
    if (!AMBIENT_ON || typeof playStone !== "function") return;
    clearTimeout(_ambTimer);
    _ambCursor = vi - 1;
    _ambMark(vi);
    _ambTimer = setTimeout(_ambStep, _ambStoneLenMs() + _ambGapMs());
}

// 아무 소리 없이 시작 — 최근 사람부터 바로 (낙하가 이미 무음으로 지나간 뒤 제스처가 온 경우).
function ambientStart() {
    if (!AMBIENT_ON || typeof playStone !== "function" || _ambTimer) return;
    if (typeof victims === "undefined" || !victims.length) return;
    _ambCursor = victims.length - 1;
    _ambStep();
}

function ambientStop() {
    clearTimeout(_ambTimer);
    _ambTimer = null;
    ambientIdx = -1;
}

function _ambStep() {
    _ambTimer = null;
    if (typeof victims === "undefined" || !victims.length) return;
    if (_ambCursor < 0) _ambCursor = victims.length - 1; // 집계 시작에 닿으면 다시 최근부터
    const vi = _ambCursor;
    const v = victims[vi];
    // 다음 사람을 지금 미리 렌더해 두면 그 차례에 지연이 없다
    const nextVi = vi - 1 < 0 ? victims.length - 1 : vi - 1;
    if (typeof prepareStone === "function" && victims[nextVi]) setTimeout(() => prepareStone(victims[nextVi]), 50);
    playStone(v);
    _ambMark(vi);
    _ambCursor = vi - 1;
    _ambTimer = setTimeout(_ambStep, _ambStoneLenMs() + _ambGapMs());
}

function _ambMark(vi) {
    ambientIdx = typeof pile !== "undefined" ? pile.settled.findIndex((s) => s.victimIdx === vi) : -1;
    ambientAt = typeof millis === "function" ? millis() : performance.now();
    ambientLenMs = _ambStoneLenMs();
}
