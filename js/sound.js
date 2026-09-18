// 블럭 착지음 — SC/sound.scd의 \victimNew 신스를 Web Audio로 이식한 근사.
//
// 원본 구조 (SuperCollider):
//   sig  = SinOscFB(freq=100, fb = Env.perc(0.001,0.1) × π/2×[3,1])   ← 타격(스테레오)
//   sig2 = Select(category, [clear|cloudy|rainy|snowy|stormy|foggy])   ← 날씨 레이어
//   del  = DelayC(sig2, 0.2) × 0.5
//   out  = (sig×0.6 + sig2×0.4 + del×wet) × Env.perc(0.01, 1.5) × 0.4
//   파라미터: freq2 = 100 + 기온×20, wet = 습도/100, category = 날씨상태
//
// Web Audio 차이: SinOscFB(단일 샘플 피드백)는 그래프로 불가능해서
// 같은 주파수의 자기 FM(모듈레이터 인덱스가 0.1초 만에 감쇠)으로 근사.
// rainy의 Convolution×Dust는 랜덤 스파이크 게이트로 근사.

// ---- 착지음의 두 판 (2026-09-18) ----
// 기본 = **돌 소리**(playStone, web/js/stone.js — SC/stone_sonify.scd 이식: 그 사람의 무늬에서
// 읽은 긴 사선의 글리산도, 되먹임 = 지금·이곳의 날씨). 아래 \victimNew 이식(playThud)은
// 되돌림 경로로 유지 — `?sound=thud`. (`?stone=off`가 금속 블럭으로 돌아가는 것과 같은 문법)
const SOUND_MODE = (typeof getParam === "function" && getParam("sound")) || "stone";

let _audioCtx = null;
let _noiseBuf = null;
// 소리는 기본 켬. 브라우저 자동재생 정책상 첫 사용자 제스처(클릭/터치/키) 후부터
// 실제로 소리가 난다 — 아래에서 제스처 시 오디오를 잠금 해제한다.
let soundOn = true;
let audioUnlocked = false; // 첫 제스처가 있었는가 — sketch.js가 리플레이 낙하를 이때까지 붙들어 둔다

// 날씨 → 신스 파라미터 (SC와 동일 매핑).
// **어디의 날씨인가 (작가 확정 2026-09-13): 듣고 있는 사람의 지금·이곳.** 경로 없는
// wttr.in은 요청 IP로 위치를 추정해 그곳 날씨를 준다 — 위치 권한 팝업 없이, 지금도
// 보내는 요청의 응답만 달라진다. 설치 버전의 '서울 고정'은 그 방에 있는 사람들의
// 날씨였으므로, 청취자 위치는 그 문법의 웹 일반화다. 개념: "지금 여기 이곳과 누군가의
// 죽음이 발생한 곳의 차이" — 좋은 날씨 속의 나와 그 죽음 사이의 간극이 소리의 구조.
// IP 추정이 실패하면 서울로 폴백(종전과 동일해질 뿐).
let _weather = { freq2: 150, wet: 0.1, category: 0 }; // 기본값 = SynthDef 기본값

async function loadWeather() {
    try {
        const r = await fetch("https://wttr.in/?format=j1")
            .catch(() => fetch("https://wttr.in/Seoul?format=j1"));
        const d = await r.json();
        const c = d.current_condition[0];
        const temp = parseFloat(c.temp_C);
        const hum = parseFloat(c.humidity);
        const desc = String(c.weatherDesc?.[0]?.value || "").toLowerCase();
        let cat = 0; // clear
        if (desc.includes("cloud") || desc.includes("overcast")) cat = 1;
        if (desc.includes("rain") || desc.includes("drizzle") || desc.includes("shower")) cat = 2;
        if (desc.includes("snow") || desc.includes("sleet") || desc.includes("blizzard")) cat = 3;
        if (desc.includes("storm") || desc.includes("thunder")) cat = 4;
        if (desc.includes("fog") || desc.includes("mist") || desc.includes("haze")) cat = 5;
        _weather = { freq2: 100 + temp * 20, wet: hum / 100, category: cat };
    } catch { /* 실패 시 기본값 유지 */ }
}

