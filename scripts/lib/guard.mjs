// Garde par créneau. GitHub lance les tâches programmées en retard (plus d'une heure observée) et peut en abandonner.
// Les workflows se déclenchent donc plusieurs fois après chaque créneau ; la garde laisse passer le PREMIER
// déclenchement qui suit l'heure voulue (heure de Paris, été comme hiver), même très en retard, puis note le créneau
// comme fait dans data/_meta/slots/<tâche>.json. Les déclenchements suivants ne font rien.
// Le fichier n'est enregistré dans le dépôt que si toute la tâche réussit : un échec sera retenté au déclenchement suivant.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");
const HOUR = 3600000;
const JOURS = { "lun.": 1, "mar.": 2, "mer.": 3, "jeu.": 4, "ven.": 5, "sam.": 6, "dim.": 7 };

const parts = (date) => {
  const f = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "numeric", hourCycle: "h23", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = JOURS[o.weekday];
  return { hour: Number(o.hour) % 24, weekday, weekend: weekday >= 6, day: Number(o.day), isoDate: `${o.year}-${o.month}-${o.day}` };
};

/**
 * Dernier créneau commencé à l'instant `now`, au format « AAAA-MM-JJTHH » (heure de Paris).
 * @param {{ hours: number[], weekendHours?: number[], weekdays?: number[], monthDays?: number[] }} schedule
 *   weekdays : 1 = lundi … 7 = dimanche ; monthDays : jours du mois
 */
export function latestSlot(schedule, now = new Date()) {
  for (let k = 0; k <= 24 * 40; k++) {
    const p = parts(new Date(now.getTime() - k * HOUR));
    const hours = p.weekend && schedule.weekendHours ? schedule.weekendHours : schedule.hours;
    if (!hours.includes(p.hour)) continue;
    if (schedule.weekdays && !schedule.weekdays.includes(p.weekday)) continue;
    if (schedule.monthDays && !schedule.monthDays.includes(p.day)) continue;
    return `${p.isoDate}T${String(p.hour).padStart(2, "0")}`;
  }
  throw new Error("Aucun créneau trouvé sur les 40 derniers jours : horaire invalide.");
}

/**
 * Vrai s'il faut exécuter la tâche : le dernier créneau n'a pas encore été fait (ou FORCE=1, sans rien noter).
 * @param {string} task nom de la tâche (nom du fichier de suivi)
 */
export function shouldRun(task, schedule, { now = new Date(), dir = resolve(root, "data", "_meta", "slots") } = {}) {
  if (process.env.FORCE === "1" || process.env.FORCE === "true") return true;
  const slot = latestSlot(schedule, now);
  const file = resolve(dir, `${task}.json`);
  let done = "";
  try {
    done = JSON.parse(readFileSync(file, "utf8")).slot ?? "";
  } catch {
    /* jamais exécutée ou fichier illisible : on exécute */
  }
  if (done >= slot) {
    console.log(`Créneau ${slot} déjà fait : rien à faire.`);
    return false;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ slot, lanceLe: now.toISOString() })}\n`);
  console.log(`Créneau ${slot} à faire.`);
  return true;
}

export const parisToday = () => parts(new Date()).isoDate;
