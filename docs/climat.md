# Climat

Fichier produit : `data/climat.json` (enveloppe `{ schemaVersion: 1, updatedAt, source, data }`, environ 15 Ko).
Tâche : `.github/workflows/climat.yml`, une fois par jour à minuit (heure de Paris). Script : `scripts/climat.mjs`.

## Contenu de `data`
- `co2.jour` : [date ISO, ppm] sur les 400 derniers jours calendaires (les jours sans mesure sont absents).
- `co2.mois` : `pts` [mois "AAAA-MM", ppm] sur 10 ans et `trend` (valeur désaisonnalisée, même longueur).
- `co2.an` : [année, ppm] depuis 1959.
- `co2.dernier` : dernière valeur et écart avec un an plus tôt, pour jour, mois et an.
- `emissions.monde` : total des gaz à effet de serre en Gt CO₂e et CO₂ en Gt depuis 1990 ; `emissions.france` : en Mt.
- `emissions.repartitionCo2` : répartition du CO₂ mondial de la dernière année par source (charbon, pétrole, gaz, ciment, torchage, autres), en Mt.
- `sources` : producteur, licence et lien.

## Sources et licences
- NOAA GML, Mauna Loa : https://gml.noaa.gov/webdata/ccgg/trends/co2/ (co2_daily_mlo.csv, co2_mm_mlo.csv, co2_annmean_mlo.csv). Données publiques américaines, citer NOAA GML.
- Our World in Data, `owid-co2-data.csv` (CC BY 4.0) : https://github.com/owid/co2-data. CO₂ : Global Carbon Budget ; gaz à effet de serre : Jones et al., National contributions to climate change. Citer Our World in Data et les producteurs d'origine.

## Limites
- Pas d'émissions mensuelles : Climate TRACE n'est pas branché (API bêta, retard de deux mois environ). L'appli ne propose donc que la lecture annuelle.
- Pas de répartition par secteur : la répartition affichée est par source de CO₂ (combustibles et ciment), pas par secteur d'activité.
- Les images et cartes (températures, banquise, mers, France) ne passent pas par ce fichier : elles restent embarquées dans l'appli.
- Le script s'arrête sans rien écrire si une valeur est hors plage (CO₂ hors 300 à 500 ppm, émissions hors plage plausible) ou si une colonne attendue disparaît du fichier OWID.
- Test : `FORCE=1 node scripts/climat.mjs` (Node 22 ou plus récent).
