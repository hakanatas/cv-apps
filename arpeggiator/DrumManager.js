import * as Tone from 'tone';

// --- Pattern banks ---
// Each bank is a full 16-step pattern set plus a swing amount.
function steps(indices) {
    const pattern = new Array(16).fill(false);
    indices.forEach((i) => (pattern[i] = true));
    return pattern;
}

const BANKS = [
    {
        name: 'Classic',
        swing: 0,
        patterns: {
            kick: steps([0, 5, 8, 11, 13]),
            snare: steps([4, 12]),
            hihat: steps([1, 3, 5, 7, 9, 11, 13, 15]),
            clap: steps([4, 7, 12]),
        },
    },
    {
        name: 'House',
        swing: 0.03,
        patterns: {
            kick: steps([0, 4, 8, 12]),
            snare: steps([4, 12]),
            hihat: steps([2, 6, 10, 14]),
            clap: steps([7, 15]),
        },
    },
    {
        name: 'Funk',
        swing: 0.15,
        patterns: {
            kick: steps([0, 7, 10]),
            snare: steps([4, 12, 15]),
            hihat: steps([0, 2, 4, 6, 8, 10, 12, 14]),
            clap: steps([12]),
        },
    },
];

// --- Module state ---
let players = null;
let isLoaded = false;
let sequence = null;
let beatIndex = 0;
let bankIndex = 0;
const activeDrums = new Set();

const fingerToDrumMap = {
    index: 'kick',
    middle: 'snare',
    ring: 'hihat',
    pinky: 'clap',
};

/**
 * Loads all drum samples; resolves when loading is complete.
 */
export function loadSamples() {
    return new Promise((resolve, reject) => {
        if (isLoaded) {
            resolve();
            return;
        }
        players = new Tone.Players({
            urls: {
                kick: 'assets/kick.wav',
                snare: 'assets/snare.wav',
                hihat: 'assets/hihat.wav',
                clap: 'assets/clap.wav',
            },
            onload: () => {
                isLoaded = true;
                players.player('kick').volume.value = -6;
                players.player('snare').volume.value = 0;
                players.player('hihat').volume.value = -2;
                players.player('clap').volume.value = 0;
                console.log('Drum samples loaded successfully.');
                resolve();
            },
            onerror: (error) => {
                console.error('Error loading drum samples:', error);
                reject(error);
            },
        }).toDestination();
    });
}

/**
 * Also routes the drum bus into an extra node (e.g. a recorder).
 */
export function connectExtra(node) {
    if (players && node) players.connect(node);
}

/**
 * Creates and starts the main 16-step drum loop.
 * Assumes Tone.Transport has been started elsewhere.
 */
export function startSequence() {
    if (!isLoaded || sequence) {
        console.warn('Drums not loaded or sequence already started.');
        return;
    }
    applySwing();
    sequence = new Tone.Sequence((time, step) => {
        beatIndex = step; // for visualization
        const patterns = BANKS[bankIndex].patterns;
        for (const [drum, pattern] of Object.entries(patterns)) {
            if (activeDrums.has(drum) && pattern[step]) {
                players.player(drum).start(time);
            }
        }
    }, Array.from({ length: 16 }, (_, i) => i), '16n').start(0);
    console.log('Drum sequence started.');
}

function applySwing() {
    Tone.Transport.swing = BANKS[bankIndex].swing;
    Tone.Transport.swingSubdivision = '16n';
}

/**
 * Switches to the next pattern bank; returns its name.
 */
export function cycleBank() {
    bankIndex = (bankIndex + 1) % BANKS.length;
    applySwing();
    return BANKS[bankIndex].name;
}

export function getBankName() {
    return BANKS[bankIndex].name;
}

/**
 * Updates which drums are active based on finger positions.
 * @param {object} fingerStates - finger name -> boolean `isUp`.
 */
export function updateActiveDrums(fingerStates) {
    activeDrums.clear();
    for (const [finger, isUp] of Object.entries(fingerStates)) {
        if (isUp) {
            const drum = fingerToDrumMap[finger];
            if (drum) activeDrums.add(drum);
        }
    }
}

export function getActiveDrums() {
    return activeDrums;
}

export function getFingerToDrumMap() {
    return fingerToDrumMap;
}

export function getCurrentBeat() {
    return beatIndex;
}

/**
 * Returns the current bank's pattern set.
 */
export function getDrumPattern() {
    return BANKS[bankIndex].patterns;
}
