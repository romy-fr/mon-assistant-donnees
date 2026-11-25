// Garde horaire : GitHub lance les tâches en UTC. On programme les deux heures UTC possibles (été et hiver)
// et ce garde ne laisse passer que celle qui correspond à l'heure de Paris voulue.
const parts = (date) => {
  const f = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", hour: "numeric", hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
  const o = Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
  const hour = Number(o.hour) % 24;
  const weekend = ["sam.", "dim."].includes(o.weekday);
  return { hour, weekend, isoDate: `${o.year}-${o.month}-${o.day}` };
};

/**
 * @param {number[]} hours heures de Paris autorisées (jours de semaine)
 * @param {{ weekendHours?: number[] }} [opts] heures autorisées le week-end (par défaut les mêmes)
 * @returns {boolean} vrai s'il faut exécuter (ou si FORCE=1)
 */
export function shouldRun(hours, opts = {}) {
  if (process.env.FORCE === "1" || process.env.FORCE === "true") return true;
  const { hour, weekend } = parts(new Date());
  const allowed = weekend && opts.weekendHours ? opts.weekendHours : hours;
  // GitHub retarde souvent les tâches programmées (40 à 50 min observées) : on accepte aussi l'heure suivante.
  // Deux passages dans le même créneau sont sans effet : rien n'est écrit si les données n'ont pas changé.
  const ok = allowed.some((h) => hour === h || hour === (h + 1) % 24);
  if (!ok) console.log(`Hors créneau (Paris ${hour} h, ${weekend ? "week-end" : "semaine"}) : rien à faire.`);
  return ok;
}

export const parisToday = () => parts(new Date()).isoDate;
