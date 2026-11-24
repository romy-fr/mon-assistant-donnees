#!/usr/bin/env node
// Module Lois : textes en discussion et derniers votes, à partir des données ouvertes officielles.
//   - Assemblée nationale (Licence Ouverte 2.0) : dossiers législatifs, scrutins publics, groupes politiques.
//   - Sénat (Licence Ouverte 2.0) : base « dosleg » (dossiers législatifs), pour les textes encore seulement au Sénat.
// Sortie : data/lois.json (enveloppe { schemaVersion, updatedAt, source, data }). Voir docs/lois.md.
// Aucune donnée personnelle : seuls des votes agrégés par groupe politique sont conservés.

import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { parisToday, shouldRun } from "./lib/guard.mjs";
import { writeEnvelope } from "./lib/write.mjs";

const root = resolve(import.meta.dirname, "..");
const META_FILE = join(root, "data", "_meta", "lois-sources.json");
const OUT_FILE = join(root, "data", "lois.json");
const WORK = process.env.LOIS_WORK || join(tmpdir(), "mon-assistant-lois");
const REUSE = process.env.LOIS_REUSE === "1"; // développement : réutilise des archives déjà décompressées
const UA = "MonAssistant-donnees/1.0 (+https://github.com/romy-fr/mon-assistant-donnees)";

const AN = "https://data.assemblee-nationale.fr/static/openData/repository/17";
const SOURCES = {
  scrutins: { url: `${AN}/loi/scrutins/Scrutins.json.zip`, dir: "scr" },
  dossiers: { url: `${AN}/loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip`, dir: "dos" },
  organes: { url: `${AN}/amo/deputes_actifs_mandats_actifs_organes/AMO10_deputes_actifs_mandats_actifs_organes.json.zip`, dir: "amo" },
  senat: { url: "https://data.senat.fr/data/dosleg/dosleg.zip", dir: "sen" },
};

// Fenêtres de sélection (jours) et plafonds.
const AN_WINDOW_DAYS = 120;
const SENAT_WINDOW_DAYS = 60;
const AN_MAX = 60;
const SENAT_MAX = 15;

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const GROUP_ORDER = ["GDR", "LFI-NFP", "LFI", "ECOS", "ECO", "SOC", "LIOT", "DEM", "EPR", "HOR", "DR", "UDR", "RN", "NI"];

// ───────────────────────── Outils généraux ─────────────────────────

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const readJ = (p) => JSON.parse(readFileSync(p, "utf8").replace(/^﻿/, ""));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url, init = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, redirect: "follow", headers: { "User-Agent": UA, ...(init.headers ?? {}) } });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status} pour ${url}`);
      if (res.status < 500 && res.status !== 429) break;
    } catch (e) {
      last = e;
    }
    await sleep(1500 * (i + 1));
  }
  throw last;
}

/** En-têtes de version d'une source (sans la télécharger). */
async function head(url) {
  try {
    const res = await fetchRetry(url, { method: "HEAD" }, 2);
    return { lastModified: res.headers.get("last-modified"), etag: res.headers.get("etag"), length: res.headers.get("content-length") };
  } catch {
    return null;
  }
}

async function downloadAndUnzip(name) {
  const { url, dir } = SOURCES[name];
  const target = join(WORK, dir);
  if (REUSE && existsSync(target)) {
    console.log(`${name}: réutilisation de ${target}`);
    return target;
  }
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const zip = join(WORK, `${dir}.zip`);
  console.log(`${name}: téléchargement…`);
  const res = await fetchRetry(url);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // `unzip` existe sur ubuntu-latest ; sous Windows on retombe sur `tar` (bsdtar sait lire les zip).
  let r = spawnSync("unzip", ["-q", "-o", zip, "-d", target], { stdio: "inherit" });
  if (r.error || r.status !== 0) r = spawnSync("tar", ["-xf", zip, "-C", target], { stdio: "inherit" });
  if (r.error || r.status !== 0) throw new Error(`Décompression impossible pour ${name}`);
  rmSync(zip, { force: true });
  return target;
}

// ───────────────────────── Dates en toutes lettres ─────────────────────────

const iso = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const parts = (d) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)), d: Number(d.slice(8, 10)) });
const day = (n) => (n === 1 ? "1er" : String(n));
const fmtDate = (d) => {
  const p = parts(d);
  return `${day(p.d)} ${MONTHS[p.m - 1]} ${p.y}`;
};
function fmtRange(a, b) {
  if (a === b) return `le ${fmtDate(a)}`;
  const x = parts(a);
  const y = parts(b);
  if (x.y === y.y && x.m === y.m) return `du ${day(x.d)} au ${day(y.d)} ${MONTHS[y.m - 1]} ${y.y}`;
  if (x.y === y.y) return `du ${day(x.d)} ${MONTHS[x.m - 1]} au ${day(y.d)} ${MONTHS[y.m - 1]} ${y.y}`;
  return `du ${fmtDate(a)} au ${fmtDate(b)}`;
}
const daysAgo = (n) => {
  const t = new Date(`${parisToday()}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() - n);
  return t.toISOString().slice(0, 10);
};

