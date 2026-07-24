// 전역 설정 상수. 모든 모듈이 참조.
const CONFIG = {
    DATA_URL: "data/victims_web.json",

    // 물리/좌표
    BLOCK_H: 44,            // 블럭 높이(px) — 지층 한 켜
    BLOCK_MARGIN: 8,        // 좌우 여백
    GROUND_Y: 1000000,      // 바닥의 월드 y (더미는 위로 자람 — 수십 년치 여유)
    GRAVITY_REPLAY: 1.4,    // 리플레이 낙하 중력
    GRAVITY_LIVE: 0.18,     // 신규(세리머니) 낙하 중력

    // 로드/리플레이/라이브
    REPLAY_N: 12,           // 페이지 로드 시 낙하로 재생할 최근 건수
    REPLAY_INTERVAL: 240,   // 리플레이 낙하 간격(ms)
    POLL_MS: 10 * 60 * 1000, // 신규 데이터 폴링 주기 (?poll=초 로 재정의 가능)
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
        accent: [201, 106, 90],
        ground: [58, 58, 66],
    },

    COUNT_SINCE_LABEL: "2025년 9월 집계 시작",
};

function getParam(name) {
    return new URLSearchParams(location.search).get(name);
}

const DEBUG = getParam("debug") === "1";
