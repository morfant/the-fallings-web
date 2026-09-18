// 돌 소리 — 상세 카드의 hatch 새김(무늬)을 소리로 읽는다. SC/stone_sonify.scd의 웹 이식.
//
// 소리 구조 (작가 확정 2026-09-14, 신스 하나·층 하나): 소리 = **긴 사선의 글리산도들뿐**.
//   긴 사선 = 같은 방향 사선(╱╲)이 5칸 이상 대각으로 이어진 획. 없으면 그 돌의 최장 사선들
//   (침묵인 돌은 없다). 세로 76행 = 음높이(로그) / 가로 64칸 = 시간·팬. ╱ 상행, ╲ 하행.
//   첫 획 = 착지의 타격 — 별도 소리 없이 8ms 어택 엔벨로프만. 되먹임(fb) = 날씨
//   (표 STONE.FB, 작가 확정 2026-09-18: 눈 0.3 · 안개 0.9 · 맑음 1.5 · 흐림 3 · 비 6 · 폭풍 9).
//
// 무늬는 카드 고정 격자(64×76)에서 읽는다 — 블럭 격자는 기기별 가변이라 같은 사람이 다른
// 소리가 된다. 이 격자 규칙은 sketch.js `_stoneHatch`(그리기)와 같아야 하며, Node 시안
// (data/scripts/sonify_stone_proto.mjs)도 이 파일을 import한다. **무늬 규칙을 바꾸면
// sketch.js와 여기를 함께 고치고 `node data/scripts/check_stone_rules.mjs`로 대조할 것.**
//
// 합성은 오디오 그래프가 아니라 **샘플 단위 계산**이다. SC의 SinOscFB(단일 샘플 되먹임)는
// 오실레이터 그래프로 근사하면 fb 3~9의 혼돈 영역에서 성질이 달라지는데, fb가 곧 날씨 축이라
// 근사를 쓰지 않는다. 사람당 획 십수 개 × 2.2초 → 수십 ms에 렌더, pid별 캐시(sound.js).
// 이 파일은 브라우저 전역과 Node(require) 양쪽에서 동작한다 (rs.js와 같은 방식).

const STONE = {
    GRID: { cols: 64, rows: 76 },      // = GRANITE.CARD_GRID (sketch.js)
    MIN_RUN: 5,                        // 긴 사선의 최소 길이(칸)
    F_LO: 160, F_HI: 4800,             // 76행의 주파수 범위(로그) — 아래 PITCH를 곱해 실제 음역이 된다
    SWEEP: 0.5,                        // 64칸을 읽는 시간(초) — 획의 시작 시각 = 열 × SWEEP/64
    END: 2.2,                          // 글리산도가 넘지 못하는 시각(초)
    CELL_SEC: 0.05,                    // 글리산도 칸당 시간(초)
    PITCH: 0.0625,                     // 음높이 배율 — 네 옥타브 아래(10~300Hz), 작가 조율 2026-09-14
    HARM2: 0.25,                       // 2배음 비율(×0.3)
    AMP: 0.16,                         // 획 하나의 기준 진폭
    GAIN: 1.0,                         // 전체 배율 (SC ~p.strokeGain)
    ATT_FIRST: 0.008,                  // 첫 획 어택(초) = 착지의 타격
    ATT_REST: 0.35,                    // 나머지 획 어택 = 길이의 비율
    // 날씨 → SinOscFB 되먹임 (작가 확정 2026-09-18). 키는 sound.js 카테고리 이름.
    FB: { clear: 1.5, cloudy: 3.0, rainy: 6.0, snowy: 0.3, stormy: 9.0, foggy: 0.9 },
    // 소프트 리미터 무릎 (작가 선택 2026-09-18). 이 아래는 그대로, 위는 tanh로 눌러 1을 넘지 않게.
    // 획 9개 이상이 열 개까지 겹치는 돌(울산화력 등 12/1,710건)만 닿는다 — 실측 중앙값 0.28.
    // SC 판도 같은 식으로 누른다 (\stoneMaster).
    LIMIT_TH: 0.8,
};

// ---- 의존 (브라우저: 전역 rsFrame/_flowerHash/_mulberry32 — 호출 시점에 찾으므로 로드 순서 무관) ----
const _stoneIsNode = typeof module !== "undefined" && module.exports;
const _stoneLib = _stoneIsNode
    ? { rsFrame: require("./rs.js").rsFrame, ...require("./flower.js") }
    : null;
function _stoneDep(name) {
    if (_stoneIsNode) return _stoneLib[name];
    const g = typeof globalThis !== "undefined" ? globalThis : window;
    return g[name];
}