// ───────────────────────── Dossiers de l'Assemblée nationale ─────────────────────────

/** Aplatit les actes législatifs en liste chronologique { code, date, top, statut, voteRefs, seq }. */
function flattenActs(list) {
  const out = [];
  const walk = (acts, top) => {
    for (const a of arr(acts)) {
      const code = a.codeActe ?? "";
      const t = top ?? code;
      out.push({
        code,
        top: t,
        date: iso(a.dateActe),
        statut: a.statutConclusion?.libelle ?? null,
        voteRefs: arr(a.voteRefs?.voteRef),
        retrait: !!a.dateRetrait,
        infoJO: a.infoJO ?? null,
        codeLoi: a.codeLoi ?? null,
        seq: out.length,
      });
      if (a.actesLegislatifs?.acteLegislatif) walk(a.actesLegislatifs.acteLegislatif, t);
    }
  };
  walk(list, null);
  return out;
}

const chamberOf = (code) => {
  if (/^SN/.test(code)) return "senat";
  if (/^AN/.test(code)) return "assemblee";
  if (/^CMP/.test(code)) return /-SN/.test(code) ? "senat" : "assemblee";
  return null;
};

/** Étape de l'interface (depot, commission, seance, adopte, promulgue) d'un acte, ou null s'il n'en marque aucune. */
function stageOf(act) {
  const c = act.code;
  if (/PROCACC|RTRINI/.test(c)) return null;
  if (/^PROM/.test(c)) return "promulgue";
  if (/^CC/.test(c)) return "adopte";
  if (/-COM/.test(c)) return "commission";
  if (/-DEC$/.test(c)) return /rejet|désaccord/i.test(act.statut ?? "") ? "seance" : "adopte";
  if (/DEBATS/.test(c)) return "seance";
  if (/DEPOT/.test(c)) return "depot";
  if (/^CMP/.test(c)) return "commission";
  return null;
}

const masculine = (s) => (/^modifi[ée]e?s?$/.test(s.trim()) ? "adopté avec modifications" : s.replace(/ées\b/g, "és").replace(/ée\b/g, "é"));

const READING = {
  SN1: "au Sénat (première lecture)",
  AN1: "à l'Assemblée nationale (première lecture)",
  ANLUNI: "à l'Assemblée nationale (lecture unique)",
  SN2: "au Sénat (deuxième lecture)",
  AN2: "à l'Assemblée nationale (deuxième lecture)",
  SN3: "au Sénat (troisième lecture)",
  AN3: "à l'Assemblée nationale (troisième lecture)",
  ANNLEC: "à l'Assemblée nationale (nouvelle lecture)",
  SNNLEC: "au Sénat (nouvelle lecture)",
  ANLDEF: "à l'Assemblée nationale (lecture définitive)",
  SNLDEF: "au Sénat (lecture définitive)",
  CMP: "en commission mixte paritaire",
};

