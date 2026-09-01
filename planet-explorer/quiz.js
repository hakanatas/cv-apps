// Geography quiz + passport (discovered countries) for Planet Explorer.
// Answering works with the existing hover mechanic: point at a country and
// hold your finger there ("dwell") to lock in the answer.
// The "İPUCU (TR)" mode hides the country name and reveals Turkish hints
// step by step (region, population, neighbours, capital, flag), spoken aloud.
const Quiz = (() => {
    const DWELL_MS = 1000; // how long to hold on a country to answer
    const STILL_AFTER_MS = 300; // pointer must settle this long before the dwell charges
    const STILL_RADIUS_PX = 25; // staying inside this circle counts as "still"
    const HINT_INTERVAL_MS = 10000; // auto-reveal a new hint every 10s
    const PASSPORT_KEY = 'planet-explorer-passport';

    // Turkish names for regions/subregions used by the hint mode.
    const REGION_TR = {
        'Africa': 'Afrika', 'Americas': 'Amerika', 'Asia': 'Asya',
        'Europe': 'Avrupa', 'Oceania': 'Okyanusya', 'Antarctic': 'Antarktika',
    };
    const SUBREGION_TR = {
        'Northern Europe': 'Kuzey Avrupa', 'Southern Europe': 'Güney Avrupa',
        'Western Europe': 'Batı Avrupa', 'Eastern Europe': 'Doğu Avrupa',
        'Central Europe': 'Orta Avrupa', 'Southeast Europe': 'Güneydoğu Avrupa',
        'Western Asia': 'Batı Asya', 'Southern Asia': 'Güney Asya',
        'South-Eastern Asia': 'Güneydoğu Asya', 'Eastern Asia': 'Doğu Asya',
        'Central Asia': 'Orta Asya',
        'Northern Africa': 'Kuzey Afrika', 'Western Africa': 'Batı Afrika',
        'Eastern Africa': 'Doğu Afrika', 'Middle Africa': 'Orta Afrika',
        'Southern Africa': 'Güney Afrika',
        'Caribbean': 'Karayipler', 'Central America': 'Orta Amerika',
        'South America': 'Güney Amerika', 'North America': 'Kuzey Amerika',
        'Northern America': 'Kuzey Amerika',
        'Australia and New Zealand': 'Avustralya ve Yeni Zelanda',
        'Melanesia': 'Melanezya', 'Micronesia': 'Mikronezya', 'Polynesia': 'Polinezya',
    };

    let entitiesByIso = null; // Map iso3 -> Cesium entity
    let active = false;
    let locked = false; // true between answer and next question
    let mode = 'name'; // name | flag | capital | hints
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
    let anchorX = null;
    let anchorY = null;
    let lastMovedAt = 0;
    let discovered = new Set();
    let hintList = [];
    let hintsRevealed = 0;
    let hintInterval = null;
    const els = {};

    try {
        discovered = new Set(JSON.parse(localStorage.getItem(PASSPORT_KEY) || '[]'));
    } catch (error) { /* corrupted storage — start fresh */ }

    function init(isoEntityMap) {
        entitiesByIso = isoEntityMap;
        for (const id of ['quiz-mode', 'quiz-region', 'quiz-toggle', 'quiz-prompt',
            'quiz-hints', 'quiz-hint-btn', 'quiz-progress', 'quiz-progress-fill',
            'quiz-stats', 'passport-count', 'passport-reset', 'sound-toggle']) {
            els[id] = document.getElementById(id);
        }
        els['quiz-mode'].addEventListener('change', (e) => { mode = e.target.value; if (active) nextQuestion(); });
        els['quiz-region'].addEventListener('change', (e) => { region = e.target.value; if (active) nextQuestion(); });
        els['quiz-toggle'].addEventListener('click', () => (active ? stop() : start()));
        els['quiz-hint-btn'].addEventListener('click', () => revealHint(true));
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

    // --- Turkish hint helpers ---

    function turkishName(iso) {
        const data = CountryData.get(iso);
        return CountryData.turkishName(data) || data?.name?.common || entitiesByIso.get(iso)?.name || iso;
    }

    function formatPopulationTr(population) {
        if (population >= 1e9) return `yaklaşık ${(population / 1e9).toFixed(1).replace('.', ',')} milyar`;
        if (population >= 1e6) return `yaklaşık ${Math.round(population / 1e6)} milyon`;
        if (population >= 1e3) return `yaklaşık ${Math.round(population / 1e3)} bin`;
        return `${population}`;
    }

    function buildHints(iso) {
        const data = CountryData.get(iso);
        if (!data) return [];
        const hints = [];
        const regionTr = SUBREGION_TR[data.subregion] || REGION_TR[data.region] || data.region;
        hints.push(`📍 Bölge: ${regionTr}`);
        if (data.population > 0) {
            hints.push(`👥 Nüfus: ${formatPopulationTr(data.population)}`);
        }
        if (Array.isArray(data.borders)) {
            hints.push(data.borders.length === 0
                ? '🏝️ Kara komşusu yok (ada ülkesi ya da yarımada değil, haritada denizle çevrili!)'
                : `🗺️ Kara komşusu sayısı: ${data.borders.length}`);
        }
        if (data.capital?.length) {
            hints.push(`🏛️ Başkenti: ${data.capital[0]}`);
        }
        const name = turkishName(iso);
        hints.push(`${data.flag || '🚩'} Bayrağı bu — adının ilk harfi: ${name.charAt(0).toUpperCase()}`);
        return hints;
    }

    // Strip emoji/labels down to something natural for text-to-speech.
    function speakHintTr(hint) {
        const spoken = hint
            .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/gu, '')
            .replace('Bölge:', 'Bu ülke şu bölgede:')
            .replace('Nüfus:', 'Nüfusu')
            .replace('Kara komşusu sayısı:', 'Kara komşusu sayısı')
            .replace('Başkenti:', 'Başkenti')
            .replace('Bayrağı bu — adının ilk harfi:', 'Adının ilk harfi')
            .trim();
        Effects.speak(spoken, 'tr-TR');
    }

    function revealHint(manual = false) {
        if (mode !== 'hints' || !active || locked) return;
        if (hintsRevealed >= hintList.length) return;
        hintsRevealed++;
        renderHints();
        const newest = hintList[hintsRevealed - 1];
        if (newest) speakHintTr(newest);
        if (manual && hintsRevealed >= hintList.length) {
            els['quiz-hint-btn'].disabled = true;
        }
    }

    function renderHints() {
        els['quiz-hints'].innerHTML = hintList
            .slice(0, hintsRevealed)
            .map((hint) => `<div class="hint-line">${hint}</div>`)
            .join('');
        els['quiz-hint-btn'].disabled = hintsRevealed >= hintList.length;
    }

    // --- Quiz flow ---

    function questionSeconds() {
        return mode === 'hints' ? 60 : 30;
    }

    function buildPool() {
        const pool = [];
        for (const [iso] of entitiesByIso) {
            if (iso === 'ATA') continue; // skip Antarctica
            const data = CountryData.get(iso);
            if (region !== 'all' && data?.region !== region) continue;
            if (mode === 'flag' && !data?.flags?.svg) continue;
            if (mode === 'capital' && !data?.capital?.length) continue;
            if (mode === 'hints' && !data) continue;
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
        ['quiz-prompt', 'quiz-progress', 'quiz-stats', 'quiz-hints', 'quiz-hint-btn']
            .forEach((id) => els[id].classList.add('hidden'));
        clearInterval(timerInterval);
        timerInterval = null;
        clearInterval(hintInterval);
        hintInterval = null;
        if (dwellRaf) { cancelAnimationFrame(dwellRaf); dwellRaf = null; }
    }

    function countryName(iso) {
        const data = CountryData.get(iso);
        if (data) return data.name.common;
        return entitiesByIso.get(iso)?.name || iso;
    }

    function nextQuestion() {
        locked = false;
        clearInterval(hintInterval);
        hintInterval = null;
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

        if (mode === 'hints') {
            els['quiz-prompt'].innerHTML = '🔍 <strong>Gizli ülkeyi bul!</strong><br><span class="quiz-tr">Ülkeyi bulunca parmağını üzerinde SABİT tut — çubuk dolunca cevabın işaretlenir</span>';
            hintList = buildHints(target);
            hintsRevealed = 0;
            ['quiz-hints', 'quiz-hint-btn'].forEach((id) => els[id].classList.remove('hidden'));
            Effects.speak('Gizli ülkeyi bul! İşte ilk ipucu.', 'tr-TR');
            setTimeout(() => { if (active && !locked) revealHint(); }, 2500);
            hintInterval = setInterval(() => revealHint(), HINT_INTERVAL_MS);
            renderHints();
        } else {
            ['quiz-hints', 'quiz-hint-btn'].forEach((id) => els[id].classList.add('hidden'));
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
        }
        startTimer();
        updateStats();
    }

    function startTimer() {
        clearInterval(timerInterval);
        timeLeft = questionSeconds();
        timerInterval = setInterval(() => {
            if (locked) return; // pause between questions
            timeLeft--;
            updateStats();
            if (timeLeft <= 0) onTimeout();
        }, 1000);
    }

    function updateStats() {
        const labels = mode === 'hints'
            ? { score: 'PUAN', streak: 'SERİ', time: 'SÜRE' }
            : { score: 'SCORE', streak: 'STREAK', time: 'TIME' };
        els['quiz-stats'].textContent =
            `${labels.score} ${score}  ·  ${labels.streak} ${streak}  ·  ${labels.time} ${timeLeft}s`;
    }

    function flash(iso, color) {
        const entity = entitiesByIso.get(iso);
        if (!entity) return;
        entity.polygon.material = color.withAlpha(0.45);
        setTimeout(() => { entity.polygon.material = entity._originalFill; }, 1800);
    }

    function onCorrect() {
        locked = true;
        clearInterval(hintInterval);
        hintInterval = null;
        streak++;
        // Fewer hints used = more points in hint mode
        const hintBonus = mode === 'hints' ? Math.max(0, (hintList.length - hintsRevealed) * 5) : 0;
        score += 10 + (streak - 1) * 2 + hintBonus;
        updateStats();
        const data = CountryData.get(target);
        const name = countryName(target);
        Effects.confetti();
        Effects.playCorrect();
        flash(target, Cesium.Color.LIME);
        markDiscovered(target);
        if (mode === 'hints') {
            const turkish = turkishName(target);
            els['quiz-prompt'].innerHTML = `✅ Doğru: <strong>${turkish}</strong>!` +
                (hintBonus ? `<br><span class="quiz-tr">+${hintBonus} hızlı bulma bonusu</span>` : '');
            const capital = data?.capital?.[0];
            Effects.speak(capital ? `Doğru! ${turkish}. Başkenti ${capital}.` : `Doğru! ${turkish}.`, 'tr-TR');
        } else {
            els['quiz-prompt'].innerHTML = `✅ <strong>${name}</strong> — correct!`;
            const capital = data?.capital?.[0];
            Effects.speak(capital ? `${name}. Capital: ${capital}.` : name);
        }
        setTimeout(() => { if (active) nextQuestion(); }, 2200);
    }

    function onWrong(iso) {
        streak = 0;
        updateStats();
        Effects.playWrong();
        const promptHtml = els['quiz-prompt'].innerHTML;
        if (mode === 'hints') {
            const wrongTurkish = turkishName(iso);
            els['quiz-prompt'].innerHTML = `❌ Orası <strong>${wrongTurkish}</strong> — aramaya devam!`;
            Effects.speak(`Orası ${wrongTurkish}. Aramaya devam et!`, 'tr-TR');
        } else {
            els['quiz-prompt'].innerHTML = `❌ That was <strong>${countryName(iso)}</strong> — keep looking!`;
        }
        setTimeout(() => { if (active && !locked) els['quiz-prompt'].innerHTML = promptHtml; }, 1800);
    }

    function onTimeout() {
        locked = true;
        clearInterval(hintInterval);
        hintInterval = null;
        streak = 0;
        if (mode === 'hints') {
            const turkish = turkishName(target);
            els['quiz-prompt'].innerHTML = `⏰ Süre doldu! Cevap: <strong>${turkish}</strong>`;
            Effects.speak(`Süre doldu. Cevap ${turkish} idi.`, 'tr-TR');
        } else {
            const name = countryName(target);
            els['quiz-prompt'].innerHTML = `⏰ Time's up! It was <strong>${name}</strong>`;
            Effects.speak(`Time's up. It was ${name}`);
        }
        Effects.playWrong();
        flash(target, Cesium.Color.HOTPINK);
        updateStats();
        setTimeout(() => { if (active) nextQuestion(); }, 2600);
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

    // Called by main.js every frame with the pointer's screen position (finger
    // tip or mouse). While the pointer keeps moving, the dwell never charges —
    // travelling across the map can no longer trigger accidental answers.
    function notifyPointer(x, y) {
        if (anchorX === null || Math.hypot(x - anchorX, y - anchorY) > STILL_RADIUS_PX) {
            anchorX = x;
            anchorY = y;
            lastMovedAt = performance.now();
        }
    }

    function dwellTick() {
        dwellRaf = active ? requestAnimationFrame(dwellTick) : null;
        if (!active) return;
        let progress = 0;
        if (!locked && hoverIso && target) {
            const settled = performance.now() - lastMovedAt > STILL_AFTER_MS;
            if (!settled) {
                hoverStart = performance.now(); // still travelling — don't charge
            }
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
        notifyPointer,
        markDiscovered,
        get isActive() { return active; },
    };
})();
