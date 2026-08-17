// 전역 설정 상수. 모든 모듈이 참조.
const CONFIG = {
    DATA_URL: "data/victims_web.json",
    ACK_URL: "https://the-fallings-acks.thefallings.workers.dev", // "들었습니다" 카운터

    // 물리/좌표
    BLOCK_H: 88,            // 블럭 높이(px) — 지층 한 켜
    BLOCK_MARGIN: 8,        // 좌우 여백
    GROUND_Y: 1000000,      // 바닥의 월드 y (더미는 위로 자람 — 수십 년치 여유)
    GRAVITY_REPLAY: 1.4,    // 리플레이 낙하 중력
    GRAVITY_LIVE: 3.5,      // 신규(세리머니) 낙하 중력

    // 로드/리플레이/라이브
    REPLAY_N: 1,            // 페이지 로드 시 낙하로 재생할 최근 건수 (마지막 한 명만)
    REPLAY_INTERVAL: 240,   // 리플레이 낙하 간격(ms)
    POLL_MS: 10 * 60 * 1000, // 신규 데이터 폴링 주기 (?poll=초 로 재정의 가능)
    ACK_POLL_MS: 30 * 1000,  // 확인(ack) 폴링 주기 — 누군가의 확인을 소리로 전하는 지연

    HIGHLIGHT_MS: 4000,     // 착지 후 하이라이트 지속

    // 카메라
    FOLLOW_LERP: 0.07,
    FOLLOW_ANCHOR: 0.62,    // 더미 꼭대기가 뷰포트 높이의 이 비율 지점에 오도록

    COLORS: {
        bg: [13, 13, 15],
        block: [23, 23, 27],
        blockLine: [42, 42, 48],
        text: [207, 207, 214],
        textDim: [124, 124, 136],
        accent: [95, 125, 156],
        ground: [58, 58, 66],
    },

    COUNT_SINCE_LABEL: "2025년 9월 집계 시작",
    // 체계적 수집이 시작된 날. 이 이전 사망도 기록에는 있지만(판결·성명 기사로 뒤늦게
    // 발견된 죽음) 그 기간은 전수 수집이 아니므로 '하루 몇 명' 속도 계산에서 제외한다.
    COLLECTION_SINCE: "2025-09-01",
};

function getParam(name) {
    return new URLSearchParams(location.search).get(name);
}

// iOS 홈화면 추가(standalone) 감지 — display-mode 미디어 쿼리가 매니페스트 없는
// A2HS에서 매치되지 않는 경우가 있어 레거시 신호(navigator.standalone)도 함께 본다.
// style.css의 html.standalone 규칙이 이 클래스를 받아 카드 크기를 보정한다.
if (navigator.standalone === true) document.documentElement.classList.add("standalone");

// 상세보기(/#/record/…)를 열어둔 채 홈화면에 추가하면 iOS가 그 해시까지 시작 주소로
// 굳힌다 — 앱을 열 때마다 그 죽음의 상세가 뜬다 (작가 실기기 2026-08-17). standalone
// "시작"(동일 출처 referrer 없음 + 히스토리 1)이고 딥링크 표식(?n=1 — 알림·피드 링크가
// 붙임)이 없으면 해시를 지워 메인에서 시작한다. 알림 클릭 딥링크는 표식이 있어 통과.
(function () {
    const standalone = navigator.standalone === true
        || matchMedia("(display-mode: standalone)").matches;
    let fromApp = false;
    try { fromApp = new URL(document.referrer).origin === location.origin; } catch (e) { }
    const marked = new URLSearchParams(location.search).has("n");
    if (standalone && !fromApp && history.length <= 1 && !marked
        && (location.hash || "").startsWith("#/")) {
        history.replaceState(null, "", location.pathname);
    }
})();

const DEBUG = getParam("debug") === "1";
