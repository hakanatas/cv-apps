// Sounds (WebAudio jingles, no assets) and text-to-speech with a voice picker.
let soundOn = true;
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

export function unlockAudio() {
    try { ensureAudio(); } catch (error) { /* no audio available */ }
}

export function playCorrect() {
    if (!soundOn) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => beep(freq, i * 0.09, 0.2));
}

export function playWrong() {
    if (!soundOn) return;
    beep(220, 0, 0.25, 'triangle', 0.07);
    beep(174.6, 0.18, 0.35, 'triangle', 0.07);
}

export function playFanfare() {
    if (!soundOn) return;
    [523.25, 523.25, 523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => beep(freq, i * 0.12, 0.25));
}

// --- Text to speech ---
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
        return s;
    };
    return matches.sort((a, b) => score(b) - score(a))[0];
}

function makeUtterance(text, lang) {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    const voice = pickVoice(lang);
    if (voice) utterance.voice = voice;
    utterance.rate = 0.9;
    return utterance;
}

// Speaks one or more phrases in order. Each phrase: { text, lang }.
// Cancels whatever was being said before (no backlog).
export function speak(phrases, lang = 'tr-TR') {
    if (!soundOn || !('speechSynthesis' in window)) return;
    const list = Array.isArray(phrases) ? phrases : [{ text: phrases, lang }];
    try {
        speechSynthesis.cancel();
        for (const phrase of list) {
            speechSynthesis.speak(makeUtterance(phrase.text, phrase.lang || lang));
        }
    } catch (error) {
        console.warn('Speech synthesis failed:', error);
    }
}

export function setSound(on) {
    soundOn = on;
    if (!on && 'speechSynthesis' in window) {
        try { speechSynthesis.cancel(); } catch (error) { /* ignore */ }
    }
}

export function isSoundOn() {
    return soundOn;
}
