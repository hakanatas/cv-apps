import * as THREE from 'three';
import { HandLandmarker, FilesetResolver } from 'https://esm.sh/@mediapipe/tasks-vision@0.10.14';
import { SETS, DEFAULT_SET, buildRound } from './sets.js';
import * as Effects from './effects.js';

const ROUND_SIZE = 8;
// Pinch detection normalized by hand size (thumb-index distance / wrist-palm distance),
// with hysteresis: a tracked spike during a fast move must not drop the card.
const PINCH_START = 0.5;
const PINCH_RELEASE = 0.85;
const RELEASE_FRAMES = 4;     // open-hand frames in a row before the card is released
const HAND_LOST_GRACE_MS = 350; // keep the drag alive this long if the tracker loses the hand

// "Ayır & Öğren": one hand holds a rotating circle of cards, the other hand
// pinches a card and drags it into one of two category boxes. Correct drops
// score points; wrong drops bounce the card back to the circle.
export class Game {
    constructor(renderDiv) {
        this.renderDiv = renderDiv;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.videoElement = null;
        this.handLandmarker = null;
        this.lastVideoTime = -1;
        this.hands = [];
        this.clock = new THREE.Clock();
        this.lastLandmarkPositions = [[], []];
        this.smoothingFactor = 0.6;

        // Round / set state
        this.setId = DEFAULT_SET;
        this.roundItems = [];
        this.cardTextures = [];
        this.score = 0;
        this.streak = 0;
        this.correctCount = 0;
        this.wrongCount = 0;
        this.roundActive = false;

        // Card circle
        this.imageCircle = null;
        this.imageSprites = [];
        this.imageRotationSpeed = 0.5;
        this.currentRotation = 0;
        this.minCircleRadius = 40;
        this.maxCircleRadius = 230;
        this.imageCount = ROUND_SIZE;
        this.imageSize = 150;

        // Radar HUD
        this.radarHUD = null;
        this.radarCircle = null;
        this.radarCrosshairs = null;
        this.radarMaterial = null;
        this.lastRadarRadius = -1;

        // Drag and drop
        this.draggedImage = null;
        this.isDragging = false;
        this.dragOffset = new THREE.Vector3();
        this.releaseFrames = 0;
        this.dragLostAt = null;

        // Particles
        this.particles = [];
        this.particleTextures = {};

        // DOM
        this.ui = {};

        this._setupStartOverlay();
    }

    // --- Start overlay & set picker ---

    _setupStartOverlay() {
        const overlay = document.getElementById('start-overlay');
        const button = document.getElementById('start-button');
        for (const select of [document.getElementById('set-select'), document.getElementById('set-select-again')]) {
            for (const [id, set] of Object.entries(SETS)) {
                const option = document.createElement('option');
                option.value = id;
                option.textContent = set.title;
                if (id === DEFAULT_SET) option.selected = true;
                select.appendChild(option);
            }
        }
        button.addEventListener('click', () => {
            this.setId = document.getElementById('set-select').value;
            overlay.classList.add('hidden');
            Effects.unlockAudio();
            this._init().catch((error) => {
                console.error('Initialization failed:', error);
                this._setFeedback('Kamera açılamadı — izin verip sayfayı yenile.');
            });
        }, { once: true });
    }

    async _init() {
        this._setupDOM();
        this._setupThree();
        this._setupParticleTextures();
        this._setupResultsOverlay();
        this._setFeedback('Kamera ve el takibi başlatılıyor…');
        await this._setupHandTracking();
        await this.videoElement.play();
        window.addEventListener('resize', this._onResize.bind(this));
        await this._startRound();
        this.clock.start();
        this._animate();
    }

    _setupDOM() {
        this.videoElement = document.getElementById('webcam-video');
        this.ui = {
            setTitle: document.getElementById('set-title'),
            scoreLine: document.getElementById('score-line'),
            feedbackLine: document.getElementById('feedback-line'),
            boxA: document.getElementById('box-a'),
            boxB: document.getElementById('box-b'),
            resultsOverlay: document.getElementById('game-over-overlay'),
            resultTitle: document.getElementById('result-title'),
            resultText: document.getElementById('result-text'),
            restartButton: document.getElementById('restart-button'),
            setSelectAgain: document.getElementById('set-select-again'),
        };
    }

