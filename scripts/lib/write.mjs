import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..", "..");

/**
 * Écrit data/<name>.json sous forme d'enveloppe { schemaVersion, updatedAt, source, data }.
 * Si `data` est identique à l'existant, le fichier n'est pas modifié (pas de commit inutile).
 * Écriture atomique : on n'abîme jamais un fichier valide.
 */
export function writeEnvelope(name, data, { schemaVersion = 1, source = "" } = {}) {
  if (data == null) throw new Error(`Données vides pour ${name} : écriture refusée.`);
  const file = resolve(root, "data", `${name}.json`);
  if (existsSync(file)) {
    try {
      const old = JSON.parse(readFileSync(file, "utf8"));
      if (old.schemaVersion === schemaVersion && JSON.stringify(old.data) === JSON.stringify(data) && old.source === source) {
        console.log(`${name}: inchangé.`);
        return false;
      }
    } catch {
      /* fichier illisible : on le remplace */
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const env = { schemaVersion, updatedAt: new Date().toISOString(), source, data };
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(env));
  renameSync(tmp, file);
  console.log(`${name}: écrit (${(JSON.stringify(env).length / 1024).toFixed(1)} Ko).`);
  return true;
}
