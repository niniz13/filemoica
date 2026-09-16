# filemoica — Backend

API de partage de fichiers chiffrés. Un utilisateur dépose un fichier et en tire
un lien à durée limitée, éventuellement protégé par un mot de passe, qu'il peut
révoquer à tout moment.

**Déposer exige un compte ; recevoir non.** Le destinataire ouvre le lien et
récupère le fichier, sans inscription.

Ce document décrit **ce qui est réellement implémenté à ce jour** et les raisons
de chaque choix. Ce qui reste à faire est listé en fin de page, séparément, pour
qu'on ne confonde jamais l'intention et le code qui tourne.

---

## Pour aller plus loin

Le détail de chaque domaine vit dans son propre document, pour que ce README
reste lisible d'un bout à l'autre :

| Document | Contenu |
|---|---|
| [Sécurité](docs/securite.md) | Chiffrement enveloppe, ce qui est chiffré ou haché, index aveugle, protection CSRF |
| [Authentification et fichiers](docs/authentification-et-fichiers.md) | Sessions, révocation, dépôt chiffré en flux, contrôle des formats, quotas |
| [Partages](docs/partages.md) | Liens publics, mot de passe, usage unique, durcissement du téléchargement |
| [Administration](docs/administration.md) | Rôles, gestion des comptes et des offres, frontière avec le contenu |
| [Exploitation](docs/exploitation.md) | Journaux, limitation des tentatives, purge, rotation des clés |
| [Décision — stockage](../docs/decision-stockage-fichiers.md) | Options étudiées, choix retenu, procédure de sauvegarde et restauration |

---


## Lancer le projet

### 1. Prérequis

| Outil | Version | Pourquoi cette contrainte |
|---|---|---|
| Node.js | **≥ 24.9** | NestJS 12 est distribué en ESM, et les tests ne s'exécutent pas sur une version antérieure. Vérifier avec `node -v` |
| Docker | récent | Fait tourner PostgreSQL, rien à installer sur le poste |

### 2. Installation

```bash
npm install
```

Cette commande génère aussi le client Prisma — inutile de le faire à la main.

### 3. Configuration

```bash
cp .env.example .env
```

Puis renseigner dans `.env` les trois secrets laissés vides. Chacun doit faire
**64 caractères hexadécimaux** (32 octets) ; générer une valeur avec :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Rôle |
|---|---|
| `JWT_SECRET` | Signature des jetons de session |
| `ENCRYPTION_KEY_V1` | Clé maître du chiffrement au repos |
| `HMAC_INDEX_KEY` | Index aveugle des emails de destinataires |

Le service **refuse de démarrer** si une variable manque ou est mal formée, et
affiche alors la liste complète des problèmes. Ce n'est pas une panne : c'est
volontaire, pour qu'une clé absente ne passe jamais inaperçue.

`.env` est ignoré par git. Aucun secret réel ne doit y être versionné.

### 4. Base de données

```bash
npm run db:up        # démarre PostgreSQL dans Docker
npm run db:migrate   # crée les tables
```

> **Port 5433, pas 5432.** Un PostgreSQL est déjà installé sur le poste de
> développement et occupe le port standard. Le conteneur, lui, écoute bien sur
> 5432 en interne — l'écart ne concerne que la machine locale.

### 5. Démarrer le service

```bash
npm run start:dev    # développement, avec rechargement automatique
```

En production, l'application se lance depuis les fichiers compilés :

```bash
npm run build
npm run start:prod
```

Le service écoute sur le port **3000**. Vérifier qu'il répond :

```bash
curl http://localhost:3000/health
# {"status":"ok","version":"dev","checks":{"database":"up"},...}
```

---

### Documentation de l'API (Swagger)

Une fois le service démarré :

| Adresse | Contenu |
|---|---|
| **<http://localhost:3000/api/docs>** | Documentation interactive : routes, schémas, codes d'erreur, et essai direct depuis la page |
| <http://localhost:3000/api/docs-json> | Spécification OpenAPI brute |

