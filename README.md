# AdminFlow

AdminFlow est une application locale Node.js avec comptes authentifiés, rôles contrôlés côté serveur, base SQLite, téléversement privé de documents, demandes, messagerie par service, annonces, recherche dans les contenus accessibles et notifications en direct.

## Démarrer en local

Prérequis : Node.js 22.5 ou plus récent.

```powershell
npm install
npm start
```

Ouvrir ensuite `http://127.0.0.1:3000`. Au premier accès, créer le compte administrateur avec un mot de passe d’au moins 12 caractères. L’administrateur peut créer les autres comptes et leur attribuer un rôle ; une adresse e-mail déjà utilisée ne peut pas être inscrite une seconde fois. Il peut aussi désactiver et réactiver les comptes : les données et historiques liés sont conservés, et un compte réactivé peut se connecter à nouveau. Il n’est pas possible de désactiver le compte administrateur connecté ni le dernier compte administrateur actif. Il n’existe pas de compte ou de mot de passe par défaut.

Les données sont conservées dans `data/adminflow.sqlite` et les documents dans `uploads/`. Ces répertoires sont exclus du contrôle de version. Les fichiers acceptés sont PDF, DOC et DOCX, avec une limite de 15 Mo. Les styles Tailwind sont compilés au démarrage et les icônes sont hébergées localement. Les fichiers actifs ne sont pas chiffrés individuellement : activer le chiffrement complet du disque du serveur et restreindre l’accès au compte système qui exécute Node.js.

## Rôles et visibilité

- Les comptes ne peuvent consulter que les documents qu’ils ont envoyés ou ceux destinés à leur service. Le DG dispose d’une vue de supervision des documents.
- Seul le destinataire (ou le DG pour les documents) peut modifier le statut d’un document.
- Les demandes sont visibles par leur auteur et le service destinataire ; seul le service destinataire peut les traiter.
- Les messages sont adressés à un service et visibles par ce service ainsi que par leur expéditeur.
- L’administrateur gère les comptes, sans accès global aux documents ou aux conversations.
- Les annonces publiées sont visibles par tous les comptes.

Les notifications sont persistées en base et diffusées en direct au navigateur connecté par Server-Sent Events. Les alertes de bureau sont facultatives et nécessitent l’autorisation du navigateur ; elles apparaissent lorsque la plateforme est ouverte (sur HTTPS ou localhost). Elles ne constituent pas un service SMS ou e-mail.

## Déploiement et exploitation

Par défaut, le serveur écoute uniquement sur `127.0.0.1`. Pour un accès depuis d’autres machines, déployer derrière un proxy HTTPS correctement configuré, puis définir `HOST` et éventuellement `TRUST_PROXY`. En production, définir `NODE_ENV=production` afin d’activer l’attribut `Secure` du cookie de session. Ne pas exposer directement le serveur ou SQLite sur Internet.

Cette version est un déploiement mono-serveur : la disponibilité dépend de la machine, du disque et des sauvegardes opérées par l’établissement. Une sauvegarde cohérente de SQLite en mode WAL et des fichiers téléversés peut être créée ainsi :

```powershell
$env:ADMINFLOW_BACKUP_DIR = 'E:\AdminFlow-backups'
npm run backup
$backup = Get-ChildItem -LiteralPath $env:ADMINFLOW_BACKUP_DIR -Directory |
    Sort-Object Name -Descending | Select-Object -First 1
npm run backup:verify -- $backup.FullName
```

Le dossier de sauvegarde doit se trouver hors de `data/` et `uploads/`, sur un support protégé par chiffrement et dont l’accès est limité. Pour la disponibilité, conserver également une copie sur un support distinct du serveur ; la commande de sauvegarde ne chiffre pas elle-même les fichiers. La sauvegarde crée une copie SQLite cohérente via `VACUUM INTO`, copie ensuite les uploads immuables et écrit un manifeste SHA-256. La vérification contrôle les empreintes, `PRAGMA integrity_check` et les clés étrangères. Exécuter régulièrement la sauvegarde et sa vérification, puis effectuer une restauration d’essai.

Pour restaurer, arrêter complètement AdminFlow, vérifier d’abord le dossier avec `npm run backup:verify -- <dossier>`, puis mettre à l’écart l’intégralité des répertoires `data/` et `uploads/` actuels. Restaurer le fichier `adminflow.sqlite` du dossier dans `data/` et le répertoire `uploads/` sauvegardé à la place de l’ancien (ne pas fusionner les fichiers). Cela évite de réutiliser d’anciens fichiers `-wal` ou `-shm`. Redémarrer ensuite le service et contrôler l’accès aux documents ainsi que les données restaurées. Tester cette procédure sur une copie avant toute restauration en production.

Mettre aussi en place des mises à jour régulières et une supervision. Le contrôle de format des fichiers ne remplace pas un antivirus. Il n’y a pas encore de stockage distribué, de réplication, de récupération de mot de passe par e-mail ni de journal d’audit inviolable.

## Structure du dépôt

- `server.js` : serveur HTTP, authentification, règles métier et accès SQLite.
- `index.html`, `script.js`, `style.css` : interface navigateur.
- `tailwind.input.css` et `tailwind.config.js` : sources de styles ; `tailwind.generated.css` est généré au démarrage et n’est pas versionné.
- `logo-ipto.jpg`, `batiment-principal.jpg`, `ipo.jpeg` : images utilisées par l’interface.
- `scripts/backup.js` : sauvegarde et vérification des données.
- `data/`, `uploads/`, `backups/` : données locales, fichiers transmis et sauvegardes ; ces dossiers ne doivent jamais être publiés.
- `.github/workflows/verify.yml` : vérification automatique du code et compilation CSS sur GitHub Actions.

Les fichiers de l’application restent à la racine car le serveur les expose depuis ces chemins. `npm start` génère le CSS avant de démarrer le serveur.

## Vérification avant publication

```powershell
npm ci
npm run verify
git status --short
```

Après avoir créé un dépôt GitHub, ajoute son URL puis pousse la branche `main` :

```powershell
git remote add origin https://github.com/<compte>/<depot>.git
git add .
git commit -m "Préparer AdminFlow"
git push -u origin main
```

Pour ce projet, privilégier un dépôt privé tant que les droits de publication des éléments de marque et les règles de sécurité de l’établissement ne sont pas confirmés.
