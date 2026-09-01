// Loads country metadata from the bundled country-data.json once at startup
// and caches it by ISO3 code (matching the `id` field of countries.geo.json).
// The file is generated from the mledoze/countries dataset merged with World
// Bank population figures — the REST Countries API this app previously hit on
// every hover now requires an API key, so the data ships with the app instead.
const CountryData = (() => {
    const byIso = new Map();
    let loaded = false;
    let loading = null;

    async function load() {
        if (loaded || loading) return loading;
        loading = fetch('country-data.json')
            .then((response) => response.json())
            .then((list) => {
                for (const country of list) {
                    if (country.cca3) byIso.set(country.cca3, country);
                }
                loaded = true;
                console.log(`Country data loaded for ${byIso.size} countries.`);
            })
            .catch((error) => {
                console.warn('Could not load country-data.json. Cards will show names only.', error);
            });
        return loading;
    }

    function get(iso3) {
        return byIso.get(iso3) || null;
    }

    function turkishName(country) {
        return country?.translations?.tur?.common || null;
    }

    return {
        load,
        get,
        turkishName,
        get isLoaded() { return loaded; },
    };
})();
