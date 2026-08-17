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

const DEBUG = getParam("debug") === "1";

// ---- 서체 비교 프로토타입 (?font=maru|pretendard|plex, 2026-08-17) ----
// 비교 단계에서만 CDN 로드 — 선정되면 web/fonts/에 자체 호스팅으로 전환(p5 로컬화와 같은 원칙).
// APP_FONT는 DOM(body)·캔버스(블럭 라벨 textFont)·카드(_CARD_FONT)가 함께 쓴다.
const _FONT_CHOICES = {
    maru: { css: "https://hangeul.pstatic.net/hangeul_static/css/maru-buri.css", family: '"MaruBuri"' },
    pretendard: { css: "https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable.min.css", family: '"Pretendard Variable", Pretendard' },
    plex: { css: "https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+KR:wght@400;700&display=swap", family: '"IBM Plex Sans KR"' },
};
let APP_FONT = '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';
{
    const pick = _FONT_CHOICES[getParam("font")];
    if (pick) {
        const l = document.createElement("link");
        l.rel = "stylesheet";
        l.href = pick.css;
        document.head.appendChild(l);
        APP_FONT = `${pick.family}, ${APP_FONT}`;
        const apply = () => { document.body.style.fontFamily = APP_FONT; };
        if (document.body) apply();
        else document.addEventListener("DOMContentLoaded", apply);
    }
}
