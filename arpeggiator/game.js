import * as THREE from 'three';
import * as Tone from 'tone';
import { HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { MusicManager, LANE_COUNT } from './MusicManager.js';
import { SCALES, ROOTS } from './Scales.js';
import * as drumManager from './DrumManager.js';
import { WaveformVisualizer } from './WaveformVisualizer.js';
import { HandVisualizer } from './HandVisualizer.js';
import { NoteLanes } from './NoteLanes.js';

// Hand roles: slot 0 plays the arpeggio, slot 1 plays the drums.
const MELODY = 0;
const DRUMS = 1;

const BPM_MIN = 70;
const BPM_MAX = 160;

// MediaPipe hand landmark connections (skeleton edges).
const HAND_CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4], // thumb
    [0, 5], [5, 6], [6, 7], [7, 8], // index
    [0, 9], [9, 10], [10, 11], [11, 12], // middle
    [0, 13], [13, 14], [14, 15], [15, 16], // ring
    [0, 17], [17, 18], [18, 19], [19, 20], // pinky
    [5, 9], [9, 13], [13, 17], // palm
];

const LABEL_STYLES = {
    purple: 'rgba(123, 67, 148, 0.9)',
    green: 'rgba(132, 195, 78, 0.9)',
    orange: 'rgba(243, 110, 47, 0.9)',
    red: 'rgba(215, 40, 40, 0.9)',
    white: 'rgba(255, 255, 255, 0.9)',
    black: 'rgba(0, 0, 0, 1)',
    greenText: 'rgba(132, 195, 78, 1)',
};

export class Game {
    constructor(renderDiv) {
        this.renderDiv = renderDiv;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.videoElement = null;
        this.handLandmarker = null;
        this.lastVideoTime = -1;
        this.gameState = 'idle'; // idle, loading, tracking, error
        this.clock = new THREE.Clock();

        this.musicManager = new MusicManager();
        this.waveformVisualizer = null;
        this.handVisualizer = null;
        this.noteLanes = null;

        // Per-role hand state (0 = melody, 1 = drums).
        this.slots = [
            { present: false, isFist: false, smoothed: null },
            { present: false, isFist: false, smoothed: null },
        ];
        this.smoothingFactor = 0.4; // exponential smoothing alpha (smaller = smoother)
        this.lastBpmTarget = null;

        this.beatIndicators = [];
        this.beatIndicatorGroup = null;
        this.lastPulsedBeat = -1;
        this.beatIndicatorColors = {
            kick: new THREE.Color('#D72828'),
            snare: new THREE.Color('#F36E2F'),
            clap: new THREE.Color('#7B4394'),
            hihat: new THREE.Color('#84C34E'),
            off: new THREE.Color('#ffffff'),
        };
        this.waveformColors = [
            new THREE.Color('#7B4394'),
            new THREE.Color('#84C34E'),
            new THREE.Color('#F36E2F'),
            new THREE.Color('#D72828'),
            new THREE.Color('#66ffff'),
        ];

        this.statusContainer = null;
        this.statusText = null;
        this.restartHintText = null;

        this._bindStartOverlay();
    }

    _bindStartOverlay() {
        const overlay = document.getElementById('start-overlay');
        const button = document.getElementById('start-button');
        button.addEventListener('click', () => {
            overlay.classList.add('hidden');
            this._init().catch((error) => {
                console.error('Initialization failed:', error);
                this._showError('Initialization failed. Check console.');
            });
        }, { once: true });
    }

    async _init() {
        this.gameState = 'loading';
        this._setupDOM();
        this._setupThree();
        this._showStatus('LOADING...', 'white', false);
        // Start audio first: we are still inside the user-gesture call chain.
        await this.musicManager.start();
        await drumManager.loadSamples();
        drumManager.startSequence();
        drumManager.connectExtra(this.musicManager.getRecorderNode());
        await this._setupHandTracking();
        await this.videoElement.play();

        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        this.waveformVisualizer = new WaveformVisualizer(this.scene, this.musicManager.getAnalyser(), width, height);
        this.noteLanes = new NoteLanes(this.scene, LANE_COUNT);
        this.noteLanes.setNotes(this.musicManager.laneNotes);
        this.noteLanes.resize(width, height);
        this.handVisualizer = new HandVisualizer(this.scene, HAND_CONNECTIONS);

        this._setupPanel();
        window.addEventListener('resize', this._onResize.bind(this));
        this.renderDiv.addEventListener('click', () => {
            this.musicManager.resume(); // recover if the browser suspended audio
            if (this.gameState === 'error') this._restart();
        });

        this._hideStatus();
        this.gameState = 'tracking';
        this.lastVideoTime = -1;
        this.clock.start();
        this._animate();
        console.log('Tracking started.');
    }

