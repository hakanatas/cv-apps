// Musical scale definitions and note-name helpers.
const NOTE_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

export const SCALES = [
    { name: 'Minor Pentatonic', intervals: [0, 3, 5, 7, 10] },
    { name: 'Major Pentatonic', intervals: [0, 2, 4, 7, 9] },
    { name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
    { name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
];

// A curated set of root notes (midi 48 = C3).
export const ROOTS = [
    { name: 'C', midi: 48 },
    { name: 'D', midi: 50 },
    { name: 'Eb', midi: 51 },
    { name: 'F', midi: 53 },
    { name: 'G', midi: 55 },
    { name: 'A', midi: 57 },
    { name: 'Bb', midi: 58 },
];

export function midiToNoteName(midi) {
    return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}

// Builds `count` note names walking up the scale from the root, octave by octave.
export function buildScaleNotes(rootMidi, intervals, count) {
    const notes = [];
    for (let i = 0; i < count; i++) {
        const octave = Math.floor(i / intervals.length);
        notes.push(midiToNoteName(rootMidi + octave * 12 + intervals[i % intervals.length]));
    }
    return notes;
}
