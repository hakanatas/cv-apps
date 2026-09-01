// Category sets for the sorting game. Each set has exactly two categories and
// a list of cards. Cards are emoji, text, or image based — emoji/text cards
// are rendered to canvas textures at runtime, so no image assets are needed.
//
// item: { kind: 'emoji' | 'text' | 'image', value, name, cat: 0 | 1, say?: { text, lang } }
//   - name: what is announced (Turkish) when the card is sorted correctly
//   - say:  optional extra pronunciation (e.g. the English word) spoken first

const emoji = (value, name, cat) => ({ kind: 'emoji', value, name, cat });
const text = (value, name, cat, say) => ({ kind: 'text', value, name, cat, say });
const image = (src, name, cat) => ({ kind: 'image', value: src, name, cat });

export const SETS = {
    'meyve-sebze': {
        title: 'Meyve mi, Sebze mi?',
        categories: [{ label: 'MEYVE 🍎' }, { label: 'SEBZE 🥕' }],
        items: [
            emoji('🍎', 'Elma', 0), emoji('🍌', 'Muz', 0), emoji('🍇', 'Üzüm', 0),
            emoji('🍓', 'Çilek', 0), emoji('🍊', 'Portakal', 0), emoji('🍉', 'Karpuz', 0),
            emoji('🍑', 'Şeftali', 0), emoji('🍒', 'Kiraz', 0), emoji('🍐', 'Armut', 0),
            emoji('🥕', 'Havuç', 1), emoji('🥦', 'Brokoli', 1), emoji('🌽', 'Mısır', 1),
            emoji('🍆', 'Patlıcan', 1), emoji('🥒', 'Salatalık', 1), emoji('🥔', 'Patates', 1),
            emoji('🧅', 'Soğan', 1), emoji('🥬', 'Marul', 1), emoji('🫑', 'Biber', 1),
        ],
    },
    'canli-cansiz': {
        title: 'Canlı mı, Cansız mı?',
        categories: [{ label: 'CANLI 🌱' }, { label: 'CANSIZ 🪨' }],
        items: [
            emoji('🐶', 'Köpek', 0), emoji('🌳', 'Ağaç', 0), emoji('🐟', 'Balık', 0),
            emoji('🌻', 'Ayçiçeği', 0), emoji('🦋', 'Kelebek', 0), emoji('🐘', 'Fil', 0),
            emoji('🍄', 'Mantar', 0), emoji('🐝', 'Arı', 0), emoji('🐢', 'Kaplumbağa', 0),
            emoji('🪨', 'Taş', 1), emoji('🚗', 'Araba', 1), emoji('📱', 'Telefon', 1),
            emoji('⚽', 'Top', 1), emoji('🪑', 'Sandalye', 1), emoji('✏️', 'Kalem', 1),
            emoji('🧸', 'Oyuncak ayı', 1), emoji('🔑', 'Anahtar', 1), emoji('🕰️', 'Saat', 1),
        ],
    },
    'memeli-kus': {
        title: 'Memeli mi, Kuş mu?',
        categories: [{ label: 'MEMELİ 🐾' }, { label: 'KUŞ 🪶' }],
        items: [
            emoji('🐘', 'Fil', 0), emoji('🐄', 'İnek', 0), emoji('🦁', 'Aslan', 0),
            emoji('🐒', 'Maymun', 0), emoji('🐕', 'Köpek', 0), emoji('🐎', 'At', 0),
            emoji('🐋', 'Balina', 0), emoji('🦇', 'Yarasa', 0), emoji('🐻', 'Ayı', 0),
            emoji('🦅', 'Kartal', 1), emoji('🐧', 'Penguen', 1), emoji('🦜', 'Papağan', 1),
            emoji('🦆', 'Ördek', 1), emoji('🐓', 'Horoz', 1), emoji('🦉', 'Baykuş', 1),
            emoji('🦩', 'Flamingo', 1), emoji('🐦', 'Serçe', 1), emoji('🦢', 'Kuğu', 1),
        ],
    },
    'tek-cift': {
        title: 'Tek mi, Çift mi?',
        categories: [{ label: 'TEK SAYI' }, { label: 'ÇİFT SAYI' }],
        // Fresh numbers every round
        items: () => Array.from({ length: 30 }, (_, i) => i + 1)
            .map((n) => text(String(n), String(n), n % 2 === 1 ? 0 : 1)),
    },
    'sesli-sessiz': {
        title: 'Sesli mi, Sessiz mi?',
        categories: [{ label: 'SESLİ HARF' }, { label: 'SESSİZ HARF' }],
        items: [
            ...'AEIİOÖUÜ'.split('').map((h) => text(h, `${h} harfi`, 0)),
            ...'BCÇDFGHKLMNPRSŞTVYZ'.split('').map((h) => text(h, `${h} harfi`, 1)),
        ],
    },
    'ingilizce': {
        title: 'İngilizce: Animal or Food?',
        categories: [{ label: 'ANIMAL 🐾' }, { label: 'FOOD 🍽️' }],
        items: [
            text('DOG', 'Köpek', 0, { text: 'dog', lang: 'en-US' }),
            text('CAT', 'Kedi', 0, { text: 'cat', lang: 'en-US' }),
            text('COW', 'İnek', 0, { text: 'cow', lang: 'en-US' }),
            text('LION', 'Aslan', 0, { text: 'lion', lang: 'en-US' }),
            text('FISH', 'Balık', 0, { text: 'fish', lang: 'en-US' }),
            text('BIRD', 'Kuş', 0, { text: 'bird', lang: 'en-US' }),
            text('HORSE', 'At', 0, { text: 'horse', lang: 'en-US' }),
            text('FROG', 'Kurbağa', 0, { text: 'frog', lang: 'en-US' }),
            text('APPLE', 'Elma', 1, { text: 'apple', lang: 'en-US' }),
            text('BREAD', 'Ekmek', 1, { text: 'bread', lang: 'en-US' }),
            text('CAKE', 'Pasta', 1, { text: 'cake', lang: 'en-US' }),
            text('MILK', 'Süt', 1, { text: 'milk', lang: 'en-US' }),
            text('EGG', 'Yumurta', 1, { text: 'egg', lang: 'en-US' }),
            text('RICE', 'Pilav', 1, { text: 'rice', lang: 'en-US' }),
            text('CHEESE', 'Peynir', 1, { text: 'cheese', lang: 'en-US' }),
            text('PIZZA', 'Pizza', 1, { text: 'pizza', lang: 'en-US' }),
        ],
    },
    'hotdog': {
        title: 'Hot Dog mu, Değil mi?',
        categories: [{ label: 'HOT DOG 🌭' }, { label: 'HOT DOG DEĞİL 🚫' }],
        items: [
            image('assets/1.png', 'Hot dog', 0), image('assets/3.png', 'Hot dog', 0),
            image('assets/5.png', 'Hot dog', 0),
            image('assets/2.png', 'Matcha latte', 1), image('assets/4.png', 'Çilek', 1),
            image('assets/6.png', 'Köri', 1),
        ],
    },
};

export const DEFAULT_SET = 'meyve-sebze';

function shuffle(list) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
}

// Picks a balanced round (up to `count` cards, half from each category).
export function buildRound(setId, count = 8) {
    const set = SETS[setId];
    const items = typeof set.items === 'function' ? set.items() : set.items;
    const perCategory = Math.ceil(count / 2);
    const picked = [
        ...shuffle(items.filter((item) => item.cat === 0)).slice(0, perCategory),
        ...shuffle(items.filter((item) => item.cat === 1)).slice(0, perCategory),
    ].slice(0, count);
    return shuffle(picked);
}
