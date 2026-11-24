# Météo (prévisions toutes les 6 heures)

Tâche : `.github/workflows/meteo.yml` (00 h, 06 h, 12 h et 18 h UTC, minute 15) · script : `scripts/meteo.mjs` · sortie : `data/meteo.json`.

## Sources et licences

- **Open-Meteo.com** (`api.open-meteo.com/v1/forecast`) : API gratuite sans clé pour un **usage non commercial**, données sous
  licence **CC BY 4.0** (mention obligatoire : « Prévisions Open-Meteo.com »). Limite gratuite : 10 000 appels par jour ; le script
  fait **une seule requête** (17 villes, 2 modèles) par passage, soit 4 requêtes par jour. Un usage commercial demande une
  offre payante : à revoir avant toute publication sur l'App Store.
- **AROME** (`meteofrance_arome_france`, Météo-France, Licence Ouverte 2.0) pour J+0 et J+1 : une valeur par heure, jusqu'à
  environ J+2 20 h.
- **ECMWF IFS** (`ecmwf_ifs025`, ECMWF Open Data, CC BY 4.0) pour J+2 à J+6 : une valeur par heure jusqu'à J+6 23 h.
- Le modèle AROME « HD » (`meteofrance_arome_france_hd`) n'est PAS utilisé : il ne fournit ni code météo ni nébulosité,
  donc pas d'icône.

## Format de `data/meteo.json`

Enveloppe `{ schemaVersion: 1, updatedAt, source, data }` (voir `scripts/lib/write.mjs`). `data` :

```jsonc
{
  "tz": "Europe/Paris",
  "cities": {
    "paris": {
      "start": "2026-11-24T00:00",          // heure locale de Paris du premier point ; un point par heure ensuite
      "arome": { "t": [], "mm": [], "w": [], "g": [], "c": [], "d": [] },   // 68 heures environ
      "ifs":   { "t": [], "mm": [], "w": [], "g": [], "c": [], "d": [] }    // 168 heures (7 jours)
    }
    // … 17 chefs-lieux (mêmes identifiants que l'appli)
  },
  "cartes": { "z500": "<manifeste>", "precip": "<manifeste>", "base": "<dossier des cartes>" }
}
```

Par heure : `t` température (°C, 1 décimale), `mm` précipitations de l'heure (mm), `w` vent moyen à 10 m (km/h), `g` rafales (km/h),
`c` code météo WMO, `d` 1 le jour / 0 la nuit. Taille : environ 65 Ko.

L'appli (`mobile/lib/meteoLive.ts`) calcule elle-même, à partir de l'heure de Paris : l'heure par heure de maintenant à la fin de
J+1 (AROME), les lignes de 6 h de J+2 à J+6 (IFS : précipitations cumulées sur le pas, vent et rafales maximaux, temps le plus
marquant du pas), et la synthèse de chaque jour (températures minimale et maximale sur 24 h, cumul de pluie, temps le plus
marquant entre 6 h et 21 h). Les données de plus de six jours ne sont plus affichées.

## Icônes

Code WMO vers les 27 icônes de MonClimat : 0 ensoleillé / nuit claire, 1 peu nuageux, 2 éclaircies (peu nuageux la nuit),
3 couvert, 45 brouillard, 48 brouillard givrant, 51 / 53 / 55 bruine faible / normale / forte, 56 et 57 bruine verglaçante,
61 / 63 / 65 pluie faible / normale / forte, 66 / 67 pluie verglaçante, 71 / 73 / 75 neige, 77 grains, 80 / 81 / 82 averses,
85 / 86 averses de neige, 95 orage, 96 et 99 orage avec grêle.

## Cartes des modèles (GFS, IFS, AIGFS, AIFS : Z500 et précipitations)

Elles ne sont **pas** produites dans ce dépôt. Le dépôt `romy-fr/MonClimat` les génère déjà une fois par jour
(`meteo-cartes-j6.yml`, 8 h 30 UTC) et les publie sur GitHub Pages dans une branche `publication` recréée à chaque fois (un seul commit :
l'historique ne grossit pas) : `https://romy-fr.github.io/MonClimat/meteo/cartes-j6/` avec `manifest.json` (Z500) et
`precip/manifest.json`. Les images pèsent 20 Mo au total. L'appli lit ces manifestes et charge les cartes en ligne ; sans réseau,
elle affiche les cartes de secours livrées avec elle, en le disant.

Pourquoi pas toutes les 6 heures : les cartes sont toutes alignées sur le run de 00 UTC du jour (même date de validité pour les
quatre modèles) ; un passage toutes les 6 heures ne changerait rien, et l'ensemble (Python, GRIB, cartopy) dure plusieurs minutes.
Ne jamais commiter ces images dans l'historique de ce dépôt.

## Limites

- Aucune probabilité de pluie : ni AROME ni IFS n'en fournissent. L'appli affiche les cumuls en mm.
- Les icônes viennent du code météo du modèle ; `orageg` (grêle) correspond aux codes 96 et 99, qui sont un indice de risque.
- Le fichier est réécrit à chaque passage : l'historique git grossit d'environ 65 Ko × 4 par jour avant compression. Si cela devient
  gênant, publier plutôt le fichier comme asset d'une release (`meteo-latest`) ou purger l'historique.
- La tâche s'arrête sans rien écrire si l'API est en panne (cinq essais espacés) ou si une réponse est incomplète ou hors plage :
  la version précédente reste en place.
- GitHub peut retarder ou sauter une exécution programmée ; GitHub désactive les tâches programmées d'un dépôt public sans activité
  pendant 60 jours.
