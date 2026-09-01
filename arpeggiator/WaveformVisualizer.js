import * as THREE from 'three';

// Draws the synth output as a colored ribbon using data from a Tone.Analyser.
export class WaveformVisualizer {
    constructor(scene, analyser, canvasWidth, canvasHeight) {
        this.scene = scene;
        this.analyser = analyser;
        this.mesh = null;
        this.bufferLength = this.analyser.size;
        this.dataArray = new Float32Array(this.bufferLength);
        this.smoothedDataArray = new Float32Array(this.bufferLength);

        this.smoothingFactor = 0.4; // 0..1, higher follows the signal faster
        this.width = canvasWidth * 0.8;
        this.height = 450; // vertical amplitude of the wave
        this.yPosition = 0;
        this.baseThickness = 30.0;
        this.pulseAmount = 0; // extra thickness triggered by drum hits, decays each frame

        this.currentColor = new THREE.Color('#7B4394');
        this.targetColor = new THREE.Color('#7B4394');
        this.uniforms = {
            solidColor: { value: this.currentColor },
        };
        this._createVisualizer();
        this.updatePosition(canvasWidth, canvasHeight);
    }

    _createVisualizer() {
        const material = new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform vec3 solidColor;
                void main() {
                    gl_FragColor = vec4(solidColor, 0.9);
                }
            `,
            transparent: true,
            side: THREE.DoubleSide,
        });

        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(this.bufferLength * 2 * 3);
        const uvs = new Float32Array(this.bufferLength * 2 * 2);
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        const indices = [];
        for (let i = 0; i < this.bufferLength - 1; i++) {
            const p1 = i * 2; // top-left
            const p2 = p1 + 1; // bottom-left
            const p3 = (i + 1) * 2; // top-right
            const p4 = p3 + 1; // bottom-right
            indices.push(p1, p2, p3);
            indices.push(p2, p4, p3);
        }
        geometry.setIndex(indices);

        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.frustumCulled = false;
        this.scene.add(this.mesh);
    }

    // Kick a temporary thickness pulse (drum hit feedback).
    pulse(strength = 1) {
        this.pulseAmount = Math.min(2, this.pulseAmount + strength);
    }

    // Call from the main animation loop.
    update() {
        if (!this.analyser || !this.mesh) return;
        this.currentColor.lerp(this.targetColor, 0.05);

        const newArray = this.analyser.getValue();
        if (newArray instanceof Float32Array) {
            this.dataArray.set(newArray);
        }

        const positions = this.mesh.geometry.attributes.position.array;
        const uvs = this.mesh.geometry.attributes.uv.array;
        const startX = -this.width / 2;
        const xStep = this.width / (this.bufferLength - 1);
        const halfThickness = (this.baseThickness * (1 + this.pulseAmount)) / 2;
        this.pulseAmount *= 0.85;

        for (let i = 0; i < this.bufferLength; i++) {
            this.smoothedDataArray[i] =
                this.smoothingFactor * this.dataArray[i] +
                (1 - this.smoothingFactor) * this.smoothedDataArray[i];

            const x = startX + i * xStep;
            const y = this.yPosition + this.smoothedDataArray[i] * this.height;

            const vertexIndex = i * 2 * 3;
            positions[vertexIndex] = x;
            positions[vertexIndex + 1] = y + halfThickness;
            positions[vertexIndex + 2] = 2;
            positions[vertexIndex + 3] = x;
            positions[vertexIndex + 4] = y - halfThickness;
            positions[vertexIndex + 5] = 2;

            const uvIndex = i * 2 * 2;
            uvs[uvIndex] = i / (this.bufferLength - 1);
            uvs[uvIndex + 1] = 1.0;
            uvs[uvIndex + 2] = i / (this.bufferLength - 1);
            uvs[uvIndex + 3] = 0.0;
        }
        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.uv.needsUpdate = true;
    }

    updateColor(newColor) {
        this.targetColor.set(newColor);
    }

    // Call on window resize.
    updatePosition(canvasWidth, canvasHeight) {
        this.width = canvasWidth * 0.8;
        this.yPosition = -canvasHeight / 2 + 250; // above the drum beat indicators
    }

    dispose() {
        if (this.mesh) {
            this.scene.remove(this.mesh);
            this.mesh.geometry?.dispose();
            this.mesh.material?.dispose();
        }
    }
}