**Pour Postman ou Insomnia :** importer directement l'URL `/api/docs-json`
(*Import → Link*). La collection se régénère à chaque évolution de l'API, il n'y
a donc rien à maintenir à la main.

**Essayer une route protégée depuis la page :** appeler d'abord `/auth/login`
avec un compte existant, puis enchaîner sur les autres routes. Les cookies de
session sont `httpOnly` — l'interface ne peut pas les poser elle-même, mais le
navigateur les joint automatiquement une fois la connexion faite.

La documentation peut être coupée via `ENABLE_API_DOCS=false`, sans toucher au
code.

---

### Lancer les tests

**Tests unitaires** — aucune dépendance, ni base ni Docker :

```bash
npm test
```

**Tests de bout en bout** — les tests d'authentification tournent contre une
vraie base PostgreSQL. Il faut donc la démarrer et la préparer une fois :

```bash
npm run db:up            # si ce n'est pas déjà fait
npm run db:migrate:test  # prépare la base de test, distincte de celle de développement
npm run test:e2e
```

> Si les tests e2e échouent sur des tables absentes, c'est que
> `npm run db:migrate:test` n'a pas été rejoué après une migration.

**Autres vérifications :**

```bash
npm run lint             # analyse statique
npx tsc --noEmit         # vérification de types
```

### Toutes les commandes

| Commande | Rôle |
|---|---|
| `npm run start:dev` | Démarrage avec rechargement automatique |
| `npm run start:prod` | Démarrage depuis `dist/` (production) |
| `npm run build` | Compilation |
| `npm test` | Tests unitaires |
| `npm run test:e2e` | Tests de bout en bout (nécessite la base) |
| `npm run test:cov` | Tests unitaires avec couverture |
| `npm run lint` | Analyse statique |
| `npm run db:up` / `db:down` | Démarre / arrête PostgreSQL |
| `npm run db:reset` | Repart d'une base vierge (**supprime les données**) |
| `npm run db:migrate` | Crée et applique une migration |
| `npm run db:migrate:test` | Applique les migrations sur la base de test |
| `npm run db:deploy` | Applique les migrations sans en créer (production) |
| `npm run db:studio` | Interface de consultation de la base |
| `npm run keys:rotate` | Bascule les données vers la nouvelle clé maître (`-- --dry-run` pour simuler) |
| `npm run tokens:purge` | Supprime les jetons expirés |
| `npm run seed` | Crée les comptes de démonstration |

---

## État d'avancement

