// Économie : séries officielles (Insee BDM, BCE, Eurostat) -> data/eco.json
// Node 20+, fetch natif, aucune dépendance. Usage : node scripts/eco.mjs   (FORCE=1 pour ignorer la garde horaire)
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shouldRun } from "./lib/guard.mjs";
import { writeEnvelope } from "./lib/write.mjs";

// Hebdomadaire : lundi 7 h (Paris). 7 ou 8 h acceptées pour absorber le retard des tâches programmées.
if (!shouldRun("eco", { hours: [7], weekdays: [1] })) process.exit(0);

const UA = "MonAssistantDataBot/1.0 (GitHub Actions; open-data refresh)";
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, accept = "*/*") {
  let last;
  for (let k = 0; k < 4; k++) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) return await res.text();
      last = new Error(`HTTP ${res.status} pour ${url}`);
    } catch (e) {
      last = e;
    }
    await sleep(1500 * (k + 1));
  }
  throw last;
}

// ---- Périodes ----
const ord = {
  m: (p) => { const [y, m] = p.split("-").map(Number); return y * 12 + m - 1; },
  q: (p) => { const [y, q] = p.split("-Q").map(Number); return y * 4 + q - 1; },
  y: (p) => Number(p),
};
const label = {
  m: (p) => { const [y, m] = p.split("-").map(Number); return `${MONTHS[m - 1]} ${y}`; },
  q: (p) => { const [y, q] = p.split("-Q").map(Number); return `${q === 1 ? "1er" : `${q}e`} trimestre ${y}`; },
  y: (p) => `année ${p}`,
};
const back = { m: 12, q: 4, y: null };

/** Garde la dernière suite de périodes consécutives (sans trou), du plus ancien au plus récent. */
function contiguous(kind, pts) {
  const out = [];
  for (let k = pts.length - 1; k >= 0; k--) {
    if (out.length && ord[kind](out[0].t) - ord[kind](pts[k].t) !== 1) break;
    out.unshift(pts[k]);
  }
  return out;
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Construit l'objet indicateur à partir d'une série ordonnée [{t, v}]. */
function build(id, kind, pts, { dec, updatedOn, source, period, prevLabel }) {
  const run = contiguous(kind, pts);
  if (run.length < 3) throw new Error(`${id}: série trop courte (${run.length})`);
  const last = run[run.length - 1];
  const prev = run[run.length - 2];
  const ago = back[kind] ? run[run.length - 1 - back[kind]] : undefined;
  const o = {
    id,
    value: round(last.v, dec),
    period: period ?? label[kind](last.t),
    prev: round(prev.v, dec),
    prevLabel: prevLabel ?? label[kind](prev.t),
    source,
    updatedOn,
    series: { kind, end: last.t, values: run.map((p) => round(p.v, Math.max(dec, 2))) },
  };
  if (ago) {
    o.yearAgo = round(ago.v, dec);
    o.yearAgoLabel = label[kind](ago.t);
  }
  return o;
}

// ---- Insee BDM (SDMX-ML) ----
async function insee(id, idbank, kind, nObs, { dec, scale = 1 }) {
  const xml = await get(`https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/${idbank}?lastNObservations=${nObs}`, "application/xml");
  const attrs = /<Series ([^>]*)>/.exec(xml)?.[1] ?? "";
  const updatedOn = /LAST_UPDATE="([^"]*)"/.exec(attrs)?.[1] ?? "";
  const pts = [...xml.matchAll(/<Obs TIME_PERIOD="([^"]*)" OBS_VALUE="([^"]*)"/g)]
    .map((m) => ({ t: m[1], v: Number(m[2]) * scale }))
    .filter((p) => Number.isFinite(p.v))
    .sort((a, b) => ord[kind](a.t) - ord[kind](b.t));
  return build(id, kind, pts, { dec, updatedOn, source: "Insee" });
}

// ---- BCE (JSON SDMX) ----
async function ecb(path, extra = "") {
  const text = await get(`https://data-api.ecb.europa.eu/service/data/${path}?format=jsondata${extra}`, "application/json");
  const o = JSON.parse(text);
  const series = Object.values(o.dataSets[0].series)[0];
  const times = o.structure.dimensions.observation[0].values;
  const pts = Object.entries(series.observations).map(([i, v]) => ({ t: times[i].id, v: v[0] }));
  return { pts, prepared: String(o.header?.prepared ?? "").slice(0, 10) };
}

