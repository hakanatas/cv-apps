import * as THREE from 'three';

// Horizontal pitch zones so the player can see which note their hand selects.
// Lane 0 is at the bottom of the screen (lowest note).
export class NoteLanes {
    constructor(scene, laneCount = 12) {
        this.laneCount = laneCount;
        this.width = 0;
        this.height = 0;

        this.group = new THREE.Group();
        scene.add(this.group);

        // Subtle boundary lines between lanes (laneCount - 1 inner lines).
        const lineGeometry = new THREE.BufferGeometry();
        lineGeometry.setAttribute(
            'position',
            new THREE.BufferAttribute(new Float32Array((laneCount - 1) * 2 * 3), 3)
        );
        this.lines = new THREE.LineSegments(
            lineGeometry,
            new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12 })
        );
        this.lines.frustumCulled = false;
        this.group.add(this.lines);

        // Highlight plane for the active lane.
        this.highlight = new THREE.Mesh(
            new THREE.PlaneGeometry(1, 1),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false })
        );
        this.highlight.visible = false;
        this.group.add(this.highlight);

        // One small note-name label per lane, along the left edge.
        this.labels = [];
        for (let i = 0; i < laneCount; i++) {
            const canvas = document.createElement('canvas');
            canvas.width = 96;
            canvas.height = 40;
            const texture = new THREE.CanvasTexture(canvas);
            const sprite = new THREE.Sprite(
                new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, opacity: 0.75 })
            );
            sprite.scale.set(96, 40, 1);
            this.group.add(sprite);
            this.labels.push({ canvas, texture, sprite, text: '' });
        }
    }

    setNotes(notes) {
        for (let i = 0; i < this.laneCount; i++) {
            const label = this.labels[i];
            const text = notes[i] ?? '';
            if (text === label.text) continue;
            label.text = text;
            const ctx = label.canvas.getContext('2d');
            ctx.clearRect(0, 0, label.canvas.width, label.canvas.height);
            ctx.font = 'bold 20px Arial';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.9)';
            ctx.shadowBlur = 4;
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, 8, label.canvas.height / 2);
            label.texture.needsUpdate = true;
        }
    }

    _laneCenterY(index) {
        const laneHeight = this.height / this.laneCount;
        return -this.height / 2 + (index + 0.5) * laneHeight;
    }

    resize(width, height) {
        this.width = width;
        this.height = height;
        const laneHeight = height / this.laneCount;

        const positions = this.lines.geometry.attributes.position;
        for (let i = 1; i < this.laneCount; i++) {
            const y = -height / 2 + i * laneHeight;
            positions.setXYZ((i - 1) * 2, -width / 2, y, 0.5);
            positions.setXYZ((i - 1) * 2 + 1, width / 2, y, 0.5);
        }
        positions.needsUpdate = true;

        this.highlight.scale.set(width, laneHeight, 1);

        this.labels.forEach((label, i) => {
            label.sprite.position.set(-width / 2 + 56, this._laneCenterY(i), 0.6);
        });
    }

    // Pass null to hide the highlight.
    setActive(index, color) {
        if (index === null || index === undefined) {
            this.highlight.visible = false;
            return;
        }
        this.highlight.position.set(0, this._laneCenterY(index), 0.4);
        if (color) this.highlight.material.color.set(color);
        this.highlight.visible = true;
    }
}