| Domaine | État |
|---|---|
| Socle HTTP (validation, format d'erreur, CORS, CSRF) | ✅ implémenté et testé |
| Base de données et migrations | ✅ implémenté et testé |
| Supervision `/health` | ✅ implémenté et testé |
| Chiffrement (enveloppe, index aveugle, jetons) | ✅ implémenté et testé |
| Authentification (inscription, connexion, sessions, révocation) | ✅ implémenté et testé |
| Documentation OpenAPI (`/api/docs`) | ✅ implémenté et testé |
| Dépôt, liste et suppression de fichiers | ✅ implémenté et testé |
| Quota mensuel et offres | ✅ implémenté et testé |
| Partages, révocation et téléchargement | ✅ implémenté et testé |
| Rotation des clés de chiffrement | ✅ implémenté et testé |
| Journaux, limitation de tentatives, purge | ✅ implémenté et testé |
| Rôles et administration des comptes | ✅ implémenté et testé |

**282 tests au vert** (128 unitaires, 154 end-to-end), analyse statique et
vérification de types sans erreur.

**Le parcours utilisateur est complet** : déposer, partager, télécharger,
révoquer. Le destinataire n'a pas besoin de compte.

---

## Choix techniques

### NestJS plutôt qu'Express

Le cadrage initial prévoyait Express. NestJS a été retenu pour une raison
précise : ses **gardes** et ses **pipes** rendent les contrôles d'accès
déclaratifs et isolés. Une règle de sécurité devient une classe testable
unitairement, plutôt qu'un `if` au milieu d'un contrôleur. Sur un projet dont
l'enjeu est justement le contrôle d'accès, c'est ce qui rend les vérifications
démontrables une par une.

### PostgreSQL et Prisma

PostgreSQL pour les contraintes d'intégrité (clés étrangères, unicité) : une
donnée incohérente est refusée par la base, pas seulement par le code.

Prisma pour ses **migrations versionnées**. Chaque changement de schéma est un
fichier SQL horodaté dans le dépôt, rejouable sur une base vierge — c'est ce qui
rend la procédure de restauration reproductible plutôt qu'artisanale.

Version **figée à l'exact en 7.10.0** : voir [Contraintes
d'environnement](#contraintes-denvironnement-rencontrées).

### Configuration validée au démarrage

[`src/config/env.validation.ts`](src/config/env.validation.ts) déclare chaque
variable attendue avec sa règle de validation. Si une clé manque ou est mal
formée, **le service refuse de démarrer** et affiche la liste complète des
problèmes.

Trois conséquences voulues :

- une clé de chiffrement trop courte ne peut pas passer inaperçue jusqu'en
  production ;
- aucun secret n'a de valeur par défaut — un oubli provoque une erreur, jamais
  un démarrage silencieux avec une valeur faible ;
- les messages d'erreur ne contiennent **jamais** la valeur fautive, car ils
  partent dans les logs.

### Format d'erreur unique

Toutes les erreurs de l'API ont la même forme, garantie par un filtre global
([`all-exceptions.filter.ts`](src/common/filters/all-exceptions.filter.ts)) :

```json
{ "error": "SHARE_REVOKED", "message": "Ce lien de partage a été révoqué." }
```

`error` est un code machine stable, sur lequel le front branche ses conditions.
`message` est destiné à l'utilisateur.

Le filtre assure aussi l'étanchéité : une exception imprévue (erreur Prisma, bug)
est journalisée côté serveur avec sa trace complète, mais renvoyée au client en
**500 anonyme**. Ni requête SQL, ni chemin serveur, ni nom de table ne franchit
la frontière.

### Documentation générée depuis le code

La documentation OpenAPI n'est pas écrite à part : elle est **déduite du code**.
Le plugin `@nestjs/swagger` déclaré dans `nest-cli.json` lit les types
TypeScript, les décorateurs `class-validator` et les commentaires de
documentation à la compilation.

Concrètement, une contrainte écrite une seule fois — « le mot de passe fait au
moins 12 caractères » — sert à la fois à valider les requêtes et à documenter
l'API. Il n'y a rien à resynchroniser quand la règle change.

Les seules annotations manuelles portent sur les **réponses d'erreur** : aucun
outil ne peut deviner qu'une route renvoie `EMAIL_ALREADY_USED` en 409. Ce sont
justement les informations dont le front a le plus besoin.

### Tests configurés comme la production

`configureApp()` ([`src/app.setup.ts`](src/app.setup.ts)) regroupe pipes, filtres
et gardes ; `main.ts` et les tests end-to-end appellent la **même fonction**.

Sans cela, un test pourrait passer au vert sur une requête que le vrai service
rejetterait — le pire des faux positifs sur un projet de sécurité.

---

## Modèle de données

Cinq tables, identifiants UUID, migration `20260915145703_init`.
Le schéma commenté est dans [`prisma/schema.prisma`](prisma/schema.prisma).

| Table | Rôle | Colonnes notables |
|---|---|---|
| `users` | Comptes | `password_hash` |
| `files` | Métadonnées des fichiers | `original_name_enc`, `dek_wrapped`, `key_version`, `content_iv`, `content_auth_tag`, `storage_name` |
| `shares` | Liens de partage | `owner_id`, `token_hash`, `recipient_email_enc`, `recipient_email_hmac`, `expires_at`, `revoked`, `burn_after_download`, `consumed_at` |
| `share_files` | Fichiers couverts par un lien | `downloaded_at` (verrou du lien à usage unique) |
| `monthly_usage` | Quota déposé par mois | `period`, `bytes` (cumul, ne décroît jamais) |
| `refresh_tokens` | Sessions longues | `token_hash`, `family_id`, `revoked_at`, `replaced_by_id` |
| `revoked_access_tokens` | Déconnexions | `jti`, `expires_at` |

Les colonnes suffixées `_enc` contiennent une chaîne compacte
`<version>.<iv>.<tag>.<chiffré>` : tout tenir dans une colonne évite d'en
multiplier trois par champ chiffré.

`refresh_tokens.family_id` prépare la **détection de réutilisation** : tous les
jetons issus d'une même connexion partagent une lignée. Si un jeton déjà utilisé
est rejoué, c'est qu'il a été volé — on révoquera alors la famille entière plutôt
que ce seul jeton.

---

## Supervision et incident

`GET /health` — volontairement **hors du préfixe `/api`** et sans
authentification : c'est une URL d'infrastructure, appelée par le reverse proxy
et l'orchestrateur.

```json
{
  "status": "ok",
  "version": "dev",
  "checks": { "database": "up" },
  "checkedAt": "2026-09-15T15:02:37.901Z"
}
```

La sonde exécute un `SELECT 1` réel. Une connexion ouverte ne prouve rien : elle
peut rester dans le pool alors que le serveur est tombé.

**Le statut HTTP porte l'information, pas seulement le corps de la réponse.**
Base injoignable, c'est **503** — un orchestrateur regarde le code, et sans ce
503 une instance cassée continuerait de recevoir du trafic.

La réponse ne divulgue aucun détail d'infrastructure : ni hôte, ni port, ni nom
de base. Un test le vérifie.

### Incident vérifié le 15/09

Cycle joué contre la vraie base, application démarrée depuis `dist/` :

| Action | Observé |
|---|---|
| État nominal | `200` — `{"status":"ok","checks":{"database":"up"}}` |
| `docker compose stop db` | `503` |
| `docker compose start db` | `200` — retour à `up` |

Reprise en **~8 secondes sans redémarrer l'application** : le pool de connexions
se rétablit seul. Mesure indicative à rejouer avec chronomètre et captures pour
le tableau de tests.

---

## Contrats avec le reste de l'équipe

### Pour l'infrastructure (SRC)

| Point | Détail |
|---|---|
| Image de base | **`node:24-alpine`** — impératif, voir contraintes ci-dessous |
| HTTPS | **Obligatoire.** Les cookies porteront le drapeau `Secure` : en HTTP, la session ne fonctionne pas |
| Sonde | `GET /health` — 200 sain, 503 dégradé |
| Secrets à fournir | `JWT_SECRET`, `ENCRYPTION_KEY_V1`, `HMAC_INDEX_KEY`, `DATABASE_URL` |
| Sauvegarde | **Deux artefacts indissociables** : `pg_dump` (les clés chiffrées) **et** le contenu de `STORAGE_PATH` (les fichiers chiffrés). Restaurer l'un sans l'autre ne donne rien d'exploitable |
| Purge | `npm run tokens:purge` à planifier une fois par jour |
| **`TRUST_PROXY_HOPS`** | **À régler** selon le nombre de relais devant le service. Sans cela, la limitation de tentatives bloque tout le monde d'un coup |
| Journaux | JSON, une ligne par requête, sur la sortie standard |
| `ENABLE_API_DOCS` | Expose `/api/docs`. À `true` par défaut ; peut être coupé en production pour réduire ce qu'un attaquant apprend de la surface de l'API |
| Rotation des clés | `npm run keys:rotate` quand une clé doit être changée |

### Pour le front (IW 1)

**Documentation interactive : <http://localhost:3000/api/docs>** — routes,
schémas de requête et de réponse, codes d'erreur, et essai direct depuis la page.

La spécification OpenAPI brute est sur `/api/docs-json` : Postman et Insomnia
l'importent directement depuis cette URL, ce qui évite de maintenir une
collection à la main.

Deux lignes à placer dans le wrapper `fetch`, faute de quoi rien ne fonctionnera :

```js
fetch(url, {
  credentials: 'include',                          // sans ça, pas de cookie envoyé
  headers: { 'X-Requested-With': 'XMLHttpRequest' } // sans ça, 403 sur les écritures
});
```

- **Pas de jeton en `localStorage`, pas d'en-tête `Authorization`.** Les cookies
  sont `httpOnly` : le JavaScript n'y a pas accès, et c'est précisément ce qui
  protège la session d'un vol par injection de script.
- Toutes les erreurs ont la forme `{ error, message }` ; brancher les conditions
  sur `error`, qui est stable.
- L'origine du front doit être déclarée dans `FRONTEND_ORIGIN` côté backend.

---

## Contraintes d'environnement rencontrées

Trois obstacles réels, rencontrés et résolus pendant le sprint.

### Node.js ≥ 24.9 obligatoire

NestJS 12 est distribué **uniquement en ESM**, et Jest ne sait charger de l'ESM
qu'à partir de Node 24.9. Conséquence : le squelette de projet initial ne pouvait
exécuter **aucun test**.

`engines` est verrouillé dans `package.json` et les scripts de test portent le
drapeau `--experimental-vm-modules` — nécessaire même sur Node 24, car Jest
s'appuie sur `vm.SourceTextModule`, qui reste derrière ce drapeau.

### Prisma figée en 7.10.0

`npm install prisma` installait une **release candidate** (8.0.0-rc.15, publiée
sous le tag `latest`). Les versions sont figées à l'exact sur la 7.10.0 stable.

Prisma 7 impose deux particularités :

- un **adaptateur de pilote** (`@prisma/adapter-pg`) — Prisma construit les
  requêtes, `pg` parle à PostgreSQL ;
- un [`prisma7.config.ts`](prisma7.config.ts) qui charge `dotenv`
  **explicitement** : le `.env` n'est plus lu automatiquement, et son oubli fait
  échouer les migrations sans message clair.

### PostgreSQL sur le port 5433

Un PostgreSQL est déjà installé sur le poste de développement et occupe le 5432.
Le conteneur du projet est donc publié sur **5433** côté hôte.

Le conteneur écoute toujours sur 5432 en interne : **aucun impact pour SRC**,
l'écart ne concerne que la machine de développement.

---

## Tests

Les commandes sont dans [Lancer les tests](#lancer-les-tests). Cette section
explique **ce qui est testé et pourquoi**.

Le principe retenu : couvrir ce qui porte une garantie de sécurité ou une règle
métier, pas chaque fichier. Un test qui ne ferait que redire ce que le code écrit
déjà coûte du temps à écrire, du temps à lire, et se contente de figer
l'implémentation.

**Deux stratégies selon ce qui est prouvé.** Les tests de socle et de supervision
remplacent `PrismaService` par un double : c'est ce qui permet de simuler une
base tombée, impossible à faire de façon fiable en arrêtant un vrai serveur au
milieu d'une suite.

Les tests d'authentification, eux, tournent contre une **vraie base**
(`filemoica_test`, distincte de celle de développement). C'est le seul moyen de
prouver que les contraintes d'unicité, les suppressions en cascade et la
révocation de session se comportent réellement comme annoncé — et ce sont
justement ces garanties qui sont évaluées.

Les tests les plus significatifs pour l'évaluation :

| Ce qui est démontré | Emplacement |
|---|---|
| Une personne non authentifiée n'accède pas à une ressource protégée | `auth.e2e-spec.ts` |
| Une session révoquée cesse immédiatement de fonctionner | `auth.e2e-spec.ts` |
| Un refresh token rejoué coupe toute la lignée | `auth.e2e-spec.ts` |
| Le refresh token n'est jamais stocké en clair | `auth.e2e-spec.ts` |
| Email inconnu et mot de passe faux donnent la même réponse | `auth.e2e-spec.ts` |
| Une tentative d'élévation (`role: ADMIN`) est refusée | `auth.e2e-spec.ts` |
| Un fichier altéré sur le disque n'est pas servi | `crypto.service.spec.ts` |
| Deux fichiers de même nom n'ont pas le même chiffré | `crypto.service.spec.ts` |
| Une fuite de la base ne livre aucun lien de partage | `crypto.service.spec.ts` |
| Une rotation de clés ne casse pas les données existantes | `crypto.service.spec.ts` |
| Une rotation ne touche pas aux fichiers sur le disque | `key-rotation.e2e-spec.ts` |
| Le contenu reste déchiffrable après rotation | `key-rotation.e2e-spec.ts` |
| Une erreur interne ne divulgue rien au client | `all-exceptions.filter.spec.ts` |
| Un formulaire posté depuis un site tiers est bloqué | `csrf.guard.spec.ts` |
| La sonde bascule en 503 quand la base tombe | `health.e2e-spec.ts` |
| Un secret mal formé ne fuite pas dans les logs | `env.validation.spec.ts` |
| Un jeton de partage n'apparaît jamais dans les journaux | `request-logger.middleware.spec.ts` · `all-exceptions.filter.spec.ts` |
| Les tentatives répétées sont bloquées par adresse | `rate-limit.guard.spec.ts` |
| Une variable à `false` est bien interprétée comme fausse | `env.validation.spec.ts` |
| Un fichier déposé est illisible sur le disque | `files.e2e-spec.ts` |
| …et reste pourtant récupérable avec sa clé | `files.e2e-spec.ts` |
| Un utilisateur ne voit pas les fichiers d'un autre | `files.e2e-spec.ts` |
| Le fichier d'autrui renvoie 404, pas 403 | `files.e2e-spec.ts` |
| Un exécutable déguisé en PDF est refusé | `files.e2e-spec.ts` |
| Le quota gratuit bloque réellement le dépôt | `files.e2e-spec.ts` |
| Un destinataire sans compte récupère bien le fichier | `shares.e2e-spec.ts` |
| Une révocation coupe l'accès immédiatement | `shares.e2e-spec.ts` |
| Un lien protégé refuse le téléchargement sans mot de passe | `shares.e2e-spec.ts` |
| Un lien protégé ne révèle pas ce qu'il contient | `shares.e2e-spec.ts` |
| Un lien à usage unique efface les fichiers du serveur | `shares.e2e-spec.ts` |
| Un lien reste utilisable tant que tous ses fichiers ne sont pas pris | `shares.e2e-spec.ts` |
| Deux téléchargements simultanés : un seul passe | `shares.e2e-spec.ts` |
| Un lien expiré répond 410, pas 404 | `shares.e2e-spec.ts` |
| La base ne contient aucun jeton de partage en clair | `shares.e2e-spec.ts` |

---

## Points ouverts

### Limites assumées

Le stockage des fichiers a été arbitré avec SRC le 16/09 : **volume Docker
nommé** monté sur `STORAGE_PATH`, sur une VM unique. Le raisonnement complet et
les options écartées sont dans
[docs/decision-stockage-fichiers.md](../docs/decision-stockage-fichiers.md).

Trois limites en découlent, assumées plutôt que passées sous silence :

- **Les fichiers sont attachés à une machine.** Perdre la VM revient à perdre les
  fichiers déposés depuis la dernière sauvegarde.
- **Une seule instance.** Pas de répartition de charge ni de bascule
  automatique : monter en charge signifie ici agrandir la machine.
- **Le service est indisponible pendant un redémarrage**, quelques secondes.

Ces limites viennent du cadre du projet — un service temporaire sur une VM — et
non d'un oubli de conception. Le passage à un stockage partagé a été évalué et
écarté ; l'interface `FileStorage` le garde réalisable en environ une heure si le
besoin apparaissait.

### À implémenter

| Lot | Contenu |
|---|---|
| Sauvegarde et restauration | À jouer et chronométrer avec SRC — procédure déjà écrite dans [le document de décision](../docs/decision-stockage-fichiers.md) |
| Conteneurisation | Dockerfile de l'application — **à répartir avec SRC** |
| Rétention des fichiers | Aucun nettoyage automatique des fichiers dont tous les partages ont expiré. Politique à décider ensemble |