// 칸 좌표로 씨를 나눈 난수 — sketch.js `_cellRand`와 동일 (돌 전체가 결정적인 무한 평면)
function _stoneCellRand(seed, row, col) {
    return _stoneDep("_mulberry32")((seed ^ Math.imul(row + 1, 73856093) ^ Math.imul(col + 1, 19349663)) >>> 0);
}

// 기록 → 비트열 — sketch.js `_recordBits`와 동일 (필드 순서·구분자·RS 여벌까지)
function stoneRecordBits(v) {
    const s = [v?.pid, v?.date, v?.region, v?.accType, v?.age ?? "", v?.immigrant || "",
        v?.ofDeaths || "", v?.accSummary || ""].map((x) => x ?? "").join("|");
    const payload = new TextEncoder().encode(s);
    const cap = (STONE.GRID.cols * STONE.GRID.rows * 2) / 8;
    const rs = _stoneDep("rsFrame");
    const bytes = typeof rs === "function" ? rs(payload, cap) : payload;
    const bits = [];
    for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    return bits;
}

// 카드 격자의 칸 방향. 반환: rows개의 Uint8Array(cols). 값: 0=╱ 1=╲ 2=─ 3=│ 4=빈칸
// 규칙 = sketch.js `_stoneHatch`(grid 경로): 2비트/칸, 값 2는 (row+col) 짝수면 ─ 홀수면 │,
// 값 3은 빈칸. 데이터가 끝나면 칸 난수로 채움.
function stoneCells(v) {
    const { cols, rows } = STONE.GRID;
    const bits = stoneRecordBits(v);
    const seed = _stoneDep("_flowerHash")(String(v?.pid || v?.link || ""));
    const cells = [];
    let bi = 0;
    for (let row = 0; row < rows; row++) {
        const line = new Uint8Array(cols);
        for (let col = 0; col < cols; col++) {
            const rnd = _stoneCellRand(seed, row, col);
            const val = bi + 1 < bits.length ? (bits[bi++] << 1) | bits[bi++] : Math.floor(rnd() * 4);
            line[col] = val === 3 ? 4 : val === 2 ? (((row + col) % 2 === 0) ? 2 : 3) : val;
        }
        cells.push(line);
    }
    return cells;
}

// 긴 사선 목록 [{r, c, o, k}] — 좌상단부터 행 우선으로 훑어, 같은 방향 사선이 대각으로 이어진
// 길이 k를 잰다(╱는 우상향: 행 감소, ╲는 우하향: 행 증가). MIN_RUN 이상이 하나도 없으면
// 그 돌의 최장 획들(k ≥ 2)을 돌려준다 (작가 선택 ⓐ 2026-09-14 — 침묵인 돌은 없다).
function stoneStrokes(cells, minLen = STONE.MIN_RUN) {
    const { cols, rows } = STONE.GRID;
    const seen = new Uint8Array(rows * cols);
    const all = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const o = cells[r][c];
        if (o > 1 || seen[r * cols + c]) continue;
        const dr = o === 0 ? -1 : 1;
        let k = 0, rr = r, cc = c;
        while (rr >= 0 && rr < rows && cc < cols && cells[rr][cc] === o) {
            seen[rr * cols + cc] = 1; k++; rr += dr; cc++;
        }
        all.push({ r, c, o, k });
    }
    const long = all.filter((s) => s.k >= minLen);
    if (long.length) return long;
    const kmax = Math.max(0, ...all.map((s) => s.k));
    return all.filter((s) => s.k === kmax && kmax > 1);
}

// ---- 합성 (SC \stoneStroke 의 샘플 단위 등가) ----
//
// SynthDef(\stoneStroke): u = Line(0,1,dur); f = fA·(fB/fA)^u
//   env = Env([0,1,0], [attT, max(dur−attT, 0.05)], [6, −4])
//   sig = SinOscFB(f, fb) + SinOsc(f/2)·0.7 + SinOsc(2f)·harm2·0.3
//   sig = LPF(sig, clip(3f, 200, 2000));  out = Pan2(sig·env·amp, pan)

function _stoneRow2Freq(r) {
    return STONE.F_HI * Math.pow(STONE.F_LO / STONE.F_HI, r / (STONE.GRID.rows - 1));
}
// SC Env 수치 커브: a + (b−a)·(1−e^{u·c})/(1−e^{c})
function _stoneCurve(a, b, u, c) {
    if (Math.abs(c) < 0.001) return a + (b - a) * u;
    return a + (b - a) * (1 - Math.exp(u * c)) / (1 - Math.exp(c));
}
// 획 하나의 연주 파라미터 (SC ~play 와 동일 산식)
function stoneStrokeParams(strokes, cfg = STONE) {
    const { cols, rows } = cfg.GRID;
    const dt = cfg.SWEEP / cols;
    const sorted = strokes.slice().sort((a, b) => a.c - b.c);
    return sorted.map((s, i) => {
        const t0 = s.c * dt;
        const dur = Math.max(0.12, Math.min(s.k * cfg.CELL_SEC, cfg.END - t0));
        const fA = _stoneRow2Freq(s.r) * cfg.PITCH;
        const fB = _stoneRow2Freq(s.o === 0 ? s.r - s.k + 1 : s.r + s.k - 1) * cfg.PITCH;
        const pan = -0.6 + 1.2 * (s.c + s.k / 2) / (cols - 1);
        const amp = cfg.AMP * Math.min(1, s.k / 8) * Math.pow(cfg.F_LO / Math.min(fA, fB), 0.3) * cfg.GAIN;
        const attT = i === 0 ? cfg.ATT_FIRST : dur * cfg.ATT_REST;
        return { t0, dur, fA, fB, pan, amp, attT, rows };
    });
}

