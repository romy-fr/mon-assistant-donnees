// Climat : CO2 à Mauna Loa (NOAA GML, domaine public) et émissions annuelles (Our World in Data, CC BY 4.0).
// Écrit data/climat.json. Aucune clé, aucune dépendance. Échoue sans rien écrire si une donnée paraît incohérente.
import { shouldRun } from "./lib/guard.mjs";
import { writeEnvelope } from "./lib/write.mjs";

if (!shouldRun([0])) process.exit(0);

const UA = "MonAssistant-donnees/1.0 (+https://github.com/romy-fr/mon-assistant-donnees)";
const NOAA = "https://gml.noaa.gov/webdata/ccgg/trends/co2";
const OWID = "https://owid-public.owid.io/data/co2/owid-co2-data.csv";

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.text();
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
const pad = (n) => String(n).padStart(2, "0");

/** Lignes de données NOAA : on saute les commentaires (#) et l'éventuel en-tête. */
function noaaRows(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#") && /^\d/.test(l))
    .map((l) => l.split(",").map((x) => Number(x.trim())));
}

function assertRange(name, v, lo, hi) {
  if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${name} incohérent : ${v}`);
}

/* ---------- CO2 ---------- */
const [dailyTxt, monthlyTxt, annualTxt] = await Promise.all([get(`${NOAA}/co2_daily_mlo.csv`), get(`${NOAA}/co2_mm_mlo.csv`), get(`${NOAA}/co2_annmean_mlo.csv`)]);

// Jour : année, mois, jour, date décimale, ppm (-999.99 = manquant)
const daily = noaaRows(dailyTxt)
  .filter((r) => r.length >= 5 && r[4] > 0)
  .map((r) => [`${r[0]}-${pad(r[1])}-${pad(r[2])}`, round(r[4], 2)]);
// 400 derniers jours calendaires : 365 jours affichés + de quoi comparer à l'an dernier (les jours sans mesure sont simplement absents)
const lastDay = new Date(`${daily[daily.length - 1][0]}T00:00:00Z`).getTime();
const jour = daily.filter(([iso]) => lastDay - new Date(`${iso}T00:00:00Z`).getTime() <= 400 * 86400000);

// Mois : année, mois, date décimale, moyenne, désaisonnalisée (tendance), ... (-99.99 = manquant)
const monthly = noaaRows(monthlyTxt).filter((r) => r.length >= 5 && r[3] > 0);
const last120 = monthly.slice(-120);
const mois = {
  pts: last120.map((r) => [`${r[0]}-${pad(r[1])}`, round(r[3], 2)]),
  trend: last120.map((r) => (r[4] > 0 ? round(r[4], 2) : null)),
};

// An : année, moyenne, incertitude
const an = noaaRows(annualTxt)
  .filter((r) => r.length >= 2 && r[1] > 0)
  .map((r) => [r[0], round(r[1], 2)]);

for (const [n, arr] of [["jour", jour], ["mois", mois.pts], ["an", an]]) {
  if (arr.length < 12) throw new Error(`Série CO2 « ${n} » trop courte : ${arr.length}`);
  for (const p of arr) assertRange(`CO2 ${n} ${p[0]}`, p[1], 300, 500);
}

/** Écart sur un an : point le plus proche de la même date un an avant (jour : à 5 jours près). */
function yearAgoDaily(series) {
  const [iso, v] = series[series.length - 1];
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  const target = d.getTime();
  let best = null;
  for (const p of series) {
    const diff = Math.abs(new Date(`${p[0]}T00:00:00Z`).getTime() - target);
    if (diff <= 5 * 86400000 && (!best || diff < best.diff)) best = { diff, p };
  }
  return best ? { last: [iso, v], before: best.p, diff: round(v - best.p[1], 2) } : null;
}
const lastM = mois.pts[mois.pts.length - 1];
const [ly, lm] = lastM[0].split("-").map(Number);
const beforeM = mois.pts.find((p) => p[0] === `${ly - 1}-${pad(lm)}`);
const lastA = an[an.length - 1];
const beforeA = an[an.length - 2];

/* ---------- Émissions (OWID) ---------- */
const owidTxt = await get(OWID);

/** Découpe d'une ligne CSV avec guillemets. */
function csvLine(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const lines = owidTxt.split(/\r?\n/);
const head = csvLine(lines[0]);
const col = (name) => {
  const i = head.indexOf(name);
  if (i < 0) throw new Error(`Colonne OWID absente : ${name}`);
  return i;
};
const C = { country: col("country"), year: col("year"), co2: col("co2"), ghg: col("total_ghg"), coal: col("coal_co2"), oil: col("oil_co2"), gas: col("gas_co2"), cement: col("cement_co2"), flaring: col("flaring_co2"), other: col("other_industry_co2") };

const byCountry = { World: [], France: [] };
for (let i = 1; i < lines.length; i++) {
  const l = lines[i];
  if (!l.startsWith("World,") && !l.startsWith("France,")) continue;
  const f = csvLine(l);
  if (byCountry[f[C.country]]) byCountry[f[C.country]].push(f);
}
const num = (f, k) => (f[C[k]] === "" || f[C[k]] == null ? null : Number(f[C[k]]));
const series = (rows, k, from, div, d) => rows.filter((f) => Number(f[C.year]) >= from && num(f, k) != null).map((f) => [Number(f[C.year]), round(num(f, k) / div, d)]);

const worldGhg = series(byCountry.World, "ghg", 1990, 1000, 2); // Gt CO2e
const worldCo2 = series(byCountry.World, "co2", 1990, 1000, 2); // Gt CO2
const franceGhg = series(byCountry.France, "ghg", 1990, 1, 1); // Mt CO2e
const franceCo2 = series(byCountry.France, "co2", 1990, 1, 1); // Mt CO2
if (worldGhg.length < 20 || worldCo2.length < 20 || franceGhg.length < 20) throw new Error("Séries d'émissions trop courtes");
for (const p of worldGhg) assertRange(`GES monde ${p[0]}`, p[1], 20, 80);
for (const p of worldCo2) assertRange(`CO2 monde ${p[0]}`, p[1], 15, 60);
for (const p of franceGhg) assertRange(`GES France ${p[0]}`, p[1], 150, 800);

// Répartition du CO2 mondial de la dernière année complète, par source
const yearCo2 = worldCo2[worldCo2.length - 1][0];
const wr = byCountry.World.find((f) => Number(f[C.year]) === yearCo2);
const parts = [
  ["charbon", "Charbon", "coal"],
  ["petrole", "Pétrole", "oil"],
  ["gaz", "Gaz", "gas"],
  ["ciment", "Ciment", "cement"],
  ["torchage", "Torchage du gaz", "flaring"],
  ["autres", "Autres industries", "other"],
]
  .map(([key, name, k]) => ({ key, name, mt: num(wr, k) == null ? null : round(num(wr, k), 0) }))
  .filter((p) => p.mt != null && p.mt > 0);
const totalMt = round(num(wr, "co2"), 0);
const sumParts = parts.reduce((s, p) => s + p.mt, 0);
if (Math.abs(sumParts - totalMt) / totalMt > 0.05) throw new Error(`Répartition CO2 incohérente : ${sumParts} contre ${totalMt}`);

/* ---------- Écriture ---------- */
const data = {
  co2: {
    station: "Mauna Loa (Hawaï)",
    jour,
    mois,
    an,
    dernier: {
      jour: yearAgoDaily(jour),
      mois: { last: lastM, before: beforeM ?? null, diff: beforeM ? round(lastM[1] - beforeM[1], 2) : null },
      an: { last: lastA, before: beforeA, diff: round(lastA[1] - beforeA[1], 2) },
    },
  },
  emissions: {
    monde: { unite: "Gt CO₂e", total: worldGhg, co2: worldCo2, uniteCo2: "Gt CO₂" },
    france: { unite: "Mt CO₂e", total: franceGhg, co2: franceCo2, uniteCo2: "Mt CO₂" },
    repartitionCo2: { annee: yearCo2, totalMt, parts },
  },
  sources: [
    {
      id: "noaa",
      name: "Concentration de CO₂ dans l'air, Mauna Loa",
      producer: "NOAA, Global Monitoring Laboratory",
      licence: "Données publiques (États-Unis), à citer : NOAA GML",
      url: "https://gml.noaa.gov/ccgg/trends/",
    },
    {
      id: "owid",
      name: "Émissions de gaz à effet de serre et de CO₂",
      producer: "Our World in Data, à partir du Global Carbon Budget (CO₂) et de Jones et al. (gaz à effet de serre)",
      licence: "Creative Commons BY 4.0",
      url: "https://github.com/owid/co2-data",
    },
  ],
};

writeEnvelope("climat", data, { schemaVersion: 1, source: "NOAA GML ; Our World in Data (CC BY 4.0)" });