function _ensureCtx() {
    if (!_audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        _audioCtx = new AC();
        const len = Math.floor(_audioCtx.sampleRate * 2);
        _noiseBuf = _audioCtx.createBuffer(1, len, _audioCtx.sampleRate);
        const data = _noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    return _audioCtx;
}

// 첫 사용자 제스처에서 오디오 잠금 해제 (1회)
function _unlockAudio() {
    const ctx = _ensureCtx();
    if (ctx && ctx.state === "suspended") ctx.resume();
    ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
        document.removeEventListener(ev, _unlockAudio));
    audioUnlocked = true;
    // 낙하가 이미 무음으로 지나간 뒤라면(제스처가 늦은 경우) 최근 사람부터 앰비언트를 바로 시작.
    // 낙하가 아직 붙들려 있으면 착지가 첫 소리가 되고 거기서 이어짐이 시작된다 (sketch.js).
    if (typeof appState !== "undefined" && appState === "live" && typeof ambientStart === "function") {
        setTimeout(ambientStart, 300);
    }
}

// SinOscFB 근사: 자기 FM — 인덱스(rad)×주파수 = 주파수 편차, Env.perc(0.001, 0.1)로 감쇠
function _strike(ctx, t, dest, fbIndex, pan) {
    const car = ctx.createOscillator();
    car.type = "sine";
    car.frequency.value = 100; // SC freq 기본값
    const mod = ctx.createOscillator();
    mod.type = "sine";
    mod.frequency.value = 100;
    const mg = ctx.createGain();
    mg.gain.setValueAtTime(fbIndex * 100, t);
    mg.gain.exponentialRampToValueAtTime(0.01, t + 0.1);
    mod.connect(mg).connect(car.frequency);
    const g = ctx.createGain();
    g.gain.value = 0.6; // sig × 0.6
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    car.connect(g).connect(p).connect(dest);
    car.start(t); car.stop(t + 1.6);
    mod.start(t); mod.stop(t + 0.4);
    return car;
}

function _noiseSrc(ctx, t, dur) {
    const n = ctx.createBufferSource();
    n.buffer = _noiseBuf;
    n.loop = true;
    n.start(t);
    n.stop(t + dur);
    return n;
}

// SC의 Select.ar(category, [...]) 이식 — 각 날씨 레이어 근사
function _categoryLayer(ctx, t, dest, w) {
    const dur = 1.6;
    switch (w.category) {
        case 1: { // cloudy: LPF(WhiteNoise 0.2, freq2)
            const n = _noiseSrc(ctx, t, dur);
            const f = ctx.createBiquadFilter();
            f.type = "lowpass"; f.frequency.value = Math.max(80, w.freq2);
            const g = ctx.createGain(); g.gain.value = 0.2;
            n.connect(f).connect(g).connect(dest);
            break;
        }
        case 2: { // rainy: Convolution(Resonz(noise, freq2), Dust) 근사 — 랜덤 스파이크 게이트
            const n = _noiseSrc(ctx, t, dur);
            const f = ctx.createBiquadFilter();
            f.type = "bandpass"; f.frequency.value = Math.max(120, w.freq2); f.Q.value = 8;
            const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
            for (let i = 0; i < 40; i++) { // Dust.ar(50) 근사
                const st = t + Math.random() * 1.4;
                g.gain.setValueAtTime(0.5, st);
                g.gain.exponentialRampToValueAtTime(0.0001, st + 0.03);
            }
            n.connect(f).connect(g).connect(dest);
            break;
        }
        case 3: { // snowy: BPF(BrownNoise, 50) × Decay2(Dust(10)) — 낮고 성긴 웅웅거림
            const n = _noiseSrc(ctx, t, dur);
            const f = ctx.createBiquadFilter();
            f.type = "lowpass"; f.frequency.value = 120;
            const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t);
            for (let i = 0; i < 14; i++) {
                const st = t + Math.random() * 1.4;
                g.gain.setValueAtTime(0.4, st);
                g.gain.exponentialRampToValueAtTime(0.0001, st + 0.12);
            }
            n.connect(f).connect(g).connect(dest);
            break;
        }
        case 4: { // stormy: LPF(WhiteNoise 0.1, freq2)
            const n = _noiseSrc(ctx, t, dur);
            const f = ctx.createBiquadFilter();
            f.type = "lowpass"; f.frequency.value = Math.max(80, w.freq2);
            const g = ctx.createGain(); g.gain.value = 0.1;
            n.connect(f).connect(g).connect(dest);
            break;
        }
        case 5: { // foggy: 60/61Hz 사인이 느린 노이즈로 흔들리는 아주 작은 소리
            [60, 61].forEach((fr, i) => {
                const o = ctx.createOscillator();
                o.type = "sine"; o.frequency.value = fr;
                const g = ctx.createGain(); g.gain.value = 0.06;
                const lfo = ctx.createOscillator();
                lfo.type = "sine"; lfo.frequency.value = 2 + i * 0.1;
                const lg = ctx.createGain(); lg.gain.value = 0.04;
                lfo.connect(lg).connect(g.gain);
                const p = ctx.createStereoPanner(); p.pan.value = i === 0 ? -0.4 : 0.4;
                o.connect(g).connect(p).connect(dest);
                o.start(t); o.stop(t + dur);
                lfo.start(t); lfo.stop(t + dur);
            });
            break;
        }
        default: { // 0 clear: SinOscFB(freq2) × 0.1 — 옅은 배음의 지속음
            const o = ctx.createOscillator();
            o.type = "sine"; o.frequency.value = Math.max(60, w.freq2);
            const mod = ctx.createOscillator();
            mod.type = "sine"; mod.frequency.value = Math.max(60, w.freq2);
            const mg = ctx.createGain(); mg.gain.value = w.freq2 * 0.5; // 가벼운 고정 피드백
            mod.connect(mg).connect(o.frequency);
            const g = ctx.createGain(); g.gain.value = 0.1;
            o.connect(g).connect(dest);
            o.start(t); o.stop(t + dur);
            mod.start(t); mod.stop(t + dur);
        }
    }
}