    // --- DOM & Three.js setup ---

    _setupDOM() {
        this.renderDiv.style.position = 'relative';
        this.renderDiv.style.width = '100vw';
        this.renderDiv.style.height = '100vh';
        this.renderDiv.style.overflow = 'hidden';
        this.renderDiv.style.background = '#111';

        this.videoElement = document.createElement('video');
        Object.assign(this.videoElement.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: 'scaleX(-1)', // mirror for intuitive control
            filter: 'grayscale(100%)',
            zIndex: '0',
        });
        this.videoElement.autoplay = true;
        this.videoElement.muted = true;
        this.videoElement.playsInline = true;
        this.renderDiv.appendChild(this.videoElement);

        this.statusContainer = document.createElement('div');
        Object.assign(this.statusContainer.style, {
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: '10',
            display: 'none',
            pointerEvents: 'none',
            textAlign: 'center',
            color: 'white',
            textShadow: '2px 2px 4px black',
            fontFamily: '"Arial Black", Gadget, sans-serif',
        });
        this.statusText = document.createElement('div');
        this.statusText.style.fontSize = 'clamp(36px, 10vw, 72px)';
        this.statusText.style.fontWeight = 'bold';
        this.statusText.style.marginBottom = '10px';
        this.statusContainer.appendChild(this.statusText);
        this.restartHintText = document.createElement('div');
        this.restartHintText.innerText = '(click to restart tracking)';
        this.restartHintText.style.fontSize = 'clamp(16px, 3vw, 24px)';
        this.restartHintText.style.opacity = '0.8';
        this.statusContainer.appendChild(this.restartHintText);
        this.renderDiv.appendChild(this.statusContainer);
    }

    _setupThree() {
        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(width / -2, width / 2, height / 2, height / -2, 1, 1000);
        this.camera.position.z = 100;
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        Object.assign(this.renderer.domElement.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            zIndex: '1',
        });
        this.renderDiv.appendChild(this.renderer.domElement);

        // --- Beat indicators ---
        this.beatIndicatorGroup = new THREE.Group();
        this.scene.add(this.beatIndicatorGroup);
        const indicatorGeometry = new THREE.PlaneGeometry(20, 20);
        for (let i = 0; i < 16; i++) {
            const material = new THREE.MeshBasicMaterial({
                color: this.beatIndicatorColors.off,
                transparent: true,
                opacity: 0.5,
            });
            const indicator = new THREE.Mesh(indicatorGeometry, material);
            this.beatIndicatorGroup.add(indicator);
            this.beatIndicators.push(indicator);
        }
        this._positionBeatIndicators();
    }

    async _setupHandTracking() {
        try {
            console.log('Setting up hand tracking...');
            const vision = await FilesetResolver.forVisionTasks(
                'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
            );
            this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
                baseOptions: {
                    modelAssetPath:
                        'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
                    delegate: 'GPU',
                },
                numHands: 2,
                runningMode: 'VIDEO',
            });
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
                audio: false,
            });
            this.videoElement.srcObject = stream;
            await new Promise((resolve) => {
                this.videoElement.onloadedmetadata = () => resolve();
            });
        } catch (error) {
            console.error('Error setting up hand tracking or webcam:', error);
            this._showError(`Webcam/Hand Tracking Error: ${error.message}. Please allow camera access.`);
            throw error;
        }
    }

    // --- Control panel ---

    _setupPanel() {
        const panel = document.getElementById('control-panel');
        panel.classList.remove('hidden');

        const scaleSelect = document.getElementById('scale-select');
        SCALES.forEach((scale, i) => {
            const option = document.createElement('option');
            option.value = i;
            option.textContent = scale.name;
            scaleSelect.appendChild(option);
        });
        scaleSelect.addEventListener('change', () => {
            this.musicManager.setScale(Number(scaleSelect.value));
            this.noteLanes.setNotes(this.musicManager.laneNotes);
        });

        const rootSelect = document.getElementById('root-select');
        ROOTS.forEach((root) => {
            const option = document.createElement('option');
            option.value = root.midi;
            option.textContent = root.name;
            rootSelect.appendChild(option);
        });
        rootSelect.addEventListener('change', () => {
            this.musicManager.setRoot(Number(rootSelect.value));
            this.noteLanes.setNotes(this.musicManager.laneNotes);
        });

        document.getElementById('synth-btn').addEventListener('click', () => {
            this.musicManager.cycleSynth();
            this._updatePanel();
        });
        document.getElementById('bank-btn').addEventListener('click', () => {
            drumManager.cycleBank();
            this._updatePanel();
        });

        const bpmSlider = document.getElementById('bpm-slider');
        bpmSlider.addEventListener('input', () => {
            Tone.Transport.bpm.rampTo(Number(bpmSlider.value), 0.1);
            document.getElementById('bpm-value').textContent = bpmSlider.value;
        });

        const recordBtn = document.getElementById('record-btn');
        recordBtn.addEventListener('click', async () => {
            recordBtn.disabled = true;
            try {
                const blob = await this.musicManager.toggleRecording();
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'arpeggiator-jam.webm';
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                }
            } finally {
                recordBtn.disabled = false;
            }
            recordBtn.textContent = this.musicManager.isRecording ? '■ Stop & Save' : '● Record';
            recordBtn.classList.toggle('recording', this.musicManager.isRecording);
        });

        this._updatePanel();
    }

    _updatePanel() {
        document.getElementById('synth-btn').textContent = `Synth: ${this.musicManager.synthName}`;
        document.getElementById('bank-btn').textContent = `Beat: ${drumManager.getBankName()}`;
        const bpm = Math.round(Tone.Transport.bpm.value);
        document.getElementById('bpm-value').textContent = bpm;
        document.getElementById('bpm-slider').value = bpm;
    }

    // --- Hand processing ---

    _updateHands() {
        if (
            !this.handLandmarker ||
            !this.videoElement.srcObject ||
            this.videoElement.readyState < 2 ||
            this.videoElement.videoWidth === 0
        ) {
            return;
        }
        const videoTime = this.videoElement.currentTime;
        if (videoTime <= this.lastVideoTime) return;
        this.lastVideoTime = videoTime;

        try {
            const results = this.handLandmarker.detectForVideo(this.videoElement, performance.now());
            const videoParams = this._getVisibleVideoParameters();
            if (!videoParams) return;
            const width = this.renderDiv.clientWidth;
            const height = this.renderDiv.clientHeight;

            const assignments = this._assignHands(results);
            this._processMelodyHand(assignments[MELODY], videoParams, width, height);
            this._processDrumHand(assignments[DRUMS], videoParams, width, height);
        } catch (error) {
            console.error('Error during hand detection:', error);
        }
    }

    // Maps detected hands to roles: the user's right hand plays melody,
    // the left hand plays drums. Falls back to detection order when the
    // handedness label is missing or both hands share a label.
    _assignHands(results) {
        const landmarksArr = results.landmarks || [];
        const handednessArr = results.handednesses || results.handedness || [];
        const slots = [null, null];
        for (let i = 0; i < landmarksArr.length && i < 2; i++) {
            const category = handednessArr[i]?.[0];
            // MediaPipe labels handedness assuming a mirrored (selfie) image; our raw
            // webcam frame is not mirrored, so the label is the opposite of the user's hand.
            const userHand = category ? (category.categoryName === 'Left' ? 'right' : 'left') : null;
            const preferred = userHand === 'left' ? DRUMS : MELODY;
            if (!slots[preferred]) {
                slots[preferred] = landmarksArr[i];
            } else if (!slots[1 - preferred]) {
                slots[1 - preferred] = landmarksArr[i];
            }
        }
        return slots;
    }

    _smoothLandmarks(slotIndex, rawLandmarks) {
        const slot = this.slots[slotIndex];
        if (!slot.smoothed || slot.smoothed.length !== rawLandmarks.length || !slot.present) {
            slot.smoothed = rawLandmarks.map((lm) => ({ x: lm.x, y: lm.y, z: lm.z }));
            return slot.smoothed;
        }
        const a = this.smoothingFactor;
        for (let i = 0; i < rawLandmarks.length; i++) {
            const prev = slot.smoothed[i];
            const lm = rawLandmarks[i];
            prev.x = a * lm.x + (1 - a) * prev.x;
            prev.y = a * lm.y + (1 - a) * prev.y;
            prev.z = a * lm.z + (1 - a) * prev.z;
        }
        return slot.smoothed;
    }

    _processMelodyHand(rawLandmarks, videoParams, width, height) {
        const slot = this.slots[MELODY];
        if (!rawLandmarks) {
            if (slot.present) {
                this.musicManager.stopArpeggio(MELODY);
                this.noteLanes.setActive(null);
                this.handVisualizer.hide(MELODY);
            }
            slot.present = false;
            slot.isFist = false;
            return;
        }

        const landmarks = this._smoothLandmarks(MELODY, rawLandmarks);
        const wasPresent = slot.present;
        slot.present = true;

        const palmNorm = this._toVisibleNorm(landmarks[9], videoParams);
        const points3D = landmarks.map((lm) => this._landmarkToScreen(lm, videoParams, width, height));

        const isFistNow = this._isFist(landmarks);
        if (isFistNow && !slot.isFist) {
            this.musicManager.cycleSynth();
            this._updatePanel();
        }
        slot.isFist = isFistNow;

        const noteIndex = Math.max(0, Math.min(LANE_COUNT - 1, Math.floor((1 - palmNorm.y) * LANE_COUNT)));
        const color = this.waveformColors[noteIndex % this.waveformColors.length];
        this.waveformVisualizer.updateColor(color);
        this.noteLanes.setActive(isFistNow ? null : noteIndex, color);

        // Horizontal position sweeps the low-pass filter (mirrored view).
        this.musicManager.setFilterPosition(1 - palmNorm.x);

        // Pinch distance (thumb tip to index tip) controls volume.
        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const dx = thumbTip.x - indexTip.x;
        const dy = thumbTip.y - indexTip.y;
        const velocity = Math.max(0, Math.min(1.0, Math.sqrt(dx * dx + dy * dy) * 5));

        const wristPos = points3D[0];
        const labelAnchor = { x: wristPos.x, y: wristPos.y + 60 };
        let primaryLabel, secondaryLabel = null, pinch = null;
        if (isFistNow) {
            primaryLabel = {
                text: `SYNTH: ${this.musicManager.synthName}`,
                bg: LABEL_STYLES.purple,
                fg: LABEL_STYLES.greenText,
                fontsize: 22,
                position: labelAnchor,
            };
        } else {
            primaryLabel = {
                text: `Pitch: ${this.musicManager.laneNotes[noteIndex]}`,
                bg: LABEL_STYLES.green,
                fg: LABEL_STYLES.black,
                position: labelAnchor,
            };
            const midPoint = new THREE.Vector3().lerpVectors(points3D[4], points3D[8], 0.5);
            secondaryLabel = {
                text: `Volume: ${Math.round(velocity * 100)}%`,
                bg: LABEL_STYLES.orange,
                fg: 'rgba(255,255,255,1)',
                position: midPoint,
            };
            pinch = { a: points3D[4], b: points3D[8] };
        }
        this.handVisualizer.update(MELODY, points3D, { pinch, primaryLabel, secondaryLabel });

        if (!isFistNow) {
            if (!wasPresent || !this.musicManager.activePatterns.has(MELODY)) {
                this.musicManager.startArpeggio(MELODY, noteIndex);
            } else {
                this.musicManager.updateArpeggio(MELODY, noteIndex);
            }
            this.musicManager.updateArpeggioVolume(MELODY, velocity);
        } else {
            this.musicManager.stopArpeggio(MELODY);
        }
    }

    _processDrumHand(rawLandmarks, videoParams, width, height) {
        const slot = this.slots[DRUMS];
        if (!rawLandmarks) {
            if (slot.present) {
                drumManager.updateActiveDrums({});
                this.handVisualizer.hide(DRUMS);
            }
            slot.present = false;
            slot.isFist = false;
            return;
        }

        const landmarks = this._smoothLandmarks(DRUMS, rawLandmarks);
        slot.present = true;

        const palmNorm = this._toVisibleNorm(landmarks[9], videoParams);
        const points3D = landmarks.map((lm) => this._landmarkToScreen(lm, videoParams, width, height));

        const isFistNow = this._isFist(landmarks);
        if (isFistNow && !slot.isFist) {
            drumManager.cycleBank();
            this._updatePanel();
        }
        slot.isFist = isFistNow;

        const fingerStates = isFistNow ? {} : this._getFingerStates(landmarks);
        drumManager.updateActiveDrums(fingerStates);

        // Hand height sets the tempo (quantized to 2 BPM steps so we don't
        // schedule a new ramp every frame while the hand hovers).
        const targetBpm = 2 * Math.round((BPM_MIN + (1 - palmNorm.y) * (BPM_MAX - BPM_MIN)) / 2);
        if (targetBpm !== this.lastBpmTarget) {
            this.lastBpmTarget = targetBpm;
            Tone.Transport.bpm.rampTo(targetBpm, 0.2);
            document.getElementById('bpm-value').textContent = targetBpm;
            document.getElementById('bpm-slider').value = targetBpm;
        }

        const wristPos = points3D[0];
        let primaryLabel;
        if (isFistNow) {
            primaryLabel = {
                text: `BEAT: ${drumManager.getBankName()}`,
                bg: LABEL_STYLES.purple,
                fg: LABEL_STYLES.greenText,
                fontsize: 22,
                position: { x: wristPos.x, y: wristPos.y + 60 },
            };
        } else {
            const activeNames = Object.entries(fingerStates)
                .filter(([, isUp]) => isUp)
                .map(([finger]) => drumManager.getFingerToDrumMap()[finger])
                .join(', ');
            primaryLabel = {
                text: `Drums: ${activeNames || 'None'}`,
                bg: LABEL_STYLES.red,
                fg: 'rgba(255,255,255,1)',
                position: { x: wristPos.x, y: wristPos.y + 60 },
            };
        }
        const secondaryLabel = {
            text: `BPM: ${targetBpm}`,
            bg: LABEL_STYLES.white,
            fg: LABEL_STYLES.black,
            fontsize: 16,
            position: { x: wristPos.x, y: wristPos.y + 110 },
        };
        this.handVisualizer.update(DRUMS, points3D, { primaryLabel, secondaryLabel });
    }

    // --- Gesture helpers ---

    _getFingerStates(landmarks) {
        const fingertips = { index: 8, middle: 12, ring: 16, pinky: 20 };
        const jointsBelowTip = { index: 6, middle: 10, ring: 14, pinky: 18 };
        const states = {};
        for (const [finger, tipIndex] of Object.entries(fingertips)) {
            const jointIndex = jointsBelowTip[finger];
            states[finger] =
                landmarks[tipIndex] && landmarks[jointIndex]
                    ? landmarks[tipIndex].y < landmarks[jointIndex].y
                    : false;
        }
        return states;
    }

    _isFist(landmarks) {
        if (!landmarks || landmarks.length < 21) return false;
        const palmCenter = landmarks[9]; // middle finger MCP as palm proxy
        const fistThreshold = 0.1; // normalized distance; smaller = stricter
        for (const tipIndex of [4, 8, 12, 16, 20]) {
            const tip = landmarks[tipIndex];
            const dx = tip.x - palmCenter.x;
            const dy = tip.y - palmCenter.y;
            if (Math.sqrt(dx * dx + dy * dy) > fistThreshold) return false;
        }
        return true;
    }

    // --- Coordinate helpers ---

    // Normalized landmark -> position within the visible (cover-cropped) video area, clamped 0..1.
    _toVisibleNorm(landmark, videoParams) {
        const x = (landmark.x * videoParams.videoNaturalWidth - videoParams.offsetX) / videoParams.visibleWidth;
        const y = (landmark.y * videoParams.videoNaturalHeight - videoParams.offsetY) / videoParams.visibleHeight;
        return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }

    _landmarkToScreen(landmark, videoParams, width, height) {
        const norm = this._toVisibleNorm(landmark, videoParams);
        return new THREE.Vector3(
            (1 - norm.x) * width - width / 2, // mirrored
            (1 - norm.y) * height - height / 2,
            1.1
        );
    }

    _getVisibleVideoParameters() {
        if (!this.videoElement || this.videoElement.videoWidth === 0 || this.videoElement.videoHeight === 0) {
            return null;
        }
        const vNatW = this.videoElement.videoWidth;
        const vNatH = this.videoElement.videoHeight;
        const rW = this.renderDiv.clientWidth;
        const rH = this.renderDiv.clientHeight;
        if (rW === 0 || rH === 0) return null;

        const videoAR = vNatW / vNatH;
        const renderDivAR = rW / rH;
        let offsetX, offsetY, visibleWidth, visibleHeight;
        if (videoAR > renderDivAR) {
            // Video wider than the container: scaled to fit height, cropped horizontally.
            const scale = rH / vNatH;
            const croppedX = (vNatW * scale - rW) / scale;
            offsetX = croppedX / 2;
            offsetY = 0;
            visibleWidth = vNatW - croppedX;
            visibleHeight = vNatH;
        } else {
            // Video taller: scaled to fit width, cropped vertically.
            const scale = rW / vNatW;
            const croppedY = (vNatH * scale - rH) / scale;
            offsetX = 0;
            offsetY = croppedY / 2;
            visibleWidth = vNatW;
            visibleHeight = vNatH - croppedY;
        }
        if (visibleWidth <= 0 || visibleHeight <= 0) {
            return {
                offsetX: 0,
                offsetY: 0,
                visibleWidth: vNatW,
                visibleHeight: vNatH,
                videoNaturalWidth: vNatW,
                videoNaturalHeight: vNatH,
            };
        }
        return { offsetX, offsetY, visibleWidth, visibleHeight, videoNaturalWidth: vNatW, videoNaturalHeight: vNatH };
    }

    // --- Status / errors ---

    _showStatus(message, color = 'white', showRestartHint = false) {
        this.statusContainer.style.display = 'block';
        this.statusText.innerText = message;
        this.statusText.style.color = color;
        this.restartHintText.style.display = showRestartHint ? 'block' : 'none';
    }

    _hideStatus() {
        this.statusContainer.style.display = 'none';
    }

    _showError(message) {
        if (this.statusContainer) {
            this._showStatus(`ERROR: ${message}`, 'orange', true);
        }
        this.gameState = 'error';
        this.handVisualizer?.hide(MELODY);
        this.handVisualizer?.hide(DRUMS);
    }

    _restart() {
        console.log('Restarting tracking...');
        this._hideStatus();
        this.gameState = 'tracking';
        this.lastVideoTime = -1;
        this.clock.start();
    }

    // --- Layout / render loop ---

    _onResize() {
        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        this.camera.left = width / -2;
        this.camera.right = width / 2;
        this.camera.top = height / 2;
        this.camera.bottom = height / -2;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
        this._positionBeatIndicators();
        this.waveformVisualizer?.updatePosition(width, height);
        this.noteLanes?.resize(width, height);
    }

    _positionBeatIndicators() {
        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        const totalWidth = width * 0.8; // match the waveform width
        const spacing = totalWidth / 16;
        const startX = -totalWidth / 2 + spacing / 2;
        const yPos = -height / 2 + 150;
        this.beatIndicators.forEach((indicator, i) => {
            indicator.position.set(startX + i * spacing, yPos, 1);
        });
    }

    _updateBeatIndicator() {
        const currentBeat = drumManager.getCurrentBeat();
        const beatProgress = (Tone.Transport.progress * 16) % 1;
        const pulse = 1.5 + 0.5 * Math.cos(beatProgress * Math.PI * 2);
        const activeDrums = drumManager.getActiveDrums();
        const drumPattern = drumManager.getDrumPattern();
        const drumPriority = ['kick', 'snare', 'clap', 'hihat'];

        this.beatIndicators.forEach((indicator, i) => {
            let stepColor = this.beatIndicatorColors.off;
            let isHit = false;
            for (const drum of drumPriority) {
                if (activeDrums.has(drum) && drumPattern[drum][i]) {
                    stepColor = this.beatIndicatorColors[drum];
                    isHit = true;
                    break;
                }
            }
            indicator.material.color.set(stepColor);
            indicator.material.opacity = isHit ? 0.9 : 0.5;
            if (i === currentBeat) {
                indicator.scale.set(pulse, pulse, 1);
            } else {
                indicator.scale.set(1, 1, 1);
            }
        });

        // Thump the waveform on each kick hit.
        if (currentBeat !== this.lastPulsedBeat) {
            this.lastPulsedBeat = currentBeat;
            if (activeDrums.has('kick') && drumPattern.kick[currentBeat]) {
                this.waveformVisualizer?.pulse(0.8);
            }
        }
    }

    _animate() {
        requestAnimationFrame(this._animate.bind(this));
        if (this.gameState === 'tracking') {
            this._updateHands();
            this._updateBeatIndicator();
            this.waveformVisualizer?.update();
        }
        this.renderer.render(this.scene, this.camera);
    }
}
