// Prévisions météo des 17 chefs-lieux de l'appli (Open-Meteo : AROME de Météo-France puis ECMWF IFS).
// Une seule requête pour toutes les villes (≈ 4 passages par jour, loin des 10 000 appels/jour autorisés).
// Écrit data/meteo.json ; ne touche à rien si la réponse est incomplète ou si l'API est en panne.
import { writeEnvelope } from "./lib/write.mjs";

const CITIES = [
  ["paris", 48.86, 2.35], ["lille", 50.63, 3.06], ["rouen", 49.44, 1.1], ["rennes", 48.11, -1.68],
  ["nantes", 47.22, -1.55], ["strasbourg", 48.58, 7.75], ["dijon", 47.32, 5.04], ["lyon", 45.76, 4.84],
  ["clermont", 45.78, 3.08], ["grenoble", 45.19, 5.72], ["bordeaux", 44.84, -0.58], ["toulouse", 43.6, 1.44],
  ["montpellier", 43.61, 3.88], ["marseille", 43.3, 5.37], ["nice", 43.7, 7.27], ["perpignan", 42.7, 2.9],
  ["ajaccio", 41.92, 8.74],
];
const MODELS = ["meteofrance_arome_france", "ecmwf_ifs025"];
const VARS = ["temperature_2m", "precipitation", "wind_speed_10m", "wind_gusts_10m", "weather_code", "is_day"];
const CARTES_BASE = "https://romy-fr.github.io/MonClimat/meteo/cartes-j6";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, tries = 5) {
  let last = "";
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "mon-assistant-donnees (GitHub Actions)", Accept: "application/json" } });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = String(e);
    }
    console.log(`Essai ${i}/${tries} échoué (${last}).`);
    if (i < tries) await sleep(15000 * i);
  }
  throw new Error(`Open-Meteo injoignable : ${last}`);
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r0 = (x) => (x == null ? null : Math.round(x));

/** Coupe les valeurs manquantes de la fin (AROME s'arrête vers J+2) et arrondit. */
function block(h, model, n) {
  const key = (v) => h[`${v}_${model}`] ?? [];
  const t = key("temperature_2m");
  let len = t.length;
  while (len > 0 && t[len - 1] == null) len--;
  const cut = (arr, f) => arr.slice(0, len).map(f);
  const out = {
    t: cut(t, r1),
    mm: cut(key("precipitation"), r1),
    w: cut(key("wind_speed_10m"), r0),
    g: cut(key("wind_gusts_10m"), r0),
    c: cut(key("weather_code"), r0),
    d: cut(key("is_day"), r0),
  };
  if (len < n) throw new Error(`${model} : ${len} heures seulement (au moins ${n} attendues).`);
  for (const [k, arr] of Object.entries(out)) {
    if (arr.some((v) => v == null)) throw new Error(`${model} : valeurs manquantes dans « ${k} ».`);
  }
  if (out.t.some((v) => v < -45 || v > 55)) throw new Error(`${model} : température hors plage plausible.`);
  return out;
}

const params = new URLSearchParams({
  latitude: CITIES.map((c) => c[1]).join(","),
  longitude: CITIES.map((c) => c[2]).join(","),
  hourly: VARS.join(","),
  models: MODELS.join(","),
  forecast_days: "7",
  timezone: "Europe/Paris",
  wind_speed_unit: "kmh",
});
const res = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
const list = Array.isArray(res) ? res : [res];
if (list.length !== CITIES.length) throw new Error(`Réponse inattendue : ${list.length} villes au lieu de ${CITIES.length}.`);

const cities = {};
CITIES.forEach(([id], i) => {
  const h = list[i].hourly;
  cities[id] = {
    start: h.time[0],
    arome: block(h, MODELS[0], 48), // J+0 et J+1 complets
    ifs: block(h, MODELS[1], 168), // 7 jours
  };
});

// Les cartes (GFS, IFS, AIGFS, AIFS) sont produites chaque jour par le dépôt MonClimat : on garde ici seulement les adresses.
const data = {
  tz: "Europe/Paris",
  cities,
  cartes: { z500: `${CARTES_BASE}/manifest.json`, precip: `${CARTES_BASE}/precip/manifest.json`, base: CARTES_BASE },
};
writeEnvelope("meteo", data, {
  schemaVersion: 1,
  source: "Prévisions Open-Meteo.com (AROME de Météo-France jusqu'à J+1, ECMWF IFS ensuite). Licence CC BY 4.0, usage non commercial.",
});
