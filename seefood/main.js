import { Game } from './game.js';

const renderDiv = document.getElementById('renderDiv');
if (!renderDiv) {
    console.error('Fatal Error: renderDiv element not found.');
} else {
    // The game waits for the start button (camera + audio need a user gesture).
    new Game(renderDiv);
}
