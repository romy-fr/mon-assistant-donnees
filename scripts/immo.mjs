// Immobilier : prix de vente au m² (DVF géolocalisé, DGFiP/Etalab), loyers d'annonce (Carte des loyers ANIL) et IRL (Insee).
//
// RGPD / DGFiP : aucune transaction individuelle ni adresse n'est écrite. Seuls des agrégats (médiane, P10, P90, nombre de
// ventes) par secteur sont publiés, avec un nombre minimal de ventes par agrégat.
//
// Usage : node scripts/immo.mjs  (FORCE=1 pour ignorer la garde horaire ; IMMO_FILES=chemin1,chemin2 pour tester sur des
// fichiers locaux au lieu de télécharger).

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";
import { StringDecoder } from "node:string_decoder";
import { shouldRun } from "./lib/guard.mjs";
import { writeEnvelope } from "./lib/write.mjs";

// ---------------------------------------------------------------------------------------------------------------------
// Configuration : villes suivies. Modifiable ici (ajouter une ville = une ligne).
//   communes : codes INSEE des communes DVF qui composent la ville
//   secteurs : "arrondissement" (une commune DVF par arrondissement) ou "codepostal" (découpage par code postal)
// ---------------------------------------------------------------------------------------------------------------------
const range = (start, n) => Array.from({ length: n }, (_, i) => String(start + i));
export const VILLES = [
  { id: "paris", nom: "Paris", communes: range(75101, 20), secteurs: "arrondissement" },
  { id: "marseille", nom: "Marseille", communes: range(13201, 16), secteurs: "arrondissement" },
  { id: "lyon", nom: "Lyon", communes: range(69381, 9), secteurs: "arrondissement" },
  { id: "toulouse", nom: "Toulouse", communes: ["31555"], secteurs: "codepostal" },
  { id: "nice", nom: "Nice", communes: ["06088"], secteurs: "codepostal" },
  { id: "nantes", nom: "Nantes", communes: ["44109"], secteurs: "codepostal" },
  { id: "montpellier", nom: "Montpellier", communes: ["34172"], secteurs: "codepostal" },
  { id: "toulon", nom: "Toulon", communes: ["83137"], secteurs: "codepostal" },
  { id: "bordeaux", nom: "Bordeaux", communes: ["33063"], secteurs: "codepostal" },
  { id: "lille", nom: "Lille", communes: ["59350"], secteurs: "codepostal" },
  { id: "rennes", nom: "Rennes", communes: ["35238"], secteurs: "codepostal" },
  { id: "reims", nom: "Reims", communes: ["51454"], secteurs: "codepostal" },
  { id: "grenoble", nom: "Grenoble", communes: ["38185"], secteurs: "codepostal" },
  { id: "dijon", nom: "Dijon", communes: ["21231"], secteurs: "codepostal" },
  { id: "angers", nom: "Angers", communes: ["49007"], secteurs: "codepostal" },
];

const MIN_VENTES_SECTEUR = 10; // en dessous : pas de chiffre publié
const MIN_VENTES_TRIMESTRE = 8; // point d'une courbe trimestrielle
const FENETRE_MOIS = 36; // période des statistiques « actuelles »
const PRIX_M2_MIN = 400;
const PRIX_M2_MAX = 30000;
const SURFACE_MIN = 9;
const SURFACE_MAX = { Appartement: 300, Maison: 500 };

const UA = "mon-assistant-donnees/1.0 (actualisation mensuelle de données ouvertes)";
const DVF_DATASET = "https://www.data.gouv.fr/api/1/datasets/5cc1b94a634f4165e96436c1/";
const ANIL_DATASET = "https://www.data.gouv.fr/api/1/datasets/693aa2feed1bf4da603faa49/";
const IRL_URL = "https://bdm.insee.fr/series/sdmx/data/SERIES_BDM/001515333?lastNObservations=12";

// ---------------------------------------------------------------------------------------------------------------------
// Réseau
// ---------------------------------------------------------------------------------------------------------------------
async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
  return res.json();
}

