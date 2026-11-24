# Économie : données et sources

Fichier produit : `data/eco.json`, une fois par semaine (lundi 7 h, heure de Paris) par `.github/workflows/eco.yml`.
Script : `scripts/eco.mjs` (Node 22, aucune dépendance, aucune clé).

## Forme du fichier

```
{ schemaVersion: 1, updatedAt, source, data: { indicators: [ ... ] } }
```

Chaque indicateur : `id` (x1 à x11), `value`, `period` (en toutes lettres), `prev`, `prevLabel`, `yearAgo` et `yearAgoLabel`
(quand la série le permet), `source` (Insee, BCE ou Eurostat), `updatedOn` (date de mise à jour de la source, AAAA-MM-JJ) et
`series` : `{ kind: "m" | "q" | "y", end, values }`. `end` est la dernière période (`2026-10`, `2026-Q3`, `2025`) ;
`values` est la suite continue, sans trou, des valeurs jusqu'à `end` (132 mois, 44 trimestres ou 22 années au plus).
Les noms, unités et descriptions restent dans l'appli (ils ne changent pas).

## Indicateurs et identifiants (tous vérifiés le 24 novembre 2026)

| id | Indicateur | Source et identifiant | Pas |
|---|---|---|---|
| x1 | Inflation (IPC, glissement annuel) | Insee BDM 011814632 | mensuel |
| x2 | PIB (variation trimestrielle) | Insee BDM 011794844 | trimestriel |
| x3 | Chômage (BIT) | Insee BDM 011818543 | trimestriel |
| x4 | Salaires de base (glissement annuel) | Insee BDM 010562675 | trimestriel |
| x5 | Balance commerciale (Md€, FAB/FAB, CVS-CJO) | Insee BDM 001568614 (millions d'euros, divisés par 1 000) | mensuel |
| x6 | Dette publique (points de PIB) | Insee BDM 010777608 | trimestriel |
| x7 | Déficit public (% du PIB) | Eurostat `gov_10dd_edpt1` (FR, S13, B9, PC_GDP) | annuel |
| x8 | Taux de dépôt de la BCE | BCE `FM/D.U2.EUR.4F.KR.DFR.LEV` (quotidien, ramené à une courbe mensuelle de fin de mois) | mensuel |
| x9 | OAT 10 ans (moyenne mensuelle) | BCE `IRS/M.FR.L.L40.CI.0000.EUR.N.Z` | mensuel |
| x10 | Confiance des ménages | Insee BDM 001587668 | mensuel |
| x11 | Climat des affaires | Insee BDM 001565530 | mensuel |

Aucun identifiant n'a échoué. L'IPCH (Insee 011812232) répond aussi mais n'est pas affiché pour l'instant.

## Licences et mentions à afficher

- Insee : Licence Ouverte 2.0. Citer « Source : Insee » et la date de mise à jour (`updatedOn`).
- BCE : citer la Banque centrale européenne comme source. Conditions de reproduction à revérifier avant une publication large.
- Eurostat : citer Eurostat comme source ; indiquer toute modification (ici : aucune hormis la mise en forme).
- Balance commerciale : chiffres des Douanes diffusés par l'Insee dans la base BDM.
- Le script envoie un identifiant d'appel générique (`MonAssistantDataBot/1.0`), sans contact. Les quotas de l'Insee BDM ne sont pas documentés :
  une seule passe par semaine, onze appels, 300 ms entre deux appels.

## Comportement en cas de problème

- Un indicateur qui échoue (réseau, format) garde sa valeur de la semaine précédente ; la tâche continue.
- Si aucun indicateur n'est récupéré, ou si une valeur est invalide, rien n'est écrit et la tâche échoue.
- Le fichier n'est réécrit (et donc commité) que si les données ont changé.

## Limites

- Les valeurs sont révisables par les instituts.
- Le calendrier des publications (page « Prochaines publications » de l'appli) n'est pas produit ici : il vient d'un tableau fixe
  de l'appli et ne contient que des dates déjà annoncées.