/** Description neutre, composée uniquement à partir des dates et décisions officielles (aucune interprétation). */
function describe(kind, acts, today) {
  const dated = acts.filter((a) => a.date && a.date <= today);
  const tops = [...new Set(dated.map((a) => a.top))].filter((t) => READING[t]);
  const phrases = [];
  for (const top of tops) {
    const g = dated.filter((a) => a.top === top);
    const depot = g.find((a) => /DEPOT/.test(a.code));
    const com = g.filter((a) => /-COM/.test(a.code) && /-REUNION|-RAPPORT/.test(a.code));
    const saisie = g.find((a) => /-COM/.test(a.code) && /-SAISIE/.test(a.code));
    const seance = g.filter((a) => /DEBATS.*SEANCE|DEBATS-AN$|DEBATS-SN$/.test(a.code));
    const dec = [...g].reverse().find((a) => /-DEC$/.test(a.code) && a.statut);
    const bits = [];
    if (depot) bits.push(`déposé le ${fmtDate(depot.date)}`);
    if (com.length) {
      const ds = com.map((a) => a.date).sort();
      bits.push(`examiné en commission ${fmtRange(ds[0], ds[ds.length - 1])}`);
    } else if (saisie) {
      bits.push(`renvoyé en commission le ${fmtDate(saisie.date)}`);
    }
    if (seance.length) {
      const ds = seance.map((a) => a.date).sort();
      bits.push(`discuté en séance ${fmtRange(ds[0], ds[ds.length - 1])}`);
    }
    if (dec) bits.push(`décision : ${masculine(dec.statut)} le ${fmtDate(dec.date)}`);
    if (bits.length) phrases.push(`${READING[top][0].toUpperCase()}${READING[top].slice(1)} : ${bits.join(", ")}.`);
  }
  const prom = dated.find((a) => /^PROM/.test(a.code));
  if (prom) phrases.push(`Promulgué le ${fmtDate(prom.date)}.`);
  const accel = dated.some((a) => /PROCACC/.test(a.code));
  const head = `${kind}${accel ? ", examiné selon la procédure accélérée" : ""}.`;
  return [head, ...phrases.slice(-3)].join(" ");
}

function analyseDossier(d, today) {
  const proc = d.procedureParlementaire?.libelle ?? "";
  const kind = /^Projet de loi/i.test(proc) ? "Projet de loi" : /^Proposition de loi/i.test(proc) ? "Proposition de loi" : null;
  if (!kind) return null;
  const acts = flattenActs(d.actesLegislatifs?.acteLegislatif);
  if (acts.length === 0 || acts.some((a) => a.retrait)) return null;
  const past = acts.filter((a) => a.date && a.date <= today);
  const marks = past
    .map((a) => ({ a, stage: stageOf(a) }))
    .filter((x) => x.stage)
    .sort((x, y) => (x.a.date < y.a.date ? -1 : x.a.date > y.a.date ? 1 : x.a.seq - y.a.seq));
  if (marks.length === 0) return null;
  const last = marks[marks.length - 1];
  let chamber = "assemblee";
  for (const m of marks) chamber = chamberOf(m.a.code) ?? chamber;
  const tops = new Set(past.map((a) => a.top));
  const concepts = [];
  if ([...tops].some((t) => /^SN/.test(t)) && [...tops].some((t) => /^(AN|CMP)/.test(t))) concepts.push("navette-parlementaire");
  if (past.some((a) => /49, alinéa 3/.test(a.statut ?? ""))) concepts.push("article-49-3");
  const chemin = d.titreDossier?.titreChemin;
  return {
    uid: d.uid,
    title: String(d.titreDossier?.titre ?? "").trim(),
    kind,
    stage: last.stage,
    chamber,
    date: last.a.date,
    acts,
    description: describe(kind, acts, today),
    concepts,
    url: chemin ? `https://www.assemblee-nationale.fr/dyn/17/dossiers/${chemin}` : `https://www.assemblee-nationale.fr/dyn/17/dossiers/${d.uid}`,
    senatChemin: d.titreDossier?.senatChemin ?? null,
    chemin: (chemin ?? "").toLowerCase(),
  };
}

// ───────────────────────── Scrutins et groupes ─────────────────────────

const organeCache = new Map();
function groupInfo(amoDir, ref) {
  if (organeCache.has(ref)) return organeCache.get(ref);
  let info = { sigle: "?", name: "Groupe politique" };
  const f = join(amoDir, "json", "organe", `${ref}.json`);
  if (existsSync(f)) {
    const o = readJ(f).organe ?? {};
    info = { sigle: String(o.libelleAbrege ?? o.libelleAbrev ?? "?").trim(), name: String(o.libelle ?? "Groupe politique").trim() };
  }
  organeCache.set(ref, info);
  return info;
}