// 스테레오 렌더. 반환 { L, R, sr, length }. fb = 되먹임(날씨).
function renderStoneStrokes(strokes, fb, sr = 48000, cfg = STONE) {
    const params = stoneStrokeParams(strokes, cfg);
    const tail = 0.15; // 필터·엔벨로프 잔여
    const N = Math.ceil((cfg.END + tail) * sr);
    const L = new Float32Array(N), R = new Float32Array(N);
    const BLOCK = 64; // SC 컨트롤 블록 — LPF 계수 갱신 주기
    for (const p of params) {
        const envLen = p.attT + Math.max(p.dur - p.attT, 0.05);
        const n = Math.min(N - Math.floor(p.t0 * sr), Math.ceil(envLen * sr));
        if (n <= 0) continue;
        const i0 = Math.floor(p.t0 * sr);
        const gl = Math.cos((p.pan + 1) * Math.PI / 4), gr = Math.sin((p.pan + 1) * Math.PI / 4);
        const ratio = p.fB / p.fA;
        let ph = 0, y = 0;                     // SinOscFB 위상·이전 출력
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0;    // LPF 상태
        let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
        for (let k = 0; k < n; k++) {
            const t = k / sr;
            const u = Math.min(1, t / p.dur);
            const f = p.fA * Math.pow(ratio, u);
            if (k % BLOCK === 0) { // 2차 버터워스 저역 (RBJ, Q = 1/√2) — SC LPF 등가
                const fc = Math.min(2000, Math.max(200, f * 3));
                const w0 = 2 * Math.PI * fc / sr, cw = Math.cos(w0), al = Math.sin(w0) / (2 * Math.SQRT1_2);
                const a0 = 1 + al;
                b0 = ((1 - cw) / 2) / a0; b1 = (1 - cw) / a0; b2 = b0; a1 = (-2 * cw) / a0; a2 = (1 - al) / a0;
            }
            const env = t < p.attT
                ? _stoneCurve(0, 1, t / p.attT, 6)
                : _stoneCurve(1, 0, Math.min(1, (t - p.attT) / Math.max(p.dur - p.attT, 0.05)), -4);
            ph += 2 * Math.PI * f / sr;
            if (ph > 2 * Math.PI) ph -= 2 * Math.PI;
            y = Math.sin(ph + fb * y);
            const sig = y + 0.7 * Math.sin(ph * 0.5) + cfg.HARM2 * 0.3 * Math.sin(ph * 2);
            const out = b0 * sig + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
            x2 = x1; x1 = sig; y2 = y1; y1 = out;
            const s = out * env * p.amp;
            L[i0 + k] += s * gl; R[i0 + k] += s * gr;
        }
    }
    // 소프트 리미터 — 무릎(LIMIT_TH) 위를 tanh로 눌러 1을 넘지 않게. 리미터 전 피크와 눌린
    // 샘플 수를 함께 돌려준다 (진단용 — data/scripts/render_stone_web.mjs).
    const th = cfg.LIMIT_TH, span = 1 - th;
    let peak = 0, limited = 0;
    const knee = (x) => {
        const a = Math.abs(x);
        return a <= th ? x : Math.sign(x) * (th + span * Math.tanh((a - th) / span));
    };
    for (let i = 0; i < N; i++) {
        const a = Math.abs(L[i]), b = Math.abs(R[i]);
        if (a > peak) peak = a; if (b > peak) peak = b;
        if (a > th) { limited++; L[i] = knee(L[i]); }
        if (b > th) { limited++; R[i] = knee(R[i]); }
    }
    return { L, R, sr, length: N, peak, limited, clipped: 0 };
}

// 기록 → 렌더 한 번에 (sound.js가 쓰는 진입점)
function renderStone(v, fb, sr) {
    return renderStoneStrokes(stoneStrokes(stoneCells(v)), fb, sr);
}

if (_stoneIsNode) {
    module.exports = { STONE, stoneRecordBits, stoneCells, stoneStrokes, stoneStrokeParams,
        renderStoneStrokes, renderStone };
}
