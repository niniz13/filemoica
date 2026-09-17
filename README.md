# filemoica

Service de transfert de fichiers chiffrés. On dépose un fichier, on obtient un
lien, on l'envoie. **Le destinataire n'a pas besoin de compte.**

Ce qui distingue le service d'un simple hébergement : le fichier est chiffré
**pendant** son transfert et n'existe jamais en clair sur le disque du serveur.
Un lien peut être protégé par mot de passe, expirer, ou se consumer au premier
usage, les fichiers sont alors effacés. Les administrateurs voient les comptes
et les volumes, jamais le contenu.

| | |
|---|---|
| **Version de référence** | `v1.0.0` |
| **Service en ligne** | https://filemoica.duckdns.org |
| **En local** | http://localhost:3001 |
| **Images publiées** | `ghcr.io/niniz13/filemoica-backend`, `-migrations`, `-frontend` |

La version qui tourne réellement est lisible sans accès au serveur :
`GET /health` renvoie `{"status":"ok","version":"…","checks":{"database":"up"}}`.

---

## L'équipe

| Qui | Rôle | Périmètre |
|---|---|---|
| **Martin Simon** | Backend | API, chiffrement, authentification, base de données, conteneurisation, CI/CD |
| **Jérémy Gross** | Frontend | Interface web Next.js, parcours de dépôt et de téléchargement |
| **Enzo ANSELMO** | SRC, infrastructure | DNS, reverse proxy public (Caddy), terminaison HTTPS, pare-feu applicatif (WAF) |
| **Julien DOURLET** | SRC, infrastructure | Observabilité (Grafana/Loki, Uptime Kuma), sauvegardes automatisées (Restic), PRA |
| **Killian DURANTI MACIA** | SRC, infrastructure | VM et Docker, reverse proxy interne (Nginx), isolation réseau, gestion des secrets (Vault)

Projet Tech Venture Sprint, ESGI 5<sup>e</sup> année.

---

## La stack

| Couche | Technologie |
|---|---|
| **Backend** | NestJS 12 · TypeScript · Node 24 |
| **Base de données** | PostgreSQL 17 · Prisma 7 |
| **Frontend** | Next.js 16 · React 19 · TypeScript |
| **Chiffrement** | AES-256-GCM en chiffrement enveloppe · argon2id pour les mots de passe |
| **Courriels** | API transactionnelle Brevo |
| **Exécution** | Docker · images multi-étapes, utilisateur non privilégié |
| **CI/CD** | GitHub Actions → GitHub Container Registry |

---

## Où trouver quoi

```
filemoica/
├── backend/          API NestJS : chiffrement, sessions, partages, administration
│   ├── prisma/       schéma et migrations de la base
│   ├── src/          code source, un dossier par domaine
│   ├── test/         tests de bout en bout
│   ├── Dockerfile    image applicative et image de migrations
│   └── .env.example  toutes les variables du backend, commentées
├── frontend/         interface Next.js
├── docs/             architecture, déploiement, résultats de tests, journal
├── .github/workflows/ci.yml   intégration et livraison continues
├── docker-compose.yml         la pile complète, pour l'essayer en une commande
└── .env.example               configuration de cette pile
```

Le déploiement de production ne part pas de ce fichier-là mais de
`backend/docker-compose.deploy.yml`, durci, avec
`backend/.env.deploy.example` pour modèle de configuration.

---

## Démarrage rapide

### Prérequis

- **Docker** (avec Compose)
- **Node.js ≥ 24.9** uniquement pour le mode développement

```bash
git clone https://github.com/niniz13/filemoica.git
cd filemoica
```

### Option A : tout en conteneurs *(le plus simple)*

Une commande monte la base, applique les migrations, démarre l'API et
l'interface.

```bash
cp .env.example .env
```