    _setupResultsOverlay() {
        this.ui.restartButton.addEventListener('click', () => {
            this.setId = this.ui.setSelectAgain.value;
            this.ui.resultsOverlay.classList.add('hidden');
            this._startRound();
        });
    }

    // --- Round flow ---

    async _startRound() {
        const set = SETS[this.setId];
        this.roundActive = false;
        this.score = 0;
        this.streak = 0;
        this.correctCount = 0;
        this.wrongCount = 0;
        this.isDragging = false;
        this.draggedImage = null;
        this.releaseFrames = 0;
        this.dragLostAt = null;
        this.dragOffset = new THREE.Vector3();
        this.currentRotation = 0;

        this._clearAllParticles();
        this._clearImageSprites();
        this._clearRadarHUD();

        this.roundItems = buildRound(this.setId, ROUND_SIZE);
        this.imageCount = this.roundItems.length;
        this.cardTextures = await this._buildCardTextures(this.roundItems);

        this._setupImageCircle();
        this._setupRadarHUD();

        this.ui.setTitle.textContent = set.title.toLocaleUpperCase('tr-TR');
        this.ui.boxA.textContent = set.categories[0].label;
        this.ui.boxB.textContent = set.categories[1].label;
        this.ui.setSelectAgain.value = this.setId;
        this._updateScoreUi();
        this._setFeedback('Elini göster ve başla!');
        Effects.speak(`${set.title} Kartları doğru kutuya sürükle.`);
        this.roundActive = true;
    }

    _categoryPlain(index) {
        // "MEYVE 🍎" -> "meyve"
        return SETS[this.setId].categories[index].label
            .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
            .trim()
            .toLocaleLowerCase('tr-TR');
    }

    _updateScoreUi() {
        this.ui.scoreLine.textContent =
            `PUAN ${this.score} · SERİ ${this.streak} · ${this.correctCount}/${this.imageCount}`;
    }

    _setFeedback(text, color = '#007bff') {
        this.ui.feedbackLine.textContent = text;
        this.ui.feedbackLine.style.color = color;
    }

    _flashBox(zone, className) {
        const box = zone === 0 ? this.ui.boxA : this.ui.boxB;
        box.classList.add(className);
        setTimeout(() => box.classList.remove(className), 500);
    }

    _onCorrect(sprite, zone) {
        const item = sprite.userData.item;
        const worldPos = new THREE.Vector3();
        sprite.getWorldPosition(worldPos);
        this._createParticleEffect(worldPos.x, worldPos.y, 'star');

        if (sprite.parent) sprite.parent.remove(sprite);
        const index = this.imageSprites.indexOf(sprite);
        if (index > -1) this.imageSprites.splice(index, 1);
        sprite.material.dispose();

        this.score += 10 + this.streak * 2;
        this.streak++;
        this.correctCount++;
        this._updateScoreUi();
        this._flashBox(zone, 'hit-correct');
        Effects.playCorrect();

        const line = `${item.name} — ${this._categoryPlain(zone)}!`;
        this._setFeedback(`✅ ${line}`, '#1e8e3e');
        const phrases = [];
        if (item.say) phrases.push(item.say);
        phrases.push({ text: line, lang: 'tr-TR' });
        Effects.speak(phrases);

        this._checkRoundOver();
    }

    _onWrong(sprite, zone) {
        const item = sprite.userData.item;
        const worldPos = new THREE.Vector3();
        sprite.getWorldPosition(worldPos);
        this._createParticleEffect(worldPos.x, worldPos.y, 'boom');

        // Bounce the card back into the circle
        this._returnToCircle(sprite);
        sprite.material.color.set(0xff7070);
        setTimeout(() => sprite.material.color.set(0xffffff), 700);

        this.streak = 0;
        this.wrongCount++;
        this._updateScoreUi();
        this._flashBox(zone, 'hit-wrong');
        Effects.playWrong();

        const line = `Hayır — ${item.name} bir ${this._categoryPlain(item.cat)}!`;
        this._setFeedback(`❌ ${line}`, '#c62828');
        Effects.speak(line);
    }