/** Taux de la facilité de dépôt : valeur en vigueur, date du dernier changement, courbe mensuelle (fin de mois). */
async function bceDepot() {
  const { pts, prepared } = await ecb("FM/D.U2.EUR.4F.KR.DFR.LEV", "&startPeriod=2012-01-01");
  const daily = pts.filter((p) => Number.isFinite(p.v));
  const cur = daily[daily.length - 1];
  let k = daily.length - 1;
  while (k > 0 && daily[k - 1].v === cur.v) k--;
  const since = daily[k].t; // premier jour du taux actuel
  const before = k > 0 ? daily[k - 1].v : undefined;
  const byMonth = new Map();
  for (const p of daily) byMonth.set(p.t.slice(0, 7), p.v); // dernière valeur de chaque mois
  const months = [...byMonth].map(([t, v]) => ({ t, v }));
  const [y, m, d] = since.split("-").map(Number);
  const o = build("x8", "m", months, {
    dec: 2,
    updatedOn: prepared,
    source: "BCE",
    period: `en vigueur depuis le ${d === 1 ? "1er" : d} ${MONTHS[m - 1]} ${y}`,
    prevLabel: "taux précédent",
  });
  if (before !== undefined) o.prev = round(before, 2);
  else delete o.prev;
  delete o.yearAgo;
  delete o.yearAgoLabel;
  return o;
}

async function bceOat() {
  const { pts, prepared } = await ecb("IRS/M.FR.L.L40.CI.0000.EUR.N.Z", "&lastNObservations=132");
  const clean = pts.filter((p) => Number.isFinite(p.v)).sort((a, b) => ord.m(a.t) - ord.m(b.t));
  const o = build("x9", "m", clean, { dec: 2, updatedOn: prepared, source: "BCE" });
  o.period = `moyenne ${o.period}`;
  o.prevLabel = `moyenne ${o.prevLabel}`;
  if (o.yearAgoLabel) o.yearAgoLabel = `moyenne ${o.yearAgoLabel}`;
  return o;
}

// ---- Eurostat (JSON-stat) ----
async function eurostatDeficit() {
  const text = await get(
    "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/gov_10dd_edpt1?format=JSON&lang=EN&geo=FR&unit=PC_GDP&sector=S13&na_item=B9&sinceTimePeriod=2004",
    "application/json",
  );
  const o = JSON.parse(text);
  const idx = o.dimension.time.category.index; // { "2010": 0, ... }
  const pts = Object.entries(idx)
    .map(([t, i]) => ({ t, v: o.value[String(i)] }))
    .filter((p) => typeof p.v === "number")
    .sort((a, b) => Number(a.t) - Number(b.t));
  return build("x7", "y", pts, { dec: 1, updatedOn: String(o.updated ?? "").slice(0, 10), source: "Eurostat" });
}

// ---- Exécution ----
const previous = (() => {
  const f = resolve(import.meta.dirname, "..", "data", "eco.json");
  if (!existsSync(f)) return {};
  try {
    return Object.fromEntries(JSON.parse(readFileSync(f, "utf8")).data.indicators.map((i) => [i.id, i]));
  } catch {
    return {};
  }
})();

const jobs = [
  ["x1", () => insee("x1", "011814632", "m", 132, { dec: 1 })],
  ["x2", () => insee("x2", "011794844", "q", 44, { dec: 1 })],
  ["x3", () => insee("x3", "011818543", "q", 44, { dec: 1 })],
  ["x4", () => insee("x4", "010562675", "q", 44, { dec: 1 })],
  ["x5", () => insee("x5", "001568614", "m", 132, { dec: 1, scale: 0.001 })], // millions d'euros -> milliards
  ["x6", () => insee("x6", "010777608", "q", 44, { dec: 1 })],
  ["x7", eurostatDeficit],
  ["x8", bceDepot],
  ["x9", bceOat],
  ["x10", () => insee("x10", "001587668", "m", 132, { dec: 0 })],
  ["x11", () => insee("x11", "001565530", "m", 132, { dec: 1 })],
];

const indicators = [];
const failures = [];
for (const [id, run] of jobs) {
  try {
    indicators.push(await run());
    console.log(`${id}: ok`);
  } catch (e) {
    console.error(`${id}: ÉCHEC (${e.message})`);
    failures.push(id);
    if (previous[id]) indicators.push(previous[id]); // on garde l'ancienne valeur plutôt que de la perdre
  }
  await sleep(300);
}

if (indicators.length === 0) {
  console.error("Aucun indicateur récupéré : fichier non modifié.");
  process.exit(1);
}
// Sécurité : une valeur aberrante (NaN, hors échelle) fait échouer la tâche sans rien écrire.
for (const i of indicators) {
  if (!Number.isFinite(i.value) || Math.abs(i.value) > 1e6 || !i.series?.values?.length) {
    console.error(`${i.id}: valeur invalide, fichier non modifié.`);
    process.exit(1);
  }
}

const SOURCES = "Insee (Licence Ouverte 2.0), Banque centrale européenne, Eurostat. Données officielles, révisables.";
writeEnvelope("eco", { indicators }, { schemaVersion: 1, source: SOURCES });
if (failures.length) console.warn(`Indicateurs conservés de l'ancienne version : ${failures.join(", ")}`);