const orderOf = (sigle) => {
  const i = GROUP_ORDER.indexOf(String(sigle).toUpperCase());
  return i >= 0 ? i : GROUP_ORDER.indexOf("NI") - 0.5;
};

/** Lit un scrutin et le met au format de l'appli ; renvoie null s'il manque la ventilation par groupe. */
function readScrutin(scrDir, amoDir, uid) {
  const f = join(scrDir, "json", `${uid}.json`);
  if (!existsSync(f)) return null;
  const s = readJ(f).scrutin;
  if (!s) return null;
  const rawGroups = arr(s.ventilationVotes?.organe?.groupes?.groupe);
  const groups = rawGroups
    .map((g) => {
      const info = groupInfo(amoDir, g.organeRef);
      const seats = Number(g.nombreMembresGroupe) || 0;
      const v = g.vote?.decompteVoix ?? {};
      const pour = Number(v.pour) || 0;
      const contre = Number(v.contre) || 0;
      const abstention = Number(v.abstentions) || 0;
      return { name: info.name, sigle: info.sigle, seats, pour, contre, abstention, nonVotants: Math.max(0, seats - pour - contre - abstention) };
    })
    .filter((g) => g.seats > 0)
    .sort((a, b) => orderOf(a.sigle) - orderOf(b.sigle));
  if (groups.length === 0) return null;
  const dec = s.syntheseVote?.decompte ?? {};
  const sum = (k) => groups.reduce((n, g) => n + g[k], 0);
  const sort = String(s.sort?.code ?? "").trim();
  const titre = String(s.titre ?? "").replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const date = iso(s.dateScrutin) ?? "";
  let label = `Vote ${date ? `du ${fmtDate(date)} ` : ""}sur ${titre}`;
  if (sort) label += ` — ${sort}`;
  if (label.length > 260) label = `${label.slice(0, 257)}…`;
  return {
    date,
    numero: Number(s.numero) || 0,
    vote: {
      pour: Number(dec.pour) || sum("pour"),
      contre: Number(dec.contre) || sum("contre"),
      abstentions: Number(dec.abstentions) || sum("abstention"),
      nonVotants: sum("nonVotants"),
      label,
      groups,
    },
  };
}

// ───────────────────────── Sénat : lecture de l'export PostgreSQL ─────────────────────────

const unescapePg = (v) => {
  if (v === "\\N") return null;
  if (!v.includes("\\")) return v.trim();
  return v
    .replace(/\\(.)/g, (_, c) => ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" })[c] ?? c)
    .trim();
};

/** Extrait quelques tables d'un dump `pg_dump` (blocs COPY ... FROM stdin) sans tout charger en mémoire. */
async function readCopyTables(file, wanted) {
  const tables = {};
  let cur = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (cur) {
      if (line === "\\.") {
        cur = null;
      } else {
        const f = line.split("\t");
        const row = {};
        for (const k of cur.keep) row[k] = unescapePg(f[cur.idx[k]] ?? "\\N");
        cur.rows.push(row);
      }
      continue;
    }
    const m = /^COPY (?:public\.)?(\w+) \((.*)\) FROM stdin;$/.exec(line);
    if (m && wanted[m[1]]) {
      const cols = m[2].split(",").map((c) => c.trim());
      const idx = Object.fromEntries(cols.map((c, i) => [c, i]));
      const keep = wanted[m[1]].filter((c) => c in idx);
      tables[m[1]] = { rows: [] };
      cur = { idx, keep, rows: tables[m[1]].rows };
    }
  }
  return tables;
}

const SENAT_KIND = {
  pjl: "Projet de loi",
  pjlo: "Projet de loi",
  pjlc: "Projet de loi",
  pjfs: "Projet de loi",
  pjlf: "Projet de loi",
  pjlr: "Projet de loi",
  pjlg: "Projet de loi",
  ppl: "Proposition de loi",
  pplo: "Proposition de loi",
  pplc: "Proposition de loi",
  ppro: "Proposition de loi",
};

