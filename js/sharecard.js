// sharecard.js — 사고 경위 카드를 실제 이미지(<img>)로 렌더 (작가 요청 2026-08-08)
//
// 왜 이미지인가: 모바일에서 길게 눌러 "이미지 저장" 네이티브 메뉴는 실제 <img> 요소에서만
// 뜬다. 상세(포스트) 뷰의 사고 경위 영역을 캔버스로 똑같이 그려 그 위에 얹으면, 보이는
// 그대로를 사진첩에 저장할 수 있고 공유 시트에도 파일로 첨부된다(sketch.js onShareClick).
// 저장된 이미지가 혼자서도 말이 되도록 상단에 날짜·지역, 하단에 추모 꽃과 작품명을 넣는다.
// 접근성: DOM 텍스트(#post-summary)는 이미지 밑에 그대로 남는다(스크린리더용).

let _cardCanvas = null; // 마지막으로 그린 카드 — 공유 첨부용
let _cardToken = 0;     // 연타로 다른 기록을 열었을 때 늦게 도착한 렌더를 버리는 표

const _CARD_FONT = typeof APP_FONT !== "undefined"
    ? APP_FONT
    : '"Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';

// 어절 단위 줄바꿈 — 한 줄에 안 들어가는 긴 어절은 글자 단위로 쪼갠다
function _wrapKorean(ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const fits = (s) => ctx.measureText(s).width <= maxW;
    const lines = [];
    let line = "";
    for (const w of words) {
        const t = line ? line + " " + w : w;
        if (fits(t)) { line = t; continue; }
        if (line) lines.push(line);
        if (fits(w)) { line = w; continue; }
        let chunk = "";
        for (const ch of w) {
            if (fits(chunk + ch)) chunk += ch;
            else { lines.push(chunk); chunk = ch; }
        }
        line = chunk;
    }
    if (line) lines.push(line);
    return lines;
}

// 양쪽 정렬 — DOM(#post-summary)의 text-align: justify와 같은 인상. 마지막 줄과
// 지나치게 벌어지는 줄은 왼쪽 정렬로 둔다 (CSS justify와 같은 규칙).
function _drawJustified(ctx, line, x, y, maxW, isLast, halo = false) {
    // halo: 밝은 글자를 어두운 테두리로 감싸 바쁜(밝은) 돌 위에서도 읽히게
    const put = (t, px) => { if (halo) ctx.strokeText(t, px, y); ctx.fillText(t, px, y); };
    const words = line.split(" ");
    if (isLast || words.length < 2) { put(line, x); return; }
    const wordsW = words.reduce((s, w) => s + ctx.measureText(w).width, 0);
    const gap = (maxW - wordsW) / (words.length - 1);
    if (gap <= 0 || gap > ctx.measureText("가").width * 2) { put(line, x); return; }
    let cx = x;
    for (const w of words) {
        put(w, cx);
        cx += ctx.measureText(w).width + gap;
    }
}

