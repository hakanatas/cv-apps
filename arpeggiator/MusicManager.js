import * as Tone from 'tone';
import { SCALES, buildScaleNotes } from './Scales.js';

const ARP_LENGTH = 6; // notes per arpeggio (consecutive scale tones)
export const LANE_COUNT = 12; // pitch zones the hand can select

// Manages the synth voice, master effects, scales and recording.
export class MusicManager {
    constructor() {
        this.isStarted = false;
        this.polySynth = null;
        this.synths = []; // one persistent PolySynth per preset (never disposed)
        this.filter = null;
        this.analyser = null;
        this.stereoDelay = null;
        this.reverb = null;
        this.recorder = null;
        this.isRecording = false;
        // handId -> { pattern, noteIndex }
        this.activePatterns = new Map();
        // handId -> velocity (0..1)
        this.handVolumes = new Map();

        this.scaleIndex = 0;
        this.rootMidi = 48; // C3
        this.scaleNotes = buildScaleNotes(this.rootMidi, SCALES[this.scaleIndex].intervals, LANE_COUNT + ARP_LENGTH);

        this.synthPresets = [
            {
                name: 'Glass',
                options: {
                    harmonicity: 4,
                    modulationIndex: 3,
                    oscillator: { type: 'sine' },
                    envelope: { attack: 0.01, decay: 0.2, sustain: 0.5, release: 1.0 },
                    modulation: { type: 'sine' },
                    modulationEnvelope: { attack: 0.1, decay: 0.01, sustain: 1, release: 0.5 },
                },
            },
            {
                name: 'Saw Pluck',
                options: {
                    harmonicity: 1,
                    modulationIndex: 8,
                    oscillator: { type: 'sawtooth' },
                    envelope: { attack: 0.01, decay: 0.15, sustain: 0.05, release: 0.2 },
                    modulation: { type: 'square' },
                    modulationEnvelope: { attack: 0.05, decay: 0.2, sustain: 0.4, release: 0.6 },
                },
            },
            {
                name: 'FM Keys',
                options: {
                    harmonicity: 2,
                    modulationIndex: 12,
                    oscillator: { type: 'sine' },
                    envelope: { attack: 0.02, decay: 0.3, sustain: 0.2, release: 0.8 },
                    modulation: { type: 'sine' },
                    modulationEnvelope: { attack: 0.05, decay: 0.2, sustain: 0.1, release: 0.8 },
                },
                effects: { reverbWet: 0.3, delayWet: 0.1 },
            },
        ];
        this.currentSynthIndex = 0;
    }

    get laneNotes() {
        return this.scaleNotes.slice(0, LANE_COUNT);
    }
    get scaleName() {
        return SCALES[this.scaleIndex].name;
    }
    get synthName() {
        return this.synthPresets[this.currentSynthIndex].name;
    }

    // Must be called from a user gesture (click) so the AudioContext can start.
    async start() {
        if (this.isStarted) return;
        await Tone.start();

        // Audio chain: synth -> filter -> analyser -> delay -> reverb -> speakers
        this.reverb = new Tone.Reverb({ decay: 5, preDelay: 0.0, wet: 0.8 }).toDestination();
        this.stereoDelay = new Tone.FeedbackDelay('8n', 0.5).connect(this.reverb);
        this.stereoDelay.wet.value = 0;
        this.analyser = new Tone.Analyser('waveform', 1024);
        this.analyser.connect(this.stereoDelay);
        this.filter = new Tone.Filter({ type: 'lowpass', frequency: 8000, rolloff: -12, Q: 1 });
        this.filter.connect(this.analyser);

        // Tap the end of the chain for recording; drums connect themselves later.
        this.recorder = new Tone.Recorder();
        this.reverb.connect(this.recorder);

        // Create one synth per preset up front and never dispose them:
        // disposing a synth while Tone still has scheduled events for it
        // throws "Synth was already disposed" and can stall the audio engine.
        this.synths = this.synthPresets.map((preset) => {
            const synth = new Tone.PolySynth(Tone.FMSynth, preset.options);
            synth.connect(this.filter);
            synth.volume.value = 0;
            return synth;
        });
        this._activateSynth(this.currentSynthIndex);

        this.isStarted = true;
        Tone.Transport.bpm.value = 100;
        Tone.Transport.start();
        console.log('Tone.js AudioContext started and PolySynth is ready.');
    }