    _checkRoundOver() {
        if (!this.roundActive || this.imageSprites.length > 0) return;
        this.roundActive = false;
        const total = this.imageCount;
        this.ui.resultTitle.textContent = this.wrongCount === 0 ? 'Mükemmel! 🏆' : 'Tur bitti! 🎉';
        this.ui.resultText.textContent =
            `Puan: ${this.score}\nDoğru: ${this.correctCount}/${total} · Yanlış deneme: ${this.wrongCount}`;
        this.ui.resultsOverlay.classList.remove('hidden');
        Effects.playFanfare();
        Effects.speak(this.wrongCount === 0
            ? `Mükemmel! Hiç hata yapmadan ${this.score} puan topladın.`
            : `Tur bitti. ${this.score} puan topladın.`);
    }

    // --- Card textures ---

    async _buildCardTextures(items) {
        const loader = new THREE.TextureLoader();
        return Promise.all(items.map((item) => {
            if (item.kind !== 'image') return Promise.resolve(this._createCardTexture(item));
            return new Promise((resolve) => {
                loader.load(item.value, (texture) => {
                    texture.generateMipmaps = false;
                    texture.minFilter = THREE.LinearFilter;
                    texture.magFilter = THREE.LinearFilter;
                    resolve(texture);
                }, undefined, () => {
                    console.warn(`Could not load ${item.value}, using a text card`);
                    resolve(this._createCardTexture({ kind: 'text', value: item.name }));
                });
            });
        }));
    }

    _createCardTexture(item) {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Card: white rounded rectangle with a dark border
        const pad = 10;
        const radius = 28;
        ctx.beginPath();
        ctx.roundRect(pad, pad, size - pad * 2, size - pad * 2, radius);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 8;
        ctx.strokeStyle = '#222222';
        ctx.stroke();

        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#111111';
        if (item.kind === 'emoji') {
            ctx.font = '150px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
            ctx.fillText(item.value, size / 2, size / 2 + 8);
        } else {
            const length = item.value.length;
            const fontSize = length <= 2 ? 150 : length <= 4 ? 96 : length <= 6 ? 70 : 52;
            ctx.font = `bold ${fontSize}px Arial, sans-serif`;
            ctx.fillText(item.value, size / 2, size / 2 + 4, size - 40);
        }

        const texture = new THREE.CanvasTexture(canvas);
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        return texture;
    }

    // --- Circle of cards ---

    _setupImageCircle() {
        if (this.imageCircle) this.scene.remove(this.imageCircle);
        this.imageCircle = new THREE.Group();
        this.imageCircle.visible = false;
        this.scene.add(this.imageCircle);
        this.imageSprites = [];

        for (let i = 0; i < this.imageCount; i++) {
            const texture = this.cardTextures[i];
            const material = new THREE.SpriteMaterial({ map: texture, transparent: true, alphaTest: 0.1 });
            const sprite = new THREE.Sprite(material);

            const image = texture.image;
            let aspectRatio = 1;
            if (image && image.width && image.height) aspectRatio = image.width / image.height;
            if (aspectRatio >= 1) {
                sprite.scale.set(this.imageSize, this.imageSize / aspectRatio, 1);
            } else {
                sprite.scale.set(this.imageSize * aspectRatio, this.imageSize, 1);
            }

            sprite.userData = {
                item: this.roundItems[i],
                isDetached: false,
                circleIndex: i,
            };
            this.imageCircle.add(sprite);
            this.imageSprites.push(sprite);
        }
    }

    _clearImageSprites() {
        for (const sprite of this.imageSprites) {
            if (sprite.parent) sprite.parent.remove(sprite);
            if (sprite.material) sprite.material.dispose();
        }
        this.imageSprites = [];
    }

    _currentCircleRadius() {
        const landmarks = this.hands[0]?.landmarks;
        if (!landmarks) return this.minCircleRadius;
        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const distance = Math.hypot(thumbTip.x - indexTip.x, thumbTip.y - indexTip.y, thumbTip.z - indexTip.z);
        const normalized = Math.min(Math.max(distance, 0.02), 0.15);
        return THREE.MathUtils.mapLinear(normalized, 0.02, 0.15, this.minCircleRadius, this.maxCircleRadius);
    }