async function getBuffer(url, retries = 2) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (!res.ok) throw new Error(`${url} : HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (i >= retries) throw e;
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

/** Fichiers DVF nationaux de la dernière livraison, résolus par l'API data.gouv (pas de lien en dur). */
async function resolveDvfFiles() {
  const ds = await getJson(DVF_DATASET);
  const files = ds.resources
    .filter((r) => /\/full-(\d{4})(-s\d)?\.csv\.gz$/.test(r.url))
    .map((r) => ({ title: r.title, url: r.url, lastModified: r.last_modified, size: r.filesize }))
    .sort((a, b) => a.url.localeCompare(b.url));
  if (files.length < 4) throw new Error(`DVF : seulement ${files.length} fichier(s) annuel(s) trouvé(s) dans le jeu de données.`);
  return { files, license: ds.license, lastModified: ds.last_modified };
}

async function openCsvStream(source) {
  if (source.startsWith("http")) {
    const res = await fetch(source, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!res.ok) throw new Error(`${source} : HTTP ${res.status}`);
    return Readable.fromWeb(res.body).pipe(createGunzip());
  }
  const raw = createReadStream(source);
  return source.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
}

// ---------------------------------------------------------------------------------------------------------------------
// CSV : analyse d'une ligne en tenant compte des guillemets
// ---------------------------------------------------------------------------------------------------------------------
function splitCsv(line, max = Infinity) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (q) {
      if (c === 34) {
        if (line.charCodeAt(i + 1) === 34) {
          cur += '"';
          i++;
        } else q = false;
      } else cur += line[i];
    } else if (c === 34) q = true;
    else if (c === 44) {
      out.push(cur);
      cur = "";
      if (out.length >= max) return out;
    } else cur += line[i];
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// DVF : sélection des ventes de logements
// ---------------------------------------------------------------------------------------------------------------------
const communeToVille = new Map();
const villeById = new Map();
for (const v of VILLES) {
  villeById.set(v.id, v);
  for (const c of v.communes) communeToVille.set(c, v);
}

/** Mois compté depuis janvier 2000. */
const moisIndex = (d) => (Number(d.slice(0, 4)) - 2000) * 12 + Number(d.slice(5, 7)) - 1;

function ajouterCommune(collector, r, pm2) {
  let c = collector.communes.get(r.commune);
  if (!c) {
    c = { nom: r.nom, cps: new Set(), appartement: [], maison: [] };
    collector.communes.set(r.commune, c);
  }
  if (r.cp) c.cps.add(r.cp);
  c[r.type === "Appartement" ? "appartement" : "maison"].push(Math.round(pm2) * 1024 + moisIndex(r.date));
}

/** Fichiers par département et index de recherche : communes ayant assez de ventes pour au moins un type de bien. */
function ecrireCommunes(collector, { seuilDate, maxDate, trimestres, loyers, source }) {
  const parDept = new Map();
  const index = [];
  const depuis = moisIndex(seuilDate);
  const trimestreDe = (m) => `${2000 + Math.floor(m / 12)}-T${Math.floor((m % 12) / 3) + 1}`;
  const calc = (codes) => {
    const ventes = codes.map((x) => ({ pm2: Math.floor(x / 1024), m: x % 1024 }));
    const st = stats(ventes.filter((v) => v.m >= depuis).map((v) => v.pm2), MIN_VENTES_SECTEUR);
    if (!st) return null;
    const groupes = new Map();
    for (const v of ventes) {
      const q = trimestreDe(v.m);
      if (!groupes.has(q)) groupes.set(q, []);
      groupes.get(q).push(v.pm2);
    }
    const serie = trimestres.map((q) => {
      const s = stats(groupes.get(q) ?? [], MIN_VENTES_TRIMESTRE);
      return s ? { t: q, median: s.median, ventes: s.ventes } : null;
    });
    return { ...st, serie: serie.filter(Boolean).length >= 4 ? serie : null };
  };
  for (const [code, c] of [...collector.communes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const appartement = calc(c.appartement);
    const maison = calc(c.maison);
    if (!appartement && !maison) continue;
    const dept = code.startsWith("97") ? code.slice(0, 3) : code.slice(0, 2);
    const loy = loyers ? { app12: loyers.app12.get(code) ?? null, app3: loyers.app3.get(code) ?? null, maison: loyers.mai.get(code) ?? null } : null;
    if (!parDept.has(dept)) parDept.set(dept, {});
    parDept.get(dept)[code] = { nom: c.nom, appartement, maison, loyers: loy };
    index.push([code, c.nom, [...c.cps].sort().join(" "), (appartement?.ventes ?? 0) + (maison?.ventes ?? 0)]);
  }
  if (index.length < 5000) throw new Error(`Seulement ${index.length} communes publiables : écriture refusée.`);
  for (const [dept, communes] of parDept) writeEnvelope(`immo-communes/${dept}`, { ventesA: maxDate, communes }, { schemaVersion: 1, source });
  writeEnvelope("immo-communes/index", { ventesA: maxDate, communes: index }, { schemaVersion: 1, source });
  console.log(`Communes publiées : ${index.length}, dans ${parDept.size} départements.`);
}

/** Ventes retenues : { villeId, secteurId, secteurNom, type, date (AAAA-MM-JJ), pm2 } */
function newCollector() {
  // communes : toutes les communes de France, une vente = un entier compact (prix au m² et mois), pour la recherche libre.
  return { ventes: [], noms: new Map(), communes: new Map(), mutations: 0, retenues: 0, rejets: { multi: 0, prix: 0, surface: 0, autre: 0 }, maxDate: "", minDate: "9999" };
}

function finishMutation(rows, col, collector) {
  if (rows.length === 0) return;
  collector.mutations++;
  const locals = new Map();
  let autreLocal = false;
  for (const r of rows) {
    const t = r.type;
    if (t === "Appartement" || t === "Maison") {
      const key = `${t}|${r.surf}|${r.pieces}|${r.lot1}|${r.lot2}`;
      if (!locals.has(key)) locals.set(key, r);
    } else if (t.startsWith("Local")) autreLocal = true;
  }
  if (locals.size === 0) return;
  if (locals.size > 1 || autreLocal) {
    collector.rejets.multi++;
    return;
  }
  const r = [...locals.values()][0];
  const surf = Number(r.surf);
  if (!(surf >= SURFACE_MIN && surf <= SURFACE_MAX[r.type])) {
    collector.rejets.surface++;
    return;
  }
  const prix = Number(r.valeur);
  const pm2 = prix / surf;
  if (!(prix > 0) || !(pm2 >= PRIX_M2_MIN && pm2 <= PRIX_M2_MAX)) {
    collector.rejets.prix++;
    return;
  }
  ajouterCommune(collector, r, pm2);
  const ville = communeToVille.get(r.commune);
  if (!ville) return;
  const secteurId = ville.secteurs === "arrondissement" ? r.commune : r.cp;
  if (!secteurId) {
    collector.rejets.autre++;
    return;
  }
  if (ville.secteurs === "arrondissement" && !collector.noms.has(secteurId)) collector.noms.set(secteurId, r.nom);
  collector.retenues++;
  if (r.date > collector.maxDate) collector.maxDate = r.date;
  if (r.date < collector.minDate) collector.minDate = r.date;
  collector.ventes.push({ villeId: ville.id, secteurId, type: r.type === "Appartement" ? "appartement" : "maison", date: r.date, pm2 });
}

async function processDvf(source, collector) {
  const stream = await openCsvStream(source);
  const dec = new StringDecoder("utf8");
  let rest = "";
  let header = null;
  let col = null;
  let currentId = null;
  let rows = [];
  let lignes = 0;
  const handle = (line) => {
    if (!line) return;
    if (!header) {
      header = splitCsv(line);
      col = Object.fromEntries(header.map((h, i) => [h, i]));
      for (const need of ["id_mutation", "date_mutation", "nature_mutation", "valeur_fonciere", "code_postal", "code_commune", "nom_commune", "lot1_numero", "lot2_numero", "type_local", "surface_reelle_bati", "nombre_pieces_principales"]) {
        if (!(need in col)) throw new Error(`Colonne DVF absente : ${need}`);
      }
      return;
    }
    lignes++;
    // Filtre rapide : on n'analyse en détail que les lignes d'une commune suivie.
    const f = splitCsv(line, col.nombre_pieces_principales + 1);
    const commune = f[col.code_commune];
    if (!commune) return;
    const id = f[col.id_mutation];
    if (id !== currentId) {
      finishMutation(rows, col, collector);
      rows = [];
      currentId = id;
    }
    if (f[col.nature_mutation] !== "Vente") return;
    rows.push({
      date: f[col.date_mutation],
      valeur: f[col.valeur_fonciere],
      cp: f[col.code_postal],
      commune,
      nom: f[col.nom_commune],
      lot1: f[col.lot1_numero],
      lot2: f[col.lot2_numero],
      type: f[col.type_local],
      surf: f[col.surface_reelle_bati],
      pieces: f[col.nombre_pieces_principales],
      valeurNum: undefined,
    });
  };
  for await (const chunk of stream) {
    rest += dec.write(chunk);
    let start = 0;
    let nl;
    while ((nl = rest.indexOf("\n", start)) !== -1) {
      handle(rest.slice(start, nl).replace(/\r$/, ""));
      start = nl + 1;
    }
    rest = rest.slice(start);
  }
  rest += dec.end();
  if (rest) handle(rest.replace(/\r$/, ""));
  finishMutation(rows, col, collector);
  return lignes;
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------------------------------------------------------------
function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(values, min) {
  if (values.length < min) return null;
  const s = [...values].sort((a, b) => a - b);
  return { median: Math.round(percentile(s, 0.5)), p10: Math.round(percentile(s, 0.1)), p90: Math.round(percentile(s, 0.9)), ventes: s.length };
}

const quarterOf = (date) => `${date.slice(0, 4)}-T${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;

function addMonths(dateIso, delta) {
  const d = new Date(`${dateIso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  return d.toISOString().slice(0, 10);
}

function buildAgg(ventes, seuilDate, quarters) {
  const out = {};
  for (const type of ["appartement", "maison"]) {
    const mine = ventes.filter((v) => v.type === type);
    const recent = mine.filter((v) => v.date >= seuilDate).map((v) => v.pm2);
    const st = stats(recent, MIN_VENTES_SECTEUR);
    const serie = quarters.map((q) => {
      const s = stats(mine.filter((v) => quarterOf(v.date) === q).map((v) => v.pm2), MIN_VENTES_TRIMESTRE);
      return s ? { t: q, median: s.median, ventes: s.ventes } : null;
    });
    const series = serie.some(Boolean) ? serie : null;
    out[type] = st ? { ...st, serie: series } : null;
  }
  return out;
}

/** « Lyon 1Er » / « Paris 12Eme Arrondissement » -> « Lyon 1er arrondissement » / « Paris 12e arrondissement ». */
function nomArrondissement(nom) {
  let n = String(nom).replace(/\s*Arrondissement$/i, "");
  const nu = n.match(/^(.*\D)\s0?(\d+)$/); // « Paris 01 », « Paris 12 »
  if (nu) n = `${nu[1]} ${Number(nu[2]) === 1 ? "1er" : `${Number(nu[2])}e`}`;
  n = n.replace(/\b(\d+)er\b/i, "$1er").replace(/\b(\d+)(?:eme|ème|e)\b/i, "$1e");
  return `${n} arrondissement`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Loyers ANIL (Carte des loyers), IRL (Insee)
// ---------------------------------------------------------------------------------------------------------------------
function parseAnil(buffer) {
  const text = new TextDecoder("windows-1252").decode(buffer);
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(";").map((h) => h.replace(/"/g, ""));
  const idx = Object.fromEntries(head.map((h, i) => [h, i]));
  for (const need of ["INSEE_C", "loypredm2", "lwr.IPm2", "upr.IPm2", "TYPPRED", "nbobs_com"]) if (!(need in idx)) throw new Error(`Colonne ANIL absente : ${need}`);
  const num = (s) => Number(String(s).replace(/"/g, "").replace(",", "."));
  const map = new Map();
  for (const l of lines.slice(1)) {
    const f = l.split(";").map((x) => x.replace(/^"|"$/g, ""));
    const code = f[idx.INSEE_C];
    const v = num(f[idx.loypredm2]);
    if (!Number.isFinite(v)) continue;
    map.set(code, { loyer: Math.round(v * 10) / 10, bas: Math.round(num(f[idx["lwr.IPm2"]]) * 10) / 10, haut: Math.round(num(f[idx["upr.IPm2"]]) * 10) / 10, estimation: f[idx.TYPPRED], annonces: Number(f[idx.nbobs_com]) || 0 });
  }
  return map;
}

async function loadLoyers() {
  const ds = await getJson(ANIL_DATASET);
  const find = (re) => {
    const r = ds.resources.find((x) => re.test(x.url));
    if (!r) throw new Error(`Fichier ANIL introuvable : ${re}`);
    return r.url;
  };
  const [app12, app3, mai] = await Promise.all([find(/pred-app12-mef-dhup\.csv$/), find(/pred-app3-mef-dhup\.csv$/), find(/pred-mai-mef-dhup\.csv$/)].map(async (u) => parseAnil(await getBuffer(await u))));
  return { app12, app3, mai, titre: ds.title, lastModified: ds.last_modified, licence: ds.license };
}

async function loadIrl() {
  try {
    const res = await fetch(IRL_URL, { headers: { "User-Agent": UA, Accept: "application/xml" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const obs = [...xml.matchAll(/<Obs TIME_PERIOD="(\d{4})-Q(\d)" OBS_VALUE="([\d.]+)"/g)].map((m) => ({ t: `${m[1]}-T${m[2]}`, valeur: Number(m[3]) }));
    const lastUpdate = (xml.match(/LAST_UPDATE="([\d-]+)"/) ?? [])[1] ?? null;
    if (obs.length < 5) throw new Error("trop peu d'observations");
    obs.sort((a, b) => a.t.localeCompare(b.t));
    const last = obs[obs.length - 1];
    const prev = obs.find((o) => o.t === `${Number(last.t.slice(0, 4)) - 1}-${last.t.slice(5)}`);
    return { serie: obs, dernier: last, variationAnnuelle: prev ? Math.round(((last.valeur / prev.valeur - 1) * 100) * 100) / 100 : null, misAJour: lastUpdate };
  } catch (e) {
    console.warn(`IRL indisponible : ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Programme principal
// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  if (!shouldRun("immo", { hours: [5], monthDays: [1] })) return;
  const t0 = Date.now();
  const local = process.env.IMMO_FILES ? process.env.IMMO_FILES.split(",") : null;
  let dvf = { files: [], license: "lov2", lastModified: null };
  if (!local) dvf = await resolveDvfFiles();
  const sources = local ?? dvf.files.map((f) => f.url);

  const collector = newCollector();
  for (const s of sources) {
    const t1 = Date.now();
    const lignes = await processDvf(s, collector);
    console.log(`DVF ${s.split("/").pop()} : ${lignes} lignes, ${collector.retenues} ventes retenues au total (${Math.round((Date.now() - t1) / 1000)} s)`);
  }
  console.log("Rejets :", JSON.stringify(collector.rejets), "mutations vues :", collector.mutations);
  if (collector.retenues < 10000) throw new Error(`Trop peu de ventes retenues (${collector.retenues}) : écriture refusée.`);

  const maxDate = collector.maxDate;
  const seuilDate = addMonths(maxDate, -FENETRE_MOIS);
  const quarters = [];
  for (let d = addMonths(maxDate, -57); d <= maxDate; d = addMonths(d, 3)) {
    const q = quarterOf(d);
    if (!quarters.includes(q)) quarters.push(q);
  }
  // On garde les 20 derniers trimestres complets ou en cours.
  const trimestres = quarters.slice(-20);

  let loyers = null;
  try {
    loyers = await loadLoyers();
  } catch (e) {
    console.warn(`Loyers ANIL indisponibles : ${e.message}`);
  }
  const irl = await loadIrl();

  const villes = [];
  for (const v of VILLES) {
    const ventesVille = collector.ventes.filter((x) => x.villeId === v.id);
    if (ventesVille.length === 0) {
      console.warn(`Aucune vente retenue pour ${v.nom} : ville ignorée (vérifier les codes communes).`);
      continue;
    }
    const agg = buildAgg(ventesVille, seuilDate, trimestres);
    const secIds = [...new Set(ventesVille.map((x) => x.secteurId))].sort();
    const secteurs = [];
    for (const sid of secIds) {
      const a = buildAgg(ventesVille.filter((x) => x.secteurId === sid), seuilDate, trimestres);
      if (!a.appartement && !a.maison) continue;
      const communeCode = v.secteurs === "arrondissement" ? sid : v.communes[0];
      const loy = loyers
        ? {
            app12: loyers.app12.get(communeCode) ?? null,
            app3: loyers.app3.get(communeCode) ?? null,
            maison: loyers.mai.get(communeCode) ?? null,
          }
        : null;
      secteurs.push({
        id: `${v.id}-${sid}`,
        nom: v.secteurs === "arrondissement" ? nomArrondissement(collector.noms.get(sid) ?? sid) : `Code postal ${sid}`,
        type: v.secteurs,
        appartement: a.appartement,
        maison: a.maison,
        loyers: loy,
      });
    }
    const communeVille = v.communes.length === 1 ? v.communes[0] : null;
    let loyVille = null;
    if (loyers && communeVille) {
      loyVille = { app12: loyers.app12.get(communeVille) ?? null, app3: loyers.app3.get(communeVille) ?? null, maison: loyers.mai.get(communeVille) ?? null };
    } else if (loyers) {
      // Ville à arrondissements : l'ANIL ne publie que les arrondissements. Moyenne pondérée par le nombre de ventes
      // d'appartements de chaque arrondissement (indiquée comme telle).
      const moy = (key) => {
        let s = 0;
        let w = 0;
        let bas = 0;
        let haut = 0;
        for (const sec of secteurs) {
          const l = sec.loyers?.[key];
          const poids = sec.appartement?.ventes ?? sec.maison?.ventes ?? 0;
          if (!l || !poids) continue;
          s += l.loyer * poids;
          bas += l.bas * poids;
          haut += l.haut * poids;
          w += poids;
        }
        const r = (x) => Math.round((x / w) * 10) / 10;
        return w > 0 ? { loyer: r(s), bas: r(bas), haut: r(haut), estimation: "moyenne pondérée des arrondissements", annonces: 0 } : null;
      };
      loyVille = { app12: moy("app12"), app3: moy("app3"), maison: moy("maison") };
    }
    villes.push({ id: v.id, nom: v.nom, secteurType: v.secteurs, appartement: agg.appartement, maison: agg.maison, loyers: loyVille, secteurs });
  }

  const data = {
    periode: { ventesDe: collector.minDate, ventesA: maxDate, fenetreStatsMois: FENETRE_MOIS, seuilMinVentes: MIN_VENTES_SECTEUR, trimestres },
    villes,
    irl,
    sources: {
      dvf: { nom: "Demandes de valeurs foncières géolocalisées (DGFiP, Etalab)", licence: "Licence Ouverte 2.0", livraison: dvf.lastModified ?? null },
      loyers: loyers ? { nom: loyers.titre, mention: "Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin", licence: "Licence Ouverte 2.0", misAJour: loyers.lastModified } : null,
      irl: irl ? { nom: "Indice de référence des loyers (Insee)", misAJour: irl.misAJour } : null,
    },
  };
  const source = "DVF (DGFiP, Etalab) ; Carte des loyers (ANIL) ; Insee — Licence Ouverte 2.0";
  const ok = writeEnvelope("immo", data, { schemaVersion: 1, source });
  ecrireCommunes(collector, { seuilDate, maxDate, trimestres, loyers, source });
  console.log(`Terminé en ${Math.round((Date.now() - t0) / 1000)} s (${ok ? "écrit" : "inchangé"}) : ${villes.length} villes, ${villes.reduce((n, v) => n + v.secteurs.length, 0)} secteurs.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
