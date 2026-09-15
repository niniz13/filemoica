# filemoica — Backend

API de partage de fichiers chiffrés. Un utilisateur dépose un fichier, crée un
lien de partage nominatif à durée limitée, et peut le révoquer à tout moment.

Ce document décrit **ce qui est réellement implémenté à ce jour** et les raisons
de chaque choix. Ce qui reste à faire est listé en fin de page, séparément, pour
qu'on ne confonde jamais l'intention et le code qui tourne.

---

## Sommaire

- [Démarrage rapide](#démarrage-rapide)
- [État d'avancement](#état-davancement)
- [Choix techniques](#choix-techniques)
- [Sécurité : ce qui est en place](#sécurité--ce-qui-est-en-place)
- [Modèle de données](#modèle-de-données)
- [Supervision et incident](#supervision-et-incident)
- [Contrats avec le reste de l'équipe](#contrats-avec-le-reste-de-léquipe)
- [Contraintes d'environnement rencontrées](#contraintes-denvironnement-rencontrées)
- [Tests](#tests)
- [Points ouverts](#points-ouverts)

---

## Démarrage rapide

**Prérequis :** Node.js **≥ 24.9** et Docker.

```bash
cp .env.example .env     # puis renseigner les valeurs (voir plus bas)
npm install              # génère aussi le client Prisma
npm run db:up            # démarre PostgreSQL
npm run db:migrate       # applique les migrations
npm run start:dev
```

Générer une clé de 32 octets pour `.env` :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Le service écoute sur le port 3000. Vérification :

```bash
curl http://localhost:3000/health
```

### Commandes utiles

| Commande | Rôle |
|---|---|
| `npm run start:dev` | Démarrage avec rechargement automatique |
| `npm test` | Tests unitaires |
| `npm run test:e2e` | Tests de bout en bout |
| `npm run lint` | Analyse statique |
| `npm run db:up` / `db:down` | Démarre / arrête PostgreSQL |
| `npm run db:reset` | Repart d'une base vierge (**supprime les données**) |
| `npm run db:migrate` | Crée et applique une migration |
| `npm run db:deploy` | Applique les migrations sans en créer (production) |

---

## État d'avancement

| Domaine | État |
|---|---|
| Socle HTTP (validation, format d'erreur, CORS, CSRF) | ✅ implémenté et testé |
| Base de données et migrations | ✅ implémenté et testé |
| Supervision `/health` | ✅ implémenté et testé |
| Chiffrement (enveloppe, index aveugle, jetons) | ✅ implémenté et testé |
| Authentification (inscription, connexion, sessions) | ⬜ schéma en base, endpoints à écrire |
| Dépôt et téléchargement de fichiers | ⬜ schéma en base, endpoints à écrire |
| Partages et révocation | ⬜ schéma en base, endpoints à écrire |

**88 tests au vert** (75 unitaires, 13 end-to-end), analyse statique et
vérification de types sans erreur.

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

### Tests configurés comme la production

`configureApp()` ([`src/app.setup.ts`](src/app.setup.ts)) regroupe pipes, filtres
et gardes ; `main.ts` et les tests end-to-end appellent la **même fonction**.

Sans cela, un test pourrait passer au vert sur une requête que le vrai service
rejetterait — le pire des faux positifs sur un projet de sécurité.

---

## Sécurité : ce qui est en place

### Chiffrement au repos : le modèle enveloppe

Le contenu d'un fichier n'est jamais chiffré directement avec la clé maître.
Chaque fichier reçoit **sa propre clé** (DEK), tirée au hasard ; seule cette
petite clé est chiffrée par la clé maître (KEK) et stockée en base. La clé maître
ne vit que dans les variables d'environnement.

```
Fichier ──chiffré par──> DEK ──chiffrée par──> KEK (variable d'environnement)
  sur disque              en base                  jamais stockée
```

L'intérêt est la **rotation de clés**. Avec une clé unique, en changer imposerait
de relire et re-chiffrer tous les fichiers. Ici on ne re-chiffre que les DEK,
quelques dizaines d'octets chacune : les fichiers ne sont pas touchés. C'est le
modèle employé par AWS KMS et Google Cloud KMS.

La bascule est déjà fonctionnelle : ajouter `ENCRYPTION_KEY_V2` à la
configuration suffit à chiffrer les nouvelles données en v2 tout en continuant à
lire celles en v1, **sans changement de code**. La version de clé voyage avec
chaque donnée.

### AES-256-GCM, et pourquoi pas CBC

GCM apporte le chiffrement **et** le contrôle d'intégrité. Un seul octet modifié
sur le disque rend le tag d'authentification invalide et fait échouer le
déchiffrement.

La différence est concrète : en CBC, un fichier altéré serait déchiffré et servi
au destinataire dans un état corrompu, sans que personne ne le sache. En GCM,
l'opération échoue. Un test le vérifie explicitement.

### Ce qui est chiffré, haché, ou en clair

| Donnée | Traitement | Pourquoi |
|---|---|---|
| Contenu des fichiers | Chiffré AES-256-GCM (disque) | Le vol du disque ne donne rien |
| Nom d'origine des fichiers | Chiffré en base | Un nom de fichier est déjà une information |
| Nom sur le disque | Aléatoire | Un `ls` du répertoire ne révèle rien |
| Email du destinataire | Chiffré + index HMAC | Comparable sans être déchiffré |
| Jeton de partage | SHA-256 uniquement | Une fuite de la base ne livre aucun lien utilisable |
| Refresh token | SHA-256 uniquement | Idem |
| Email du compte | **En clair** | La connexion doit chercher par email |
| Mot de passe | argon2id *(à venir)* | Fonction lente, conçue pour ça |

**`users.email` en clair est un choix assumé**, pas un oubli. Le chiffrer
imposerait un index aveugle pour permettre la connexion, pour un gain faible : la
donnée sensible d'un partage, c'est l'email du *destinataire*, et celui-là est
chiffré.

### L'index aveugle

Comparer un destinataire sans déchiffrer son adresse suppose un index. Deux
précautions :

- un **HMAC** et non un simple hachage : sans la clé, impossible de tester une
  liste d'emails contre la base pour découvrir qui a reçu quoi ;
- une **clé distincte** de celle du chiffrement — une clé, un usage ;
- une **normalisation** préalable (minuscules, espaces retirés), sans quoi
  `Alice@X.fr` ne retrouverait pas son propre partage.

### Protection CSRF sans jeton

Les sessions vivront dans des cookies `httpOnly`, que le navigateur envoie
automatiquement — y compris sur une requête déclenchée par un site tiers. Trois
couches répondent à ce risque :

1. `SameSite=Strict` sur les cookies : le navigateur ne les joint pas aux
   requêtes venues d'un autre site ;
2. une liste blanche CORS d'**une seule origine**, jamais de joker ;
3. un [garde](src/common/guards/csrf.guard.ts) qui exige l'en-tête
   `X-Requested-With` sur toute requête modifiant l'état.

La troisième couche fonctionne parce qu'un `<form>` HTML ne peut pas poser
d'en-tête personnalisé, et qu'une requête JavaScript qui en pose déclenche un
contrôle préalable que notre CORS refuse.

Le double-submit token classique a été écarté : il aurait imposé un cookie
lisible en JavaScript et du code côté front, pour une protection équivalente une
fois `SameSite=Strict` en place.

### Répartition avec l'infrastructure

**Le chiffrement du transport (HTTPS) est assuré par le reverse proxy géré par
SRC.** L'application tourne en HTTP derrière lui et n'expose aucun port au
public. C'est l'une des décisions communes du sprint : l'infrastructure protège
les données *en transit*, le backend les protège *au repos*.

---

## Modèle de données

Cinq tables, identifiants UUID, migration `20260915145703_init`.
Le schéma commenté est dans [`prisma/schema.prisma`](prisma/schema.prisma).

| Table | Rôle | Colonnes notables |
|---|---|---|
| `users` | Comptes | `password_hash` |
| `files` | Métadonnées des fichiers | `original_name_enc`, `dek_wrapped`, `key_version`, `content_iv`, `content_auth_tag`, `storage_name` |
| `shares` | Liens de partage | `token_hash`, `recipient_email_enc`, `recipient_email_hmac`, `expires_at`, `revoked` |
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
| Purge | Les jetons expirés sont à purger périodiquement (script à venir) |

### Pour le front (IW 1)

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

```bash
npm test          # 75 tests unitaires
npm run test:e2e  # 13 tests de bout en bout
```

Les tests end-to-end n'ont besoin d'aucune base : `PrismaService` est remplacé
par un double. C'est un choix délibéré — il permet de simuler une base tombée, ce
qu'on ne peut pas faire de façon fiable en arrêtant un vrai serveur au milieu
d'une suite. La panne réelle, elle, est vérifiée à la main (voir
[Incident](#incident-vérifié-le-1509)).

Les tests les plus significatifs pour l'évaluation :

| Ce qui est démontré | Emplacement |
|---|---|
| Un fichier altéré sur le disque n'est pas servi | `crypto.service.spec.ts` |
| Deux fichiers de même nom n'ont pas le même chiffré | `crypto.service.spec.ts` |
| Une fuite de la base ne livre aucun lien de partage | `crypto.service.spec.ts` |
| Une rotation de clés ne casse pas les données existantes | `crypto.service.spec.ts` |
| Une erreur interne ne divulgue rien au client | `all-exceptions.filter.spec.ts` |
| Un formulaire posté depuis un site tiers est bloqué | `csrf.guard.spec.ts` |
| La sonde bascule en 503 quand la base tombe | `health.e2e-spec.ts` |
| Un secret mal formé ne fuite pas dans les logs | `env.validation.spec.ts` |

---

## Points ouverts

### Stockage des fichiers et résilience — **à arbitrer avec SRC**

Le développement se fait contre une variable `STORAGE_PATH`, ce qui laisse le
choix ouvert entre un volume Docker nommé et un stockage objet (S3/MinIO) sans
rien réécrire *tant qu'il s'agit d'un chemin de système de fichiers*.

Un volume nommé est plus simple et réduit la surface d'attaque — comme le
contenu est déjà chiffré par l'application, le support de stockage ne protège
plus grand-chose, et un stockage objet ajouterait une paire de clés d'accès à
protéger.

**Mais un volume nommé attache les fichiers à une machine.** Il ne permet ni
plusieurs instances derrière un répartiteur de charge, ni le redémarrage du
service sur un autre hôte. Si l'objectif de résilience inclut ces cas, il faut du
stockage partagé, et l'arbitrage change.

**Échéance :** la décision doit être prise avant l'écriture du dépôt de fichiers,
car passer à du stockage objet remplace un chemin de fichier par un SDK.

### À implémenter

| Lot | Contenu |
|---|---|
| Authentification | Inscription (argon2id), connexion, cookies, garde de session, rotation du refresh token, révocation |
| Fichiers | Dépôt chiffré en flux, liste limitée au propriétaire |
| Partages | Création de liens, révocation, téléchargement avec les quatre contrôles d'accès |
| Rotation | Script de re-chiffrement des données existantes |
| Journalisation | Logs structurés pour la centralisation |
| Documentation d'API | Swagger et collection de requêtes pour le front |
