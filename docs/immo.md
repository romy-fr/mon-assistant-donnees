# Immobilier (`data/immo.json`)

Tâche `.github/workflows/immo.yml` : le 1er de chaque mois vers 5 h (heure de Paris), ou à la main. Script `scripts/immo.mjs`.

## Sources
- **DVF géolocalisé** (DGFiP, Etalab), Licence Ouverte 2.0 : ventes de logements. Fichiers annuels résolus par l'API data.gouv.
- **Carte des loyers** (ANIL), Licence Ouverte 2.0. Mention obligatoire : « Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin ».
- **IRL** (Insee), série 001515333.

## Contenu
15 villes (liste `VILLES` en tête du script). Secteurs : arrondissements (Paris, Lyon, Marseille), codes postaux ailleurs.
Par ville et par secteur, pour les appartements et les maisons : médiane, P10, P90 et nombre de ventes sur 36 mois,
courbe trimestrielle sur 20 trimestres, loyers d'annonce au m².

## Vie privée
Aucune vente individuelle ni adresse n'est écrite. Aucun chiffre sous 10 ventes (8 pour un point de courbe).

## Filtres
Ventes d'un seul logement par mutation (les ventes groupées et celles avec local professionnel sont écartées),
surface de 9 à 300 m² (500 m² pour une maison), prix de 400 à 30 000 €/m². Écriture refusée sous 10 000 ventes retenues.

## Limites
- Un code postal n'est pas un quartier.
- DVF ne couvre pas l'Alsace, la Moselle ni Mayotte (Strasbourg n'est donc pas dans la liste).
- Les loyers d'un découpage par code postal sont ceux de toute la commune ; pour la ville entière à arrondissements,
  c'est une moyenne pondérée par le nombre de ventes.
- Les loyers ANIL sont des indicateurs expérimentaux sur des loyers d'annonce.
- L'application embarque une copie de ces données (`mobile/lib/immoSnapshot.json`) pour le premier lancement hors ligne.
