# Mon Assistant : données ouvertes

Ce dépôt public contient uniquement des données issues de sources ouvertes (Lois, Économie, Climat, Immobilier, météo),
actualisées automatiquement par GitHub Actions. L'appli « Mon Assistant » lit les fichiers du dossier `data/`.

Chaque fichier a la forme `{ schemaVersion, updatedAt, source, data }`. Aucune clé ni donnée personnelle ici.
Chaque tâche vit dans `.github/workflows/`, ses scripts dans `scripts/` (Node, sans dépendance externe de préférence).