function playThud(vol = 1) {
    if (!soundOn) return;
    const ctx = _ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;

    // 전체 엔벨로프: Env.perc(0.01, 1.5) × 0.4
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(1.0 * vol, t + 0.01);
    master.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
    // LeakDC 근사
    const dc = ctx.createBiquadFilter();
    dc.type = "highpass"; dc.frequency.value = 20;
    master.connect(dc).connect(ctx.destination);

    // 타격 (스테레오, 피드백 3배/1배 — SC의 pi/2*[3,1])
    _strike(ctx, t, master, Math.PI / 2 * 3, -0.3);
    _strike(ctx, t, master, Math.PI / 2 * 1, 0.3);

    // 날씨 레이어 (×0.4) + 딜레이 0.2s (×wet×0.5)
    const layer = ctx.createGain();
    layer.gain.value = 0.4;
    layer.connect(master);
    const del = ctx.createDelay(0.5);
    del.delayTime.value = 0.2;
    const dg = ctx.createGain();
    dg.gain.value = _weather.wet * 0.5;
    layer.connect(del).connect(dg).connect(master);
    _categoryLayer(ctx, t, layer, _weather);
}

// ---- 돌 소리 (web/js/stone.js) ----
// 사람당 버퍼를 미리 렌더해 캐시한다 — 착지 순간에 수십 ms 렌더가 끼면 프레임이 튄다.
// 캐시 키에 fb(날씨)가 들어가므로 날씨가 바뀌면 그 사람도 다시 렌더된다.
const _stoneBufs = new Map(); // "pid|fb|sr" → AudioBuffer
const _WEATHER_NAMES = ["clear", "cloudy", "rainy", "snowy", "stormy", "foggy"];
function stoneFb() {
    if (typeof STONE === "undefined") return 1;
    return STONE.FB[_WEATHER_NAMES[_weather.category]] ?? STONE.FB.cloudy;
}
function _stoneKey(v, fb, sr) { return `${v?.pid || v?.link}|${fb}|${sr}`; }
// 렌더만 (재생 없음). 낙하가 시작될 때 불러 두면 착지 시 지연 0.
function prepareStone(v) {
    const ctx = _ensureCtx();
    if (!ctx || typeof renderStone !== "function" || !v) return null;
    const fb = stoneFb(), key = _stoneKey(v, fb, ctx.sampleRate);
    let buf = _stoneBufs.get(key);
    if (!buf) {
        const r = renderStone(v, fb, ctx.sampleRate);
        buf = ctx.createBuffer(2, r.length, r.sr);
        buf.copyToChannel(r.L, 0);
        buf.copyToChannel(r.R, 1);
        if (_stoneBufs.size > 24) _stoneBufs.delete(_stoneBufs.keys().next().value); // 오래된 것부터 버림
        _stoneBufs.set(key, buf);
    }
    return buf;
}
// 그 사람의 돌 소리. 첫 획의 8ms 어택이 착지의 타격이다 (별도 타격음 없음).
function playStone(v, vol = 1) {
    if (!soundOn) return;
    const ctx = _ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const buf = prepareStone(v);
    if (!buf) { playThud(vol); return; } // stone.js 미로드 등 — 옛 소리로 폴백
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = vol;
    const dc = ctx.createBiquadFilter(); // LeakDC 근사 (playThud와 동일)
    dc.type = "highpass"; dc.frequency.value = 20;
    src.connect(g).connect(dc).connect(ctx.destination);
    src.start(ctx.currentTime);
}
// 착지음 진입점 — 모드에 따라 돌 소리 / 옛 착지음
function playLanding(v, vol = 1) {
    if (SOUND_MODE === "thud") playThud(vol);
    else playStone(v, vol);
}

