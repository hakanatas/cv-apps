// Geography quiz + passport (discovered countries) for Planet Explorer.
// Answering works with the existing hover mechanic: point at a country and
// hold your finger there ("dwell") to lock in the answer.
const Quiz = (() => {
    const DWELL_MS = 1200; // how long to hold on a country to answer
    const QUESTION_SECONDS = 30;
    const PASSPORT_KEY = 'planet-explorer-passport';

    let entitiesByIso = null; // Map iso3 -> Cesium entity
    let active = false;
    let locked = false; // true between answer and next question
    let mode = 'name'; // name | flag | capital
    let region = 'all';
    let target = null; // iso3 of the country to find
    let recent = []; // avoid immediate repeats
    let score = 0;
    let streak = 0;
    let timeLeft = 0;
    let timerInterval = null;
    let hoverIso = null;
    let hoverStart = 0;
    let dwellRaf = null;
    let discovered = new Set();
    const els = {};

    try {
        discovered = new Set(JSON.parse(localStorage.getItem(PASSPORT_KEY) || '[]'));
    } catch (error) { /* corrupted storage — start fresh */ }

    function init(isoEntityMap) {
        entitiesByIso = isoEntityMap;
        for (const id of ['quiz-mode', 'quiz-region', 'quiz-toggle', 'quiz-prompt',
            'quiz-progress', 'quiz-progress-fill', 'quiz-stats',
            'passport-count', 'passport-reset', 'sound-toggle']) {
            els[id] = document.getElementById(id);
        }
        els['quiz-mode'].addEventListener('change', (e) => { mode = e.target.value; if (active) nextQuestion(); });
        els['quiz-region'].addEventListener('change', (e) => { region = e.target.value; if (active) nextQuestion(); });
        els['quiz-toggle'].addEventListener('click', () => (active ? stop() : start()));
        els['passport-reset'].addEventListener('click', resetPassport);
        els['sound-toggle'].addEventListener('click', () => {
            Effects.setSound(!Effects.soundOn);
            els['sound-toggle'].textContent = Effects.soundOn ? '🔊' : '🔇';
        });
        applyDiscoveredFills();
        updatePassportUi();
    }

    // --- Passport ---

    function discoveredFill() {
        return Cesium.Color.LIME.withAlpha(0.12);
    }

    function markDiscovered(iso) {
        if (!iso || discovered.has(iso) || !entitiesByIso?.has(iso)) return;
        discovered.add(iso);
        try {
            localStorage.setItem(PASSPORT_KEY, JSON.stringify([...discovered]));
        } catch (error) { /* storage may be unavailable */ }
        const entity = entitiesByIso.get(iso);
        entity._originalFill = discoveredFill(); // hover-reset now keeps the tint
        updatePassportUi();
    }

    function applyDiscoveredFills() {
        if (!entitiesByIso) return;
        for (const iso of discovered) {
            const entity = entitiesByIso.get(iso);
            if (entity) {
                entity._originalFill = discoveredFill();
                entity.polygon.material = discoveredFill();
            }
        }
    }

    function resetPassport() {
        discovered.clear();
        try { localStorage.removeItem(PASSPORT_KEY); } catch (error) { /* ignore */ }
        if (entitiesByIso) {
            for (const entity of entitiesByIso.values()) {
                entity._originalFill = Cesium.Color.TRANSPARENT;
                entity.polygon.material = Cesium.Color.TRANSPARENT;
            }
        }
        updatePassportUi();
    }

    function updatePassportUi() {
        if (!els['passport-count'] || !entitiesByIso) return;
        els['passport-count'].textContent = `PASSPORT: ${discovered.size}/${entitiesByIso.size}`;
    }

    // --- Quiz flow ---

    function buildPool() {
        const pool = [];
        for (const [iso] of entitiesByIso) {
            if (iso === 'ATA') continue; // skip Antarctica
            const data = CountryData.get(iso);
            if (region !== 'all' && data?.region !== region) continue;
            if (mode === 'flag' && !data?.flags?.svg) continue;
            if (mode === 'capital' && !data?.capital?.length) continue;
            pool.push(iso);
        }
        return pool;
    }

    function start() {
        active = true;
        locked = false;
        score = 0;
        streak = 0;
        els['quiz-toggle'].textContent = 'STOP';
        ['quiz-prompt', 'quiz-progress', 'quiz-stats'].forEach((id) => els[id].classList.remove('hidden'));
        nextQuestion();
        if (!dwellRaf) dwellRaf = requestAnimationFrame(dwellTick);
    }

    function stop() {
        active = false;
        target = null;
        els['quiz-toggle'].textContent = 'START';
        ['quiz-prompt', 'quiz-progress', 'quiz-stats'].forEach((id) => els[id].classList.add('hidden'));
        clearInterval(timerInterval);
        timerInterval = null;
        if (dwellRaf) { cancelAnimationFrame(dwellRaf); dwellRaf = null; }
    }

    function countryName(iso) {
        const data = CountryData.get(iso);
        if (data) return data.name.common;
        return entitiesByIso.get(iso)?.name || iso;
    }

    function nextQuestion() {
        locked = false;
        const pool = buildPool().filter((iso) => !recent.includes(iso));
        if (!pool.length) {
            els['quiz-prompt'].innerHTML = 'No countries match this mode/region yet.<br>(country data may still be loading)';
            return;
        }
        target = pool[Math.floor(Math.random() * pool.length)];
        recent.push(target);
        if (recent.length > 6) recent.shift();

        const data = CountryData.get(target);
        const name = countryName(target);
        const turkish = CountryData.turkishName(data);
        if (mode === 'flag' && data) {
            els['quiz-prompt'].innerHTML =
                `FIND THIS FLAG:<br><img src="${data.flags.svg}" alt="flag" class="quiz-flag">`;
            Effects.speak('Find this flag');
        } else if (mode === 'capital' && data) {
            els['quiz-prompt'].innerHTML = `CAPITAL: <strong>${data.capital[0]}</strong><br>Find the country!`;
            Effects.speak(`The capital is ${data.capital[0]}. Find the country.`);
        } else {
            els['quiz-prompt'].innerHTML =
                `FIND: <strong>${name}</strong>${turkish && turkish !== name ? `<br><span class="quiz-tr">${turkish}</span>` : ''}`;
            Effects.speak(`Find ${name}`);
        }
        startTimer();
        updateStats();
    }

    function startTimer() {
        clearInterval(timerInterval);
        timeLeft = QUESTION_SECONDS;
        timerInterval = setInterval(() => {
            if (locked) return; // pause between questions
            timeLeft--;
            updateStats();
            if (timeLeft <= 0) onTimeout();
        }, 1000);
    }

    function updateStats() {
        els['quiz-stats'].textContent = `SCORE ${score}  ·  STREAK ${streak}  ·  TIME ${timeLeft}s`;
    }

    function flash(iso, color) {
        const entity = entitiesByIso.get(iso);
        if (!entity) return;
        entity.polygon.material = color.withAlpha(0.45);
        setTimeout(() => { entity.polygon.material = entity._originalFill; }, 1800);
    }

    function onCorrect() {
        locked = true;
        streak++;
        score += 10 + (streak - 1) * 2;
        updateStats();
        const data = CountryData.get(target);
        const name = countryName(target);
        els['quiz-prompt'].innerHTML = `✅ <strong>${name}</strong> — correct!`;
        Effects.confetti();
        Effects.playCorrect();
        const capital = data?.capital?.[0];
        Effects.speak(capital ? `${name}. Capital: ${capital}.` : name);
        flash(target, Cesium.Color.LIME);
        markDiscovered(target);
        setTimeout(() => { if (active) nextQuestion(); }, 1800);
    }

    function onWrong(iso) {
        streak = 0;
        updateStats();
        Effects.playWrong();
        const wrongName = countryName(iso);
        const promptHtml = els['quiz-prompt'].innerHTML;
        els['quiz-prompt'].innerHTML = `❌ That was <strong>${wrongName}</strong> — keep looking!`;
        setTimeout(() => { if (active && !locked) els['quiz-prompt'].innerHTML = promptHtml; }, 1500);
    }

    function onTimeout() {
        locked = true;
        streak = 0;
        const name = countryName(target);
        els['quiz-prompt'].innerHTML = `⏰ Time's up! It was <strong>${name}</strong>`;
        Effects.playWrong();
        Effects.speak(`Time's up. It was ${name}`);
        flash(target, Cesium.Color.HOTPINK);
        updateStats();
        setTimeout(() => { if (active) nextQuestion(); }, 2200);
    }

    // --- Hover / dwell ---

    // Called by main.js whenever the hovered country changes (iso3 or null).
    function onHover(iso) {
        if (iso !== hoverIso) {
            hoverIso = iso;
            hoverStart = performance.now();
        }
        markDiscovered(iso);
    }

    function dwellTick() {
        dwellRaf = active ? requestAnimationFrame(dwellTick) : null;
        if (!active) return;
        let progress = 0;
        if (!locked && hoverIso && target) {
            progress = Math.min(1, (performance.now() - hoverStart) / DWELL_MS);
            if (progress >= 1) {
                if (hoverIso === target) onCorrect();
                else onWrong(hoverIso);
                hoverStart = performance.now(); // re-arm the dwell
                progress = 0;
            }
        }
        els['quiz-progress-fill'].style.width = `${Math.round(progress * 100)}%`;
        els['quiz-progress-fill'].style.background = hoverIso === target ? '#7CFC00' : '#FFD700';
    }

    return {
        init,
        onHover,
        markDiscovered,
        get isActive() { return active; },
    };
})();