Trois clés sont à générer et à coller dans `.env`. Elles doivent être
**différentes entre elles** :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Rôle |
|---|---|
| `JWT_SECRET` | Signature des jetons de session |
| `ENCRYPTION_KEY_V1` | Clé maître du chiffrement des fichiers |
| `HMAC_INDEX_KEY` | Index aveugle sur les adresses des destinataires |

Tout le reste a une valeur par défaut fonctionnelle. Les variables Brevo sont
**facultatives en local** : sans clé, le contenu des courriels est écrit dans
les journaux du backend au lieu d'être envoyé, le lien de confirmation et le
code de connexion s'y lisent directement.

```bash
docker compose up -d --build
docker compose exec backend node dist/seed.js   # 3 comptes de démonstration
```

| Adresse | |
|---|---|
| http://localhost:3001 | L'interface |
| http://localhost:3000 | L'API |
| http://localhost:3000/api/docs | Documentation interactive (Swagger) |

**Comptes de démonstration** : mot de passe commun `demonstration-filemoica-2026` :

| Compte | Rôle | Offre |
|---|---|---|
| `admin@filemoica.fr` | Administrateur | Payante |
| `alice@filemoica.fr` | Utilisateur | Gratuite |
| `bob@filemoica.fr` | Utilisateur | Payante |

Au quotidien :

```bash
docker compose logs -f backend   # les journaux, et les courriels sans clé Brevo
docker compose down              # arrêter en gardant les données
docker compose down -v           # tout purger : base et fichiers déposés
```

Le code n'est pas monté en volume : après une modification, reconstruire avec
`docker compose up -d --build`.

### Option B : en développement, avec rechargement à chaud

Seule la base tourne en conteneur.

Une commande par ligne, sans `&&` : Windows PowerShell 5.1 ne connaît pas cet
opérateur, et ces instructions doivent tenir sur les trois systèmes.

```bash
# --- Backend ---
cd backend
cp .env.example .env        # y coller les trois clés générées ci-dessus
npm install
npm run db:up               # PostgreSQL sur le port 5433
npm run db:deploy           # applique les migrations
npm run build               # le seed s'exécute depuis dist/
npm run seed                # 3 comptes de démonstration
npm run start:dev           # API sur le port 3000
```

```bash
# --- Frontend, dans un second terminal ---
cd frontend
npm install
npm run dev                 # interface sur le port 3001
```

> ⚠️ **Les deux options publient le port 5433.** Elles ne peuvent pas tourner
> en même temps : arrêter l'une (`docker compose down`) avant de lancer l'autre.

---

## Les tests

Seul le backend est couvert. Les tests de bout en bout tournent contre un
**vrai** PostgreSQL, pas contre un double : c'est la seule façon d'éprouver les
contraintes d'unicité, les clés étrangères et les suppressions en cascade.

```bash
cd backend
npm run db:up               # la base doit tourner
npm run db:migrate:test     # prépare filemoica_test, une fois pour toutes

npm test                    # 145 tests unitaires
npm run test:e2e            # 189 tests de bout en bout
npm run lint
npx tsc --noEmit -p tsconfig.spec.json
```

> ⚠️ La base de test `filemoica_test` n'est créée que par le compose du
> **backend**, pas par celui de la racine. Les tests de bout en bout échouent si
> la pile complète tourne à sa place.

L'intégration continue rejoue l'ensemble à chaque pull request et à chaque
fusion dans `main` voir [docs/ci-cd.md](docs/ci-cd.md).

Le détail de ce qui a été éprouvé, et de ce qui a échoué en chemin est dans
[docs/resultats-des-tests.md](docs/resultats-des-tests.md). Le déroulé du sprint
est dans [docs/journal-de-sprint.md](docs/journal-de-sprint.md).

---

## Sécurité

Aucun secret n'est versionné : les fichiers `.env` sont ignorés par git, seuls
les `.example`, vides de valeurs, figurent dans le dépôt. Toute la
configuration sensible est injectée par variables d'environnement au démarrage,
jamais construite dans les images.