// ---- 확인 소리 (작가 지정 2026-09-18) ----
// 누군가 죽음을 확인했을 때 — 푸시 알림을 걷어내고 그 자리를 소리에 넘겼다
// (작가 결정 2026-08-01). 알림은 "전달"이지만 소리는 "지금 함께 있음"이다.
// 소리는 작가의 SC 신스 \ping_other 의 이식 (종전엔 착지음을 빌렸다; 2026-09-19 3판):
//   sig = SinOsc.ar(rrand(600, 700)) * SinOsc.ar(300 * SinOsc.kr(250, mul: 0.4));
//   env = Env.perc(0.1, 1.0);  Pan2(sig, 0, amp) * env
//   (1판: 300 * kr(250), perc 0.1/2.0 · 2판: 100 * kr(320, mul 0.8), perc 0.1/1.0)
// 핵심은 변조기 주파수를 흔드는 SinOsc.kr(250)이 **제어율(sr/64 ≈ 689Hz)로 샘플링**돼
// 엘리어싱한다는 것 — 그 계단식 흔들림이 이 소리의 결이다. 오디오 그래프의 LFO는 그걸
// 내지 못하므로 돌 소리처럼 샘플 단위로 렌더하며 kr을 SC 기본(44.1k/64)으로 흉내 낸다.
// 반송파는 매번 600~700Hz에서 새로 뽑는다(SC의 rrand이 정의 시점마다 굴려지는 것과 같게).
// modDepth = 300 × mul 0.4. amp: 원문 0.1의 1/3 (돌 소리 곁에서 600~700Hz가 훨씬 크게 들려, 작가 조율 2026-09-19).
const ACK_PING = { fLo: 600, fHi: 700, modDepth: 300 * 0.4, modLfo: 250, att: 0.1, rel: 1.0, amp: 0.1 / 3,
    krRate: 44100 / 64 };
function _renderAckPing(sr) {
    const P = ACK_PING;
    const N = Math.ceil((P.att + P.rel) * sr);
    const out = new Float32Array(N);
    const f0 = P.fLo + Math.random() * (P.fHi - P.fLo);
    const curve = (a, b, u, c) => a + (b - a) * (1 - Math.exp(u * c)) / (1 - Math.exp(c)); // SC Env 커브
    const blockLen = sr / P.krRate; // kr 한 틱의 샘플 수 (SC 기본 44.1k에서 64)
    let phC = 0, phM = 0, phK = 0, modF = 0, nextBlock = 0;
    for (let i = 0; i < N; i++) {
        if (i >= nextBlock) { // 제어율 틱 — 변조기 주파수 갱신 (여기서 엘리어싱이 난다)
            modF = P.modDepth * Math.sin(phK);
            phK += 2 * Math.PI * P.modLfo / P.krRate;
            nextBlock += blockLen;
        }
        const t = i / sr;
        const env = t < P.att ? curve(0, 1, t / P.att, -4) : curve(1, 0, (t - P.att) / P.rel, -4);
        phC += 2 * Math.PI * f0 / sr;
        phM += 2 * Math.PI * modF / sr;
        out[i] = Math.sin(phC) * Math.sin(phM) * env * P.amp * Math.SQRT1_2; // Pan2 중앙
    }
    return out;
}
function playAckPing() {
    if (!soundOn) return;
    const ctx = _ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const mono = _renderAckPing(ctx.sampleRate);
    const buf = ctx.createBuffer(2, mono.length, ctx.sampleRate);
    buf.copyToChannel(mono, 0);
    buf.copyToChannel(mono, 1);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.start(ctx.currentTime);
}
// 한 주기에 여러 건이 들어오면 겹치지 않게 벌려서 그 수만큼 울린다.
function playAckChime(n = 1) {
    if (!soundOn) return;
    const times = Math.min(n, 3);
    for (let i = 0; i < times; i++) {
        setTimeout(playAckPing, i * 550);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    loadWeather();
    setInterval(loadWeather, 30 * 60 * 1000); // 30분마다 날씨 갱신
    ["pointerdown", "keydown", "touchstart"].forEach((ev) =>
        document.addEventListener(ev, _unlockAudio));
});