// #post-image와 같은 시각 규격으로 카드를 그린다 (금속 그라데이션 + 16px/줄간 2.0 텍스트)
async function buildPostCard(v, summary, cssW, cssH) {
    const scale = Math.min(3, Math.max(2, window.devicePixelRatio || 2));
    const W = Math.round(cssW * scale), H = Math.round(cssH * scale);
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");

    // 배경 — 블럭과 동일 공식: 가로 미러 그라데이션 + 수직 광 오버레이 (style.css #post-image).
    // 화강암 모드(?granite=1)에서는 그 사람의 데이터 모자이크 확대판이 배경이 된다 —
    // 블럭과 같은 돌 (graniteRender는 sketch.js, 로드 순서상 호출 시점엔 존재).
    const graniteMode = typeof GRANITE_ON !== "undefined" && GRANITE_ON;
    const darkStone = typeof STONE_DARK !== "undefined" && STONE_DARK;
    const overlayV = () => { // 수직 광 오버레이 (style.css #post-image와 동일 공식)
        const g = ctx.createLinearGradient(0, 0, 0, H);
        g.addColorStop(0, "rgba(255,255,255,0.10)");
        g.addColorStop(0.18, "rgba(255,255,255,0.02)");
        g.addColorStop(0.55, "rgba(0,0,0,0)");
        g.addColorStop(1, "rgba(0,0,0,0.26)");
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
    };
    let bareUrl;
    if (graniteMode) {
        // 셀 크기를 화면에 맞춰 자동 조정 — 어떤 기기에서든 기록 전문이 담기게 (하한 4px)
        let cardCell = GRANITE.CELL_CARD;
        const needCells = Math.ceil(_recordBits(v).length / 2);
        while (cardCell > 4 && Math.floor(cssW / cardCell) * Math.floor(cssH / cardCell) < needCells) cardCell--;
        // ① 맨 돌 (토글용) — 진한 획: 글이 걷히면 새김이 또렷해진다 (작가 구성 2026-08-17)
        ctx.drawImage(stoneRender(v, cssW, cssH, cardCell, scale, GRANITE.INK.cardBare), 0, 0, W, H);
        overlayV();
        bareUrl = c.toDataURL("image/png");
        // ② 본문용 — 흐린 획: 글자가 주인공
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(stoneRender(v, cssW, cssH, cardCell, scale, GRANITE.INK.cardText), 0, 0, W, H);
        if (darkStone) { ctx.fillStyle = "rgba(0, 0, 0, 0.30)"; ctx.fillRect(0, 0, W, H); }
        overlayV();
    } else {
        let g0 = ctx.createLinearGradient(0, 0, W, 0);
        g0.addColorStop(0, "hsl(228, 6%, 11%)");
        g0.addColorStop(0.5, "hsl(228, 7%, 27%)");
        g0.addColorStop(1, "hsl(228, 6%, 11%)");
        ctx.fillStyle = g0; ctx.fillRect(0, 0, W, H);
        overlayV();
        bareUrl = c.toDataURL("image/png");
    }

    // 내용(사고 경위)만 담는다 — 날짜·꽃·작품명 없이 (작가 결정 2026-08-09)
    const pad = 26 * scale;
    ctx.textBaseline = "top";

    // 본문 — 넘치면 마지막 줄을 " …"로 마무리 (fitSummary와 같은 규칙)
    const fs = 18 * scale;
    const lh = fs * 2.0;
    // 밝은 돌 위 검은 글자는 볼드 (작가 조율 2026-08-17) — 줄바꿈 측정 전에 폰트 확정
    ctx.font = `${graniteMode && !darkStone ? "700 " : ""}${fs}px ${_CARD_FONT}`;
    // 웹폰트(?font=) 로드 대기 — 카드는 1회 렌더라 폰트가 준비된 뒤 그려야 한다
    try { await document.fonts.load(ctx.font, summary.slice(0, 8)); } catch { /* 폴백 폰트로 진행 */ }
    const maxW = Math.min(W - pad * 2, fs * 32);
    const x0 = (W - maxW) / 2;
    const availH = H - pad * 2;
    let lines = _wrapKorean(ctx, summary, maxW);
    const maxLines = Math.max(1, Math.floor(availH / lh));
    if (lines.length > maxLines) {
        lines = lines.slice(0, maxLines);
        lines[lines.length - 1] = lines[lines.length - 1].replace(/[\s.,]*$/, "") + " …";
    }
    let y = pad + Math.max(0, (availH - lines.length * lh) / 2);
    // 잉크 위계 (작가 선택 2026-08-17) — 획은 중간 회색, 글자가 가장 진한 검정.
    // 띠·판 없이 글자 색만으로 읽힌다. 어두운 돌·금속은 밝은 글자.
    ctx.fillStyle = graniteMode && !darkStone ? "#0d0c0e" : "#e8e8ee";
    lines.forEach((ln, i) => {
        _drawJustified(ctx, ln, x0, y + (lh - fs) / 2, maxW, i === lines.length - 1);
        y += lh;
    });

    _cardCanvas = c;
    return { full: c.toDataURL("image/png"), bare: bareUrl };
}

// 포스트 뷰가 열릴 때 호출 — 사고 경위 영역 위에 카드 이미지를 얹는다
async function updatePostCard(v, summary) {
    const box = document.getElementById("post-image");
    let img = document.getElementById("post-card");
    if (!box || !summary || box.clientWidth < 40 || box.clientHeight < 40) {
        if (img) img.hidden = true;
        _cardCanvas = null;
        return;
    }
    const token = ++_cardToken;
    try {
        const urls = await buildPostCard(v, summary, box.clientWidth, box.clientHeight);
        if (token !== _cardToken) return; // 그 사이 다른 기록이 열림
        let bareImg = document.getElementById("post-card-bare");
        if (!img) {
            img = document.createElement("img");
            img.id = "post-card";
            img.alt = ""; // 실제 내용은 밑의 #post-summary가 담당
            box.appendChild(img);
            // 맨 돌(진한 획) 레이어 — 본문 위에 겹쳐 두고 탭 토글 시 크로스페이드
            // (작가 요청 2026-08-17: 페이드인/아웃). 공유·저장은 항상 글이 있는 쪽.
            // 돌 프로토타입(?stone=)에서만 — 기본 금속 화면에서는 혼란 방지로 끔.
            bareImg = document.createElement("img");
            bareImg.id = "post-card-bare";
            bareImg.alt = "";
            box.appendChild(bareImg);
            img.addEventListener("click", () => {
                if (!bareImg.src) return;
                bareImg.classList.toggle("shown");
            });
        }
        const stoneMode = typeof GRANITE_ON !== "undefined" && GRANITE_ON;
        img.src = urls.full;
        img.hidden = false;
        if (bareImg) {
            if (stoneMode) bareImg.src = urls.bare;
            else bareImg.removeAttribute("src");
            bareImg.classList.remove("shown"); // 열릴 때는 항상 글이 보이는 상태로
        }
    } catch {
        if (img) img.hidden = true;
        _cardCanvas = null; // 실패하면 DOM 텍스트가 그대로 보인다
    }
}

// 공유 첨부용 파일 — 카드가 없으면 null (호출부가 링크 공유로 폴백)
function getCardFile() {
    if (!_cardCanvas) return Promise.resolve(null);
    return new Promise((res) =>
        _cardCanvas.toBlob((b) =>
            res(b ? new File([b], "fallen-caught-crushed.png", { type: "image/png" }) : null), "image/png"));
}