    _updateImageCircle(deltaTime) {
        if (!this.hands[0] || !this.hands[0].landmarks) {
            this.imageCircle.visible = false;
            if (this.radarHUD) this.radarHUD.visible = false;
            return;
        }

        const palmCenter = this.hands[0].landmarks[9];
        const circleRadius = this._currentCircleRadius();
        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        const palmX = (1 - palmCenter.x) * width - width / 2;
        const palmY = (1 - palmCenter.y) * height - height / 2;
        this.imageCircle.position.set(palmX, palmY, 2);
        this.imageCircle.visible = true;

        this._updateRadarHUD(circleRadius);

        this.currentRotation += this.imageRotationSpeed * deltaTime;
        for (const sprite of this.imageSprites) {
            if (sprite.userData.isDetached || sprite.parent !== this.imageCircle) continue;
            if (this.isDragging && sprite === this.draggedImage) continue;
            const angle = (sprite.userData.circleIndex / this.imageCount) * Math.PI * 2 + this.currentRotation;
            sprite.position.set(Math.cos(angle) * circleRadius, Math.sin(angle) * circleRadius, 0);
        }
    }

    // --- Radar HUD ---

    _setupRadarHUD() {
        this.radarHUD = new THREE.Group();
        this.radarHUD.visible = false;
        this.scene.add(this.radarHUD);
        this.radarMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8 });
        this.lastRadarRadius = -1;
        this._createRadarCircle(this.minCircleRadius);
        this._createDynamicRadarElements(this.minCircleRadius);
        this._createRangeRings();
    }

    _clearRadarHUD() {
        if (!this.radarHUD) return;
        this.scene.remove(this.radarHUD);
        this.radarHUD.traverse((child) => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        this.radarHUD = null;
        this.radarCircle = null;
        this.radarCrosshairs = null;
        this.radarMaterial = null;
    }

    _createRadarCircle(radius) {
        if (this.radarCircle) {
            this.radarHUD.remove(this.radarCircle);
            this.radarCircle.geometry.dispose();
        }
        const geometry = new THREE.RingGeometry(radius - 1, radius + 1, 64);
        const material = new THREE.MeshBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 1.0, side: THREE.DoubleSide });
        this.radarCircle = new THREE.Mesh(geometry, material);
        this.radarCircle.position.z = -0.1;
        this.radarHUD.add(this.radarCircle);
    }

    _createDynamicRadarElements(radius) {
        if (this.radarCrosshairs) {
            this.radarHUD.remove(this.radarCrosshairs);
            this.radarCrosshairs.traverse((child) => {
                if (child.geometry) child.geometry.dispose();
                if (child.material && child.material !== this.radarMaterial) child.material.dispose();
            });
        }
        const group = new THREE.Group();
        const length = radius * 1.3;
        const lines = [
            [[-length, 0], [length, 0]],
            [[0, -length], [0, length]],
            [[-length, -length], [length, length]],
            [[-length, length], [length, -length]],
        ];
        lines.forEach(([a, b], i) => {
            const geometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(a[0], a[1], 0), new THREE.Vector3(b[0], b[1], 0),
            ]);
            const material = i < 2 ? this.radarMaterial : this.radarMaterial.clone();
            if (i >= 2) material.opacity = 0.6;
            group.add(new THREE.Line(geometry, material));
        });

        const bracketSize = radius * 0.2;
        const bracketDistance = radius * 1.3;
        for (const corner of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
            const cx = corner[0] * bracketDistance;
            const cy = corner[1] * bracketDistance;
            const material = this.radarMaterial.clone();
            material.opacity = 0.6;
            const h = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(cx, cy, 0), new THREE.Vector3(cx - corner[0] * bracketSize, cy, 0),
            ]);
            const v = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(cx, cy, 0), new THREE.Vector3(cx, cy - corner[1] * bracketSize, 0),
            ]);
            group.add(new THREE.Line(h, material));
            group.add(new THREE.Line(v, material));
        }
        this.radarCrosshairs = group;
        this.radarHUD.add(group);
    }

    _createRangeRings() {
        const ringGroup = new THREE.Group();
        for (let i = 1; i <= 3; i++) {
            const ringRadius = (this.maxCircleRadius / 3) * i * 0.6;
            const geometry = new THREE.RingGeometry(ringRadius - 0.5, ringRadius + 0.5, 32);
            const material = new THREE.MeshBasicMaterial({ color: 0x00ccff, transparent: true, opacity: 0.6, side: THREE.DoubleSide });
            const ring = new THREE.Mesh(geometry, material);
            ring.position.z = -0.2;
            ringGroup.add(ring);
        }
        this.radarHUD.add(ringGroup);
    }

    _updateRadarHUD(circleRadius) {
        if (!this.radarHUD) return;
        // Rebuilding the geometry every frame was wasteful — only when the radius really changed.
        if (Math.abs(circleRadius - this.lastRadarRadius) > 2) {
            this._createRadarCircle(circleRadius);
            this._createDynamicRadarElements(circleRadius);
            this.lastRadarRadius = circleRadius;
        }
        this.radarHUD.position.copy(this.imageCircle.position);
        this.radarHUD.position.z = -1;
        this.radarHUD.visible = this.imageCircle.visible;
    }

    // --- Particles ---

    _setupParticleTextures() {
        this.particleTextures.star = this._createEmojiTexture('⭐');
        this.particleTextures.boom = this._createEmojiTexture('💥');
    }

    _createEmojiTexture(emojiChar) {
        const canvas = document.createElement('canvas');
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.font = '48px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(emojiChar, 32, 34);
        return new THREE.CanvasTexture(canvas);
    }

    _createParticleEffect(x, y, textureKey) {
        const texture = this.particleTextures[textureKey];
        if (!texture) return;
        for (let i = 0; i < 12; i++) {
            const material = new THREE.SpriteMaterial({ map: texture, transparent: true, alphaTest: 0.1 });
            const sprite = new THREE.Sprite(material);
            sprite.scale.set(60, 60, 1);
            sprite.position.set(x, y, 10);
            this.particles.push({
                sprite,
                velocity: new THREE.Vector3((Math.random() - 0.5) * 800, (Math.random() - 0.5) * 800, 0),
                life: 1.0,
                fadeSpeed: 0.1 + Math.random() * 0.6,
                gravity: -200,
            });
            this.scene.add(sprite);
        }
    }

    _updateParticles(deltaTime) {
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const particle = this.particles[i];
            particle.sprite.position.add(particle.velocity.clone().multiplyScalar(deltaTime));
            particle.velocity.y += particle.gravity * deltaTime;
            particle.life -= particle.fadeSpeed * deltaTime;
            particle.sprite.material.opacity = Math.max(0, particle.life);
            if (particle.life <= 0) {
                this.scene.remove(particle.sprite);
                particle.sprite.material.dispose();
                this.particles.splice(i, 1);
            }
        }
    }

    _clearAllParticles() {
        for (const particle of this.particles) {
            this.scene.remove(particle.sprite);
            particle.sprite.material.dispose();
        }
        this.particles = [];
    }

    // --- Drop zones (read straight from the DOM boxes, so CSS is the single source of truth) ---

    _checkDropZoneCollision(sprite) {
        const worldPos = new THREE.Vector3();
        sprite.getWorldPosition(worldPos);
        const screenX = worldPos.x + this.renderDiv.clientWidth / 2;
        const screenY = -worldPos.y + this.renderDiv.clientHeight / 2;
        const boxes = [this.ui.boxA, this.ui.boxB];
        for (let zone = 0; zone < boxes.length; zone++) {
            const rect = boxes[zone].getBoundingClientRect();
            if (screenX >= rect.left && screenX <= rect.right && screenY >= rect.top && screenY <= rect.bottom) {
                return zone;
            }
        }
        return null;
    }

    // --- Three.js / tracking ---

    _setupThree() {
        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(width / -2, width / 2, height / 2, height / -2, 1, 1000);
        this.camera.position.z = 100;
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderDiv.appendChild(this.renderer.domElement);
        for (let i = 0; i < 2; i++) {
            this.hands.push({ landmarks: null, anchorPos: new THREE.Vector3(), lastPalm: null, lastSeen: 0 });
        }
    }

    async _setupHandTracking() {
        const vision = await FilesetResolver.forVisionTasks('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
        this.handLandmarker = await HandLandmarker.createFromOptions(vision, {
            baseOptions: {
                modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
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
        await new Promise((resolve) => { this.videoElement.onloadedmetadata = () => resolve(); });
    }

    // Keeps each physical hand in the same slot across frames (slot 0 = circle,
    // slot 1 = dragging). MediaPipe's detection order can swap during fast
    // movement, which used to cancel the drag mid-air.
    _assignDetections(detections) {
        const now = performance.now();
        const assigned = [null, null];
        const remaining = [...detections];
        const palmOf = (lm) => lm[9];
        const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

        // Match detections to slots that were recently seen, nearest first
        const candidates = [];
        this.hands.forEach((hand, slot) => {
            if (!hand.lastPalm || now - hand.lastSeen > 1500) return;
            remaining.forEach((det) => candidates.push({ slot, det, d: dist(palmOf(det), hand.lastPalm) }));
        });
        candidates.sort((a, b) => a.d - b.d);
        for (const c of candidates) {
            if (assigned[c.slot] || !remaining.includes(c.det)) continue;
            assigned[c.slot] = c.det;
            remaining.splice(remaining.indexOf(c.det), 1);
        }
        // Anything left goes to a free slot (never seen, or seen longest ago)
        for (const det of remaining) {
            const free = [0, 1].filter((s) => !assigned[s]);
            if (!free.length) break;
            free.sort((a, b) => this.hands[a].lastSeen - this.hands[b].lastSeen);
            assigned[free[0]] = det;
        }
        return assigned;
    }

    _updateHands(deltaTime) {
        if (!this.handLandmarker || !this.videoElement.srcObject || this.videoElement.readyState < 2) return;
        const videoTime = this.videoElement.currentTime;
        if (videoTime <= this.lastVideoTime) return;
        this.lastVideoTime = videoTime;
        try {
            const results = this.handLandmarker.detectForVideo(this.videoElement, performance.now());
            const width = this.renderDiv.clientWidth;
            const height = this.renderDiv.clientHeight;
            const assigned = this._assignDetections(results.landmarks || []);
            const now = performance.now();

            for (let i = 0; i < this.hands.length; i++) {
                const hand = this.hands[i];
                const raw = assigned[i];
                if (!raw) {
                    hand.landmarks = null;
                    continue;
                }
                const wasTracked = hand.landmarks !== null && now - hand.lastSeen < 300;
                if (!wasTracked || !this.lastLandmarkPositions[i] || this.lastLandmarkPositions[i].length !== raw.length) {
                    this.lastLandmarkPositions[i] = raw.map((lm) => ({ x: lm.x, y: lm.y, z: lm.z }));
                }
                hand.landmarks = raw.map((lm, idx) => {
                    const prev = this.lastLandmarkPositions[i][idx];
                    // Adaptive smoothing: steady when still, snappy when moving fast
                    const speed = Math.hypot(lm.x - prev.x, lm.y - prev.y);
                    const a = Math.min(0.95, Math.max(0.35, 0.3 + speed * 12));
                    const smoothed = {
                        x: a * lm.x + (1 - a) * prev.x,
                        y: a * lm.y + (1 - a) * prev.y,
                        z: a * lm.z + (1 - a) * prev.z,
                    };
                    this.lastLandmarkPositions[i][idx] = smoothed;
                    return smoothed;
                });
                const palm = hand.landmarks[9];
                hand.lastPalm = { x: palm.x, y: palm.y };
                hand.lastSeen = now;
                hand.anchorPos.set((1 - palm.x) * width - width / 2, (1 - palm.y) * height - height / 2, 1);
            }
            this._updateImageCircle(deltaTime);
            this._handleImageDragging();
        } catch (error) {
            console.error('Error during hand detection:', error);
        }
    }

    // --- Dragging (second hand) ---

    _handleImageDragging() {
        const hand = this.hands[1];
        if (!hand || !hand.landmarks) {
            // Tracker lost the hand: keep the card in hand for a moment before giving up
            if (this.isDragging) {
                if (this.dragLostAt === null) this.dragLostAt = performance.now();
                else if (performance.now() - this.dragLostAt > HAND_LOST_GRACE_MS) this._releaseDrag();
            }
            return;
        }
        this.dragLostAt = null;

        const landmarks = hand.landmarks;
        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        const toScreen = (lm) => [(1 - lm.x) * width - width / 2, (1 - lm.y) * height - height / 2];
        const [thumbX, thumbY] = toScreen(landmarks[4]);
        const [indexX, indexY] = toScreen(landmarks[8]);
        const [wristX, wristY] = toScreen(landmarks[0]);
        const [palmX, palmY] = toScreen(landmarks[9]);
        const pinchX = (thumbX + indexX) / 2;
        const pinchY = (thumbY + indexY) / 2;
        const handScale = Math.max(20, Math.hypot(wristX - palmX, wristY - palmY));
        const pinchRatio = Math.hypot(thumbX - indexX, thumbY - indexY) / handScale;

        if (!this.isDragging) {
            if (pinchRatio >= PINCH_START) return;
            let closest = null;
            let closestDistance = Infinity;
            const detectionRadius = this.imageSize * 0.75;
            for (const sprite of this.imageSprites) {
                const worldPos = new THREE.Vector3();
                sprite.getWorldPosition(worldPos);
                const distance = Math.hypot(pinchX - worldPos.x, pinchY - worldPos.y);
                if (distance < closestDistance && distance < detectionRadius) {
                    closestDistance = distance;
                    closest = sprite;
                }
            }
            if (!closest) return;

            // Take the card out of the circle group so it no longer depends on the
            // circle hand (its position is now in world space).
            const worldPos = new THREE.Vector3();
            closest.getWorldPosition(worldPos);
            if (closest.parent !== this.scene) {
                if (closest.parent) closest.parent.remove(closest);
                closest.position.set(worldPos.x, worldPos.y, 3);
                this.scene.add(closest);
            }
            this.draggedImage = closest;
            this.isDragging = true;
            this.releaseFrames = 0;
            this.dragOffset = new THREE.Vector3(worldPos.x - pinchX, worldPos.y - pinchY, 0);
            return;
        }

        // Dragging: follow the pinch every frame; only release after several open frames
        if (this.draggedImage) {
            this.draggedImage.position.set(pinchX + this.dragOffset.x, pinchY + this.dragOffset.y, 3);
        }
        if (pinchRatio > PINCH_RELEASE) {
            this.releaseFrames++;
            if (this.releaseFrames >= RELEASE_FRAMES) this._releaseDrag();
        } else {
            this.releaseFrames = 0;
        }
    }

    _releaseDrag() {
        if (!this.draggedImage || !this.isDragging) return;
        const sprite = this.draggedImage;
        this.draggedImage = null;
        this.isDragging = false;
        this.releaseFrames = 0;
        this.dragLostAt = null;
        this.dragOffset = new THREE.Vector3();

        const zone = this._checkDropZoneCollision(sprite);
        if (zone !== null) {
            if (sprite.userData.item.cat === zone) this._onCorrect(sprite, zone);
            else this._onWrong(sprite, zone);
            return;
        }

        // Dropped in the open: snap back into the circle if it's near, else it stays put
        const circleVisible = this.imageCircle && this.imageCircle.visible;
        const toCircle = circleVisible
            ? Math.hypot(sprite.position.x - this.imageCircle.position.x, sprite.position.y - this.imageCircle.position.y)
            : Infinity;
        if (toCircle < this._currentCircleRadius() * 1.4) {
            this._returnToCircle(sprite);
        } else {
            sprite.userData.isDetached = true;
        }
    }

    _returnToCircle(sprite) {
        if (sprite.parent !== this.imageCircle) {
            if (sprite.parent) sprite.parent.remove(sprite);
            this.imageCircle.add(sprite);
        }
        sprite.userData.isDetached = false;
        sprite.position.set(0, 0, 0); // re-laid out on the ring next frame
    }

    // --- Loop ---

    _onResize() {
        const width = this.renderDiv.clientWidth;
        const height = this.renderDiv.clientHeight;
        this.camera.left = width / -2;
        this.camera.right = width / 2;
        this.camera.top = height / 2;
        this.camera.bottom = height / -2;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    _animate() {
        requestAnimationFrame(this._animate.bind(this));
        const deltaTime = this.clock.getDelta();
        this._updateHands(deltaTime);
        this._updateParticles(deltaTime);
        this.renderer.render(this.scene, this.camera);
    }
}
