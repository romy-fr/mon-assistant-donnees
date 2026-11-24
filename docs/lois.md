# Lois

Fichier produit : `data/lois.json` (enveloppe `{ schemaVersion: 1, updatedAt, source, data }`).
Tâche : `.github/workflows/lois.yml` ; script : `scripts/lois.mjs`.

## Rythme

8 h, 14 h et 20 h (heure de Paris) chaque jour, et seulement 14 h le week-end. Le cron est en UTC
(`5 6,7,12,13,18,19 * * *`) ; le script ne s'exécute que si l'heure de Paris correspond (changement d'heure géré).
Si les quatre sources n'ont pas changé (en-têtes `Last-Modified` et `ETag`, mémorisés dans
`data/_meta/lois-sources.json`), le script s'arrête sans rien télécharger de plus. Lancement manuel : « Run workflow »,
case « Forcer » pour ignorer ces contrôles.

## Sources (Licence Ouverte 2.0)

| Source | Fichier | Taille (nov. 2026) |
|---|---|---|
| Assemblée nationale | `loi/dossiers_legislatifs/Dossiers_Legislatifs.json.zip` | ~11 Mo |
| Assemblée nationale | `loi/scrutins/Scrutins.json.zip` | ~31 Mo |
| Assemblée nationale | `amo/deputes_actifs_mandats_actifs_organes/AMO10_..._organes.json.zip` (noms des groupes) | ~5 Mo |
| Sénat | `data.senat.fr/data/dosleg/dosleg.zip` (export PostgreSQL, 128 Mo décompressé) | ~16 Mo |

Base : `https://data.assemblee-nationale.fr/static/openData/repository/17/…`. Mention affichée dans l'appli :
« Assemblée nationale, Sénat — Licence Ouverte 2.0 » et la date de mise à jour.

## Schéma de `data`

```jsonc
{
  "asOf": "2026-11-24",            // date de la source la plus récente
  "lois": [
    {
      "id": "DLR5L17N54608",       // identifiant du dossier (AN) ou "senat-<signet>"
      "title": "La relance et la décentralisation du logement",
      "chamber": "assemblee" | "senat",   // chambre de la dernière étape
      "stage": "depot" | "commission" | "seance" | "adopte" | "promulgue",
      "date": "2026-11-24",        // date de la dernière étape (ISO)
      "kind": "Projet de loi" | "Proposition de loi",
      "description": "…",          // texte neutre composé à partir des dates et décisions officielles
      "vote": {                    // facultatif : dernier scrutin référencé par une décision du dossier
        "pour": 362, "contre": 118, "abstentions": 50, "nonVotants": 44,   // nonVotants = absents + non-votants
        "label": "Vote du 24 novembre 2026 sur l'ensemble du … — adopté",
        "groups": [ { "name", "sigle", "seats", "pour", "contre", "abstention", "nonVotants" } ]  // de gauche à droite
      },
      "concepts": ["navette-parlementaire", "article-49-3"],   // identifiants de fiches de l'appli
      "url": "https://www.assemblee-nationale.fr/dyn/17/dossiers/…"
    }
  ]
}
```

## Règles de sélection

- Assemblée nationale : projets et propositions de loi dont la dernière étape date de moins de 120 jours, hors textes
  retirés. Les textes en séance, adoptés ou promulgués passent en premier, puis les plus récemment actifs ; 60 au plus.
- Sénat : textes en cours de discussion au Sénat, déposés depuis moins de 60 jours, qui n'ont pas de dossier à
  l'Assemblée (sinon ils sont déjà couverts) ; 15 au plus. Conventions internationales, résolutions et motions exclues.
- Étape (`stage`) : dernière étape datée du dossier. Une décision de séance qui rejette le texte reste « seance » ;
  la commission mixte paritaire compte comme « commission » ; le Conseil constitutionnel compte comme « adopte ».

## Protection des données

Aucune donnée personnelle : seuls des totaux par groupe politique sont conservés (pas de vote nominatif de député).
Aucune clé ni secret. Si un contrôle échoue (trop peu de textes ou de votes), le script s'arrête en erreur et le
fichier précédent reste en place.

## Limites connues

- Pas de votes du Sénat (aucun jeu de scrutins du Sénat n'a été trouvé en données ouvertes) : un texte à l'étape
  « Sénat » n'a un résultat que s'il a déjà été voté à l'Assemblée.
- Le vote affiché est le dernier scrutin référencé par une décision du dossier ; il peut dater d'une lecture précédente
  (la date figure dans le libellé).
- Pour les textes seulement au Sénat, le dump n'enregistre pas de progression fine : ils apparaissent le plus souvent
  à l'étape « Dépôt ».
- Les sigles des groupes viennent des données (`EcoS`, `Dem`…) ; l'ordre gauche-droite est fixé dans le script.
- Pas de résumé rédigé : la description est une chronologie factuelle, sans interprétation.
- Les serveurs de l'Assemblée répondent parfois avec deux dates `Last-Modified` différentes (deux machines non
  synchronisées) : la détection « sources inchangées » ne joue alors pas, le script reconstruit et, si le résultat est
  identique, ne crée aucun commit.