async function senatTexts(file, anIndex, today) {
  const t = await readCopyTables(file, {
    loi: ["loicod", "typloicod", "etaloicod", "signet", "loient", "loitit", "url_an"],
    lecture: ["lecidt", "loicod"],
    lecass: ["lecassidt", "lecidt", "codass", "ptlnum", "debatsurl", "reucom"],
    texte: ["lecassidt", "txtoritxtdat", "texdatsea"],
  });
  for (const k of ["loi", "lecture", "lecass", "texte"]) if (!t[k]?.rows.length) throw new Error(`Table Sénat vide ou absente : ${k}`);
  const lecturesByLoi = new Map();
  for (const r of t.lecture.rows) (lecturesByLoi.get(r.loicod) ?? lecturesByLoi.set(r.loicod, []).get(r.loicod)).push(r.lecidt);
  const lassByLec = new Map();
  for (const r of t.lecass.rows) (lassByLec.get(r.lecidt) ?? lassByLec.set(r.lecidt, []).get(r.lecidt)).push(r);
  const texByLass = new Map();
  for (const r of t.texte.rows) (texByLass.get(r.lecassidt) ?? texByLass.set(r.lecassidt, []).get(r.lecassidt)).push(r);

  const since = daysAgo(SENAT_WINDOW_DAYS);
  const out = [];
  for (const l of t.loi.rows) {
    const type = (l.typloicod ?? "").trim();
    if (l.etaloicod !== "01" || !SENAT_KIND[type] || !l.signet) continue;
    // Déjà couvert par le dossier de l'Assemblée nationale (même texte, navette engagée).
    const anUrl = String(l.url_an ?? "").toLowerCase();
    const slug = anUrl.replace(/\.asp$/, "").split("/").pop() ?? "";
    if (anUrl && (anIndex.chemins.has(slug) || [...anIndex.chemins].some((c) => c.startsWith(slug) && slug.length >= 20) || anIndex.uids.has(slug.toUpperCase()))) continue;
    if (anIndex.signets.has(l.signet.toLowerCase())) continue;

    let date = "";
    let progress = { adopted: false, seance: false, commission: false };
    for (const lec of lecturesByLoi.get(l.loicod) ?? []) {
      for (const a of lassByLec.get(lec) ?? []) {
        if (a.ptlnum) progress.adopted = true;
        if (a.debatsurl) progress.seance = true;
        if (a.reucom) progress.commission = true;
        for (const x of texByLass.get(a.lecassidt) ?? []) {
          for (const v of [iso(x.txtoritxtdat), iso(x.texdatsea)]) if (v && v <= today && v > date) date = v;
        }
      }
    }
    if (!date || date < since) continue;
    const stage = progress.adopted ? "adopte" : progress.seance ? "seance" : progress.commission ? "commission" : "depot";
    const kind = SENAT_KIND[type];
    const title = (l.loient || l.loitit || "").replace(/\s+/g, " ").trim();
    if (!title) continue;
    const description =
      stage === "depot"
        ? `${kind}. Déposé au Sénat le ${fmtDate(date)}. Aucune étape d'examen n'est encore enregistrée dans les données du Sénat.`
        : `${kind}. Dernière étape enregistrée au Sénat le ${fmtDate(date)}.`;
    out.push({
      id: `senat-${l.signet}`,
      title,
      chamber: "senat",
      stage,
      date,
      kind,
      description,
      concepts: [],
      url: `https://www.senat.fr/dossier-legislatif/${l.signet}.html`,
    });
  }
  out.sort((a, b) => (a.date < b.date ? 1 : -1));
  return out.slice(0, SENAT_MAX);
}

// ───────────────────────── Programme principal ─────────────────────────

