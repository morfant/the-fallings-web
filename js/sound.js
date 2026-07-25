// 블럭 착지음 — Web Audio 합성 (오디오 파일 없음).
// 낮은 사인 피치 드랍(몸통) + 저역 노이즈 버스트(타격)로 둔탁한 금속 낙하음.
// 브라우저 자동재생 정책: 사용자 제스처 후에만 소리가 나므로 토글 버튼으로 켠다.

let _audioCtx = null;
let _noiseBuf = null;
let soundOn = localStorage.getItem("tf:sound") === "1";

function _ensureCtx() {
    if (!_audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        _audioCtx = new AC();
        const len = _audioCtx.sampleRate * 0.25;
        _noiseBuf = _audioCtx.createBuffer(1, len, _audioCtx.sampleRate);
        const d = _noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    return _audioCtx;
}

function toggleSound() {
    soundOn = !soundOn;
    localStorage.setItem("tf:sound", soundOn ? "1" : "0");
    if (soundOn) {
        const ctx = _ensureCtx();
        if (ctx && ctx.state === "suspended") ctx.resume();
        playThud(0.6); // 켜는 순간 미리듣기
    }
    _updateSoundBtn();
}

function _updateSoundBtn() {
    const btn = document.getElementById("sound-btn");
    if (btn) btn.textContent = soundOn ? "🔊 소리 끄기" : "🔇 소리 켜기";
}

function playThud(vol = 1) {
    if (!soundOn) return;
    const ctx = _ensureCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t = ctx.currentTime;

    // 몸통: 사인 피치 드랍 150→45Hz
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g).connect(ctx.destination);

    // 타격: 저역 노이즈 버스트
    const n = ctx.createBufferSource();
    n.buffer = _noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 850;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.22 * vol, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    n.connect(f).connect(ng).connect(ctx.destination);

    o.start(t); o.stop(t + 1);
    n.start(t); n.stop(t + 0.2);
}

document.addEventListener("DOMContentLoaded", _updateSoundBtn);