    _activateSynth(index) {
        this.polySynth = this.synths[index];
        const preset = this.synthPresets[index];
        this.reverb.wet.value = preset.effects?.reverbWet ?? 0.8;
        this.stereoDelay.wet.value = preset.effects?.delayWet ?? 0;
    }

    // Resumes the AudioContext if the browser suspended it (e.g. tab switch).
    resume() {
        const context = Tone.getContext();
        if (context.state !== 'running') context.resume();
    }

    _arpNotesFor(noteIndex) {
        return this.scaleNotes.slice(noteIndex, noteIndex + ARP_LENGTH);
    }

    startArpeggio(handId, noteIndex) {
        if (!this.polySynth || this.activePatterns.has(handId)) return;
        const pattern = new Tone.Pattern((time, note) => {
            if (!this.polySynth || this.polySynth.disposed) return;
            const velocity = this.handVolumes.get(handId) ?? 0.2;
            this.polySynth.triggerAttackRelease(note, '16n', time, velocity);
        }, this._arpNotesFor(noteIndex), 'upDown');
        pattern.interval = '16n';
        pattern.start(0);
        this.activePatterns.set(handId, { pattern, noteIndex });
    }

    updateArpeggio(handId, noteIndex) {
        const active = this.activePatterns.get(handId);
        if (!this.polySynth || !active || active.noteIndex === noteIndex) return;
        active.pattern.values = this._arpNotesFor(noteIndex);
        active.noteIndex = noteIndex;
    }

    updateArpeggioVolume(handId, velocity) {
        if (!this.polySynth || !this.activePatterns.has(handId)) return;
        const clamped = Math.max(0, Math.min(1, velocity));
        this.handVolumes.set(handId, clamped);
        // Logarithmic scaling for a natural-feeling volume control.
        this.polySynth.volume.value = Tone.gainToDb(clamped);
    }

    stopArpeggio(handId) {
        const active = this.activePatterns.get(handId);
        if (!active) return;
        active.pattern.stop(0);
        active.pattern.dispose();
        this.activePatterns.delete(handId);
        this.handVolumes.delete(handId);
        if (this.activePatterns.size === 0 && this.polySynth) {
            this.polySynth.volume.value = -Infinity;
        }
    }

    // Horizontal hand position (0 = left, 1 = right) sweeps the low-pass filter.
    setFilterPosition(x01) {
        if (!this.filter) return;
        const clamped = Math.max(0, Math.min(1, x01));
        // Deadband: this is called every frame — only schedule a ramp on a real
        // change, otherwise the automation timeline grows unboundedly.
        if (this._lastFilterX !== undefined && Math.abs(clamped - this._lastFilterX) < 0.01) return;
        this._lastFilterX = clamped;
        const freq = 200 * Math.pow(40, clamped); // 200 Hz .. 8 kHz, exponential
        this.filter.frequency.rampTo(freq, 0.1);
    }

    setScale(index) {
        this.scaleIndex = ((index % SCALES.length) + SCALES.length) % SCALES.length;
        this._rebuildNotes();
    }

    setRoot(midi) {
        this.rootMidi = midi;
        this._rebuildNotes();
    }

    _rebuildNotes() {
        this.scaleNotes = buildScaleNotes(this.rootMidi, SCALES[this.scaleIndex].intervals, LANE_COUNT + ARP_LENGTH);
        for (const active of this.activePatterns.values()) {
            active.pattern.values = this._arpNotesFor(active.noteIndex);
        }
    }

    cycleSynth() {
        if (!this.polySynth) return;
        for (const handId of [...this.activePatterns.keys()]) {
            this.stopArpeggio(handId);
        }
        this.polySynth.releaseAll(); // let the old voice's tails end cleanly
        this.currentSynthIndex = (this.currentSynthIndex + 1) % this.synthPresets.length;
        this._activateSynth(this.currentSynthIndex);
    }

    // Toggles recording. Returns the recorded Blob when stopping, null when starting.
    async toggleRecording() {
        if (!this.recorder) return null;
        if (!this.isRecording) {
            this.recorder.start();
            this.isRecording = true;
            return null;
        }
        const blob = await this.recorder.stop();
        this.isRecording = false;
        return blob;
    }

    getAnalyser() {
        return this.analyser;
    }

    getRecorderNode() {
        return this.recorder;
    }
}
