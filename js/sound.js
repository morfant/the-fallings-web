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

let _audioCtx = null;
let _noiseBuf = null;
let soundOn = localStorage.getItem("tf:sound") === "1";

// 날씨 → 신스 파라미터 (SC와 동일 매핑, wttr.in/Seoul — 설치 버전과 같은 소스)
let _weather = { freq2: 150, wet: 0.1, category: 0 }; // 기본값 = SynthDef 기본값

async function loadWeather() {
    try {
        const r = await fetch("https://wttr.in/Seoul?format=j1");
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

function toggleSound() {
    soundOn = !soundOn;
    localStorage.setItem("tf:sound", soundOn ? "1" : "0");
    if (soundOn) {
        const ctx = _ensureCtx();
        if (ctx && ctx.state === "suspended") ctx.resume();
        playThud(0.7); // 켜는 순간 미리듣기
    }
    _updateSoundBtn();
}

function _updateSoundBtn() {
    const btn = document.getElementById("sound-btn");
    if (btn) btn.textContent = soundOn ? "🔊 소리 끄기" : "🔇 소리 켜기";
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
    master.gain.exponentialRampToValueAtTime(0.4 * vol, t + 0.01);
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

document.addEventListener("DOMContentLoaded", () => {
    _updateSoundBtn();
    loadWeather();
    setInterval(loadWeather, 30 * 60 * 1000); // 30분마다 날씨 갱신
});
