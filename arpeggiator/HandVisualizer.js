import * as THREE from 'three';

// A text label rendered onto a reusable canvas texture.
// The canvas/texture/sprite are allocated once; the canvas is only redrawn
// when the text or style actually changes (this used to happen every frame).
class LabelSprite {
    constructor(width = 300, height = 80) {
        this.canvas = document.createElement('canvas');
        this.canvas.width = width;
        this.canvas.height = height;
        this.ctx = this.canvas.getContext('2d');
        this.texture = new THREE.CanvasTexture(this.canvas);
        this.material = new THREE.SpriteMaterial({
            map: this.texture,
            transparent: true,
            depthTest: false,
        });
        this.sprite = new THREE.Sprite(this.material);
        this.sprite.scale.set(width, height, 1);
        this.sprite.visible = false;
        this.lastKey = '';
    }

    set(text, bg, fg, fontsize = 20) {
        const key = `${text}|${bg}|${fg}|${fontsize}`;
        if (key !== this.lastKey) {
            this.lastKey = key;
            const { ctx, canvas } = this;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.font = `bold ${fontsize}px Arial`;
            const textWidth = Math.min(ctx.measureText(text).width, canvas.width - 24);
            const boxW = textWidth + 24;
            const boxH = fontsize * 1.6;
            ctx.fillStyle = bg;
            ctx.fillRect((canvas.width - boxW) / 2, (canvas.height - boxH) / 2, boxW, boxH);
            ctx.fillStyle = fg;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, canvas.width / 2, canvas.height / 2, canvas.width - 32);
            this.texture.needsUpdate = true;
        }
        this.sprite.visible = true;
    }

    hide() {
        this.sprite.visible = false;
    }
}

// Renders both hands' skeletons, fingertip circles, the pinch line and labels.
// All Three.js objects are created once and updated in place each frame.
export class HandVisualizer {
    constructor(scene, connections) {
        this.connections = connections;
        this.hands = [];

        const skeletonMaterial = new THREE.LineBasicMaterial({ color: 0x00ccff });
        const pinchMaterial = new THREE.LineBasicMaterial({ color: 0xffffff });
        const circleMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
        const tipGeometry = new THREE.CircleGeometry(8, 16);
        const wristGeometry = new THREE.CircleGeometry(12, 16);

        for (let h = 0; h < 2; h++) {
            const group = new THREE.Group();
            group.visible = false;
            scene.add(group);

            const skeletonGeometry = new THREE.BufferGeometry();
            skeletonGeometry.setAttribute(
                'position',
                new THREE.BufferAttribute(new Float32Array(connections.length * 2 * 3), 3)
            );
            const skeleton = new THREE.LineSegments(skeletonGeometry, skeletonMaterial);
            skeleton.frustumCulled = false;
            group.add(skeleton);

            const pinchGeometry = new THREE.BufferGeometry();
            pinchGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * 3), 3));
            const pinchLine = new THREE.Line(pinchGeometry, pinchMaterial);
            pinchLine.frustumCulled = false;
            pinchLine.visible = false;
            group.add(pinchLine);

            // Wrist + 5 fingertip circles.
            const circles = [0, 4, 8, 12, 16, 20].map((landmarkIndex) => {
                const mesh = new THREE.Mesh(landmarkIndex === 0 ? wristGeometry : tipGeometry, circleMaterial);
                group.add(mesh);
                return { landmarkIndex, mesh };
            });

            const primaryLabel = new LabelSprite();
            group.add(primaryLabel.sprite);
            const secondaryLabel = new LabelSprite();
            group.add(secondaryLabel.sprite);

            this.hands.push({ group, skeleton, pinchLine, circles, primaryLabel, secondaryLabel });
        }
    }

    hide(handIndex) {
        this.hands[handIndex].group.visible = false;
    }

    /**
     * @param {number} handIndex 0 or 1
     * @param {THREE.Vector3[]} points3D screen-space positions for the 21 landmarks
     * @param {object} opts { pinch: {a, b} | null,
     *                        primaryLabel: {text, bg, fg, position} | null,
     *                        secondaryLabel: {text, bg, fg, position} | null }
     */
    update(handIndex, points3D, opts = {}) {
        const hand = this.hands[handIndex];
        hand.group.visible = true;

        const positions = hand.skeleton.geometry.attributes.position;
        this.connections.forEach((conn, i) => {
            const p1 = points3D[conn[0]];
            const p2 = points3D[conn[1]];
            positions.setXYZ(i * 2, p1.x, p1.y, 1);
            positions.setXYZ(i * 2 + 1, p2.x, p2.y, 1);
        });
        positions.needsUpdate = true;

        for (const { landmarkIndex, mesh } of hand.circles) {
            const p = points3D[landmarkIndex];
            mesh.position.set(p.x, p.y, 1.1);
        }

        if (opts.pinch) {
            const pinchPositions = hand.pinchLine.geometry.attributes.position;
            pinchPositions.setXYZ(0, opts.pinch.a.x, opts.pinch.a.y, 1.2);
            pinchPositions.setXYZ(1, opts.pinch.b.x, opts.pinch.b.y, 1.2);
            pinchPositions.needsUpdate = true;
            hand.pinchLine.visible = true;
        } else {
            hand.pinchLine.visible = false;
        }

        for (const [label, data] of [
            [hand.primaryLabel, opts.primaryLabel],
            [hand.secondaryLabel, opts.secondaryLabel],
        ]) {
            if (data) {
                label.set(data.text, data.bg, data.fg, data.fontsize ?? 20);
                label.sprite.position.set(data.position.x, data.position.y, 2);
            } else {
                label.hide();
            }
        }
    }
}