async function main() {
  if (!shouldRun([8, 14, 20], { weekendHours: [14] })) return;
  const force = process.env.FORCE === "1" || process.env.FORCE === "true";
  const today = parisToday();

  // 1. Les sources ont-elles changé ? (évite de retélécharger ~50 Mo pour rien)
  const heads = {};
  for (const k of Object.keys(SOURCES)) heads[k] = await head(SOURCES[k].url);
  const previous = existsSync(META_FILE) ? readJ(META_FILE) : null;
  const same = previous && Object.keys(SOURCES).every((k) => heads[k] && previous[k] && previous[k].lastModified === heads[k].lastModified && previous[k].etag === heads[k].etag);
  if (!force && same && existsSync(OUT_FILE)) {
    console.log("Sources inchangées depuis le dernier passage : rien à faire.");
    return;
  }

  mkdirSync(WORK, { recursive: true });
  const dirs = {};
  for (const k of Object.keys(SOURCES)) dirs[k] = await downloadAndUnzip(k);

  // 2. Dossiers de l'Assemblée nationale
  const dosDir = join(dirs.dossiers, "json", "dossierParlementaire");
  const since = daysAgo(AN_WINDOW_DAYS);
  const candidates = [];
  const anIndex = { chemins: new Set(), uids: new Set(), signets: new Set() };
  for (const f of readdirSync(dosDir)) {
    if (!f.startsWith("DLR5L17")) continue;
    const d = readJ(join(dosDir, f)).dossierParlementaire;
    if (!d) continue;
    const a = analyseDossier(d, today);
    if (!a) continue;
    anIndex.uids.add(a.uid);
    if (a.chemin) anIndex.chemins.add(a.chemin);
    if (a.senatChemin) anIndex.signets.add(String(a.senatChemin).split("/").pop().replace(/\.html$/, "").toLowerCase());
    if (a.date >= since) candidates.push(a);
  }
  // Priorité aux textes arrivés en séance, adoptés ou promulgués ; puis les plus récemment actifs.
  const rank = (a) => (["seance", "adopte", "promulgue"].includes(a.stage) ? 0 : 1);
  candidates.sort((a, b) => rank(a) - rank(b) || (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const selected = candidates.slice(0, AN_MAX);
  console.log(`Assemblée nationale : ${candidates.length} dossiers récents, ${selected.length} retenus.`);

  // 3. Votes (scrutins référencés par les décisions de chaque dossier)
  const scrDir = dirs.scrutins;
  const lois = [];
  let withVote = 0;
  for (const a of selected) {
    const refs = [...new Set(a.acts.flatMap((x) => x.voteRefs))];
    let best = null;
    for (const ref of refs) {
      const s = readScrutin(scrDir, dirs.organes, ref);
      if (s && (!best || s.date > best.date || (s.date === best.date && s.numero > best.numero))) best = s;
    }
    if (best) withVote++;
    lois.push({
      id: a.uid,
      title: a.title,
      chamber: a.chamber,
      stage: a.stage,
      date: a.date,
      kind: a.kind,
      description: a.description,
      ...(best ? { vote: best.vote } : {}),
      concepts: a.concepts,
      url: a.url,
    });
  }

  // 4. Textes encore seulement au Sénat
  const senat = await senatTexts(join(dirs.senat, "dosleg.sql"), anIndex, today);
  console.log(`Sénat : ${senat.length} textes déposés récemment et pas encore à l'Assemblée.`);
  lois.push(...senat);
  lois.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // 5. Contrôles avant d'écrire : on ne remplace jamais de bonnes données par un résultat douteux.
  if (lois.length < 10) throw new Error(`Trop peu de textes (${lois.length}) : écriture refusée.`);
  if (withVote < 3) throw new Error(`Trop peu de votes (${withVote}) : écriture refusée.`);
  for (const l of lois) {
    if (!l.id || !l.title || !l.date || !l.url || !["depot", "commission", "seance", "adopte", "promulgue"].includes(l.stage)) throw new Error(`Texte incomplet : ${JSON.stringify(l).slice(0, 200)}`);
  }

  const lastModified = Object.values(heads)
    .map((h) => (h?.lastModified ? new Date(h.lastModified).toISOString().slice(0, 10) : ""))
    .sort()
    .pop();
  const changed = writeEnvelope(
    "lois",
    { asOf: lastModified || today, lois },
    { schemaVersion: 1, source: "Assemblée nationale, Sénat — Licence Ouverte 2.0" },
  );
  console.log(`Lois : ${lois.length} textes (${withVote} avec résultat de vote), ${changed ? "mis à jour" : "inchangé"}.`);

  // Les serveurs de l'Assemblée répondent parfois avec deux dates `Last-Modified` différentes (deux machines
  // non synchronisées) : on ne réécrit ce fichier que si les données ont vraiment changé, pour éviter des
  // commits sans intérêt.
  if (changed || !previous) {
    mkdirSync(join(root, "data", "_meta"), { recursive: true });
    writeFileSync(META_FILE, JSON.stringify(heads, null, 2));
  }
  if (process.env.LOIS_KEEP !== "1" && !REUSE) rmSync(WORK, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
