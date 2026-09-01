// Feedback effects for the quiz: canvas confetti, WebAudio jingles (no sound
// assets needed) and text-to-speech via the Web Speech API.
const Effects = (() => {
    let soundOn = true;

    // --- Confetti (own canvas so the hand-tracking overlay can keep clearing itself) ---
    const fxCanvas = document.createElement('canvas');
    fxCanvas.id = 'fxCanvas';
    document.body.appendChild(fxCanvas);
    const ctx = fxCanvas.getContext('2d');
    let particles = [];
    let rafActive = false;

    function resize() {
        fxCanvas.width = window.innerWidth;
        fxCanvas.height = window.innerHeight;
    }
    window.addEventListener('resize', resize);
    resize();

    function confetti() {
        const colors = ['#FF69B4', '#FFD700', '#00E5FF', '#7CFC00', '#FF6347', '#BA55D3'];
        for (let i = 0; i < 130; i++) {
            particles.push({
                x: fxCanvas.width / 2,
                y: fxCanvas.height * 0.35,
                vx: (Math.random() - 0.5) * 16,
                vy: -Math.random() * 13 - 3,
                size: 4 + Math.random() * 5,
                color: colors[i % colors.length],
                rot: Math.random() * Math.PI,
                vr: (Math.random() - 0.5) * 0.3,
                life: 1,
            });
        }
        if (!rafActive) {
            rafActive = true;
            requestAnimationFrame(tick);
        }
    }

    function tick() {
        ctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
        for (const p of particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.35;
            p.rot += p.vr;
            p.life -= 0.008;
        }
        particles = particles.filter((p) => p.life > 0 && p.y < fxCanvas.height + 20);
        for (const p of particles) {
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            ctx.globalAlpha = Math.max(0, p.life);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
            ctx.restore();
        }
        if (particles.length) {
            requestAnimationFrame(tick);
        } else {
            rafActive = false;
            ctx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
        }
    }

    // --- Sounds (tiny WebAudio jingles) ---
    let audioCtx = null;
    function ensureAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();
        return audioCtx;
    }

    function beep(freq, startOffset, duration, type = 'triangle', gain = 0.12) {
        const context = ensureAudio();
        const osc = context.createOscillator();
        const amp = context.createGain();
        const t0 = context.currentTime + startOffset;
        osc.type = type;
        osc.frequency.value = freq;
        amp.gain.setValueAtTime(0, t0);
        amp.gain.linearRampToValueAtTime(gain, t0 + 0.02);
        amp.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
        osc.connect(amp).connect(context.destination);
        osc.start(t0);
        osc.stop(t0 + duration + 0.05);
    }

    function playCorrect() {
        if (!soundOn) return;
        [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => beep(freq, i * 0.09, 0.2));
    }

    function playWrong() {
        if (!soundOn) return;
        beep(220, 0, 0.25, 'triangle', 0.07);
        beep(174.6, 0.18, 0.35, 'triangle', 0.07);
    }

    // --- Text to speech ---
    // The default voice on many systems is a low-quality robotic one. Pick the
    // best available voice for the language instead (Google/Natural/Enhanced
    // voices rank highest). getVoices() is empty until voiceschanged fires.
    let voices = [];
    function refreshVoices() {
        voices = speechSynthesis.getVoices();
    }
    if ('speechSynthesis' in window) {
        refreshVoices();
        speechSynthesis.onvoiceschanged = refreshVoices;
    }

    function pickVoice(lang) {
        const prefix = lang.slice(0, 2).toLowerCase();
        const matches = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith(prefix));
        if (!matches.length) return null;
        const score = (v) => {
            const name = v.name.toLowerCase();
            let s = 0;
            if (v.lang.toLowerCase().replace('_', '-') === lang.toLowerCase()) s += 4;
            if (name.includes('google')) s += 6;
            if (name.includes('natural') || name.includes('neural') ||
                name.includes('premium') || name.includes('enhanced')) s += 5;
            if (name.includes('siri')) s += 3;
            if (name.includes('samantha')) s += 2;
            return s;
        };
        return matches.sort((a, b) => score(b) - score(a))[0];
    }

    function speak(text, lang = 'en-US') {
        if (!soundOn || !('speechSynthesis' in window)) return;
        try {
            speechSynthesis.cancel(); // never queue up a backlog
            const utterance = new SpeechSynthesisUtterance(text);
            utterance.lang = lang;
            const voice = pickVoice(lang);
            if (voice) utterance.voice = voice;
            utterance.rate = 0.9; // slightly slower = clearer
            utterance.volume = 1;
            speechSynthesis.speak(utterance);
        } catch (error) {
            console.warn('Speech synthesis failed:', error);
        }
    }

    function setSound(on) {
        soundOn = on;
        if (!on && 'speechSynthesis' in window) {
            try { speechSynthesis.cancel(); } catch (error) { /* ignore */ }
        }
    }

    return {
        confetti,
        playCorrect,
        playWrong,
        speak,
        setSound,
        get soundOn() { return soundOn; },
    };
})();
