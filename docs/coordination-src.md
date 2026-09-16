# Déploiement du backend — pour SRC

**Rendu jeudi 17/09 à 17 h 15.**

Le backend est terminé, testé, et **conteneurisé**. L'image a été construite,
lancée et vérifiée de bout en bout le 16/09 — elle ne demande plus de travail de
notre côté.

Ce document liste ce qui dépend de vous. **Répondez directement dans les cases
« votre réponse »** : il est fait pour ça.

---

## Ce qu'on vous livre

| Fichier | Rôle |
|---|---|
| [`backend/Dockerfile`](../backend/Dockerfile) | Image multi-étapes, utilisateur non-root |
| [`backend/docker-compose.deploy.yml`](../backend/docker-compose.deploy.yml) | **La pile à déployer** : base, migrations, application — durcie |
| [`backend/.env.deploy.example`](../backend/.env.deploy.example) | Modèle de configuration à remplir |
| [`backend/scripts/verifier-deploiement.mjs`](../backend/scripts/verifier-deploiement.mjs) | Vérifie un déploiement de l'extérieur |
| **[configuration-deploiement.md](configuration-deploiement.md)** | **Toutes les variables d'environnement, leurs contraintes et ce qui casse si elles sont mal réglées** |

> 📖 **À garder ouvert pendant le déploiement :**
> [configuration-deploiement.md](configuration-deploiement.md). Ce document-ci
> porte les décisions et les questions ; celui-là est la référence technique.

```bash
cd backend
cp .env.deploy.example .env.deploy     # puis remplir les trois clés
docker compose -f docker-compose.deploy.yml --env-file .env.deploy -p filemoica up -d --build
node scripts/verifier-deploiement.mjs http://localhost:3000
```

> ⚠️ **Il existe un `docker-compose.yml` à la racine du dépôt — ce n'est pas
> celui-là.** Il monte tout le projet, frontend compris, pour qu'on puisse
> essayer le service en une commande. Il publie la base sur l'hôte, tourne en
> `NODE_ENV=development` et n'a aucun durcissement : il est fait pour une
> démonstration sur un poste, pas pour être exposé.
>
> **Le fichier à déployer est `backend/docker-compose.deploy.yml`.**

Le compose enchaîne tout seul : base saine → migrations → application. Le
conteneur de migrations s'arrête une fois son travail fait, et l'application ne
démarre qu'après lui — elle ne peut donc pas servir de requêtes sur un schéma
incomplet.

### Le script de vérification, à lancer après chaque déploiement

Il joue un **parcours complet** contre le service en ligne : création de compte,
dépôt d'un fichier, création d'un lien, téléchargement **sans compte**, puis
comparaison octet par octet avec l'original. Il nettoie derrière lui et sort en
code 0 ou 1 — utilisable tel quel dans un déploiement automatisé.

C'est ce qui distingue « le conteneur répond » de « le service fonctionne ». Un
conteneur peut très bien être `healthy` avec un volume non inscriptible : la
sonde passe, et le premier dépôt échoue.

> Résultat du 16/09 sur la pile complète : **15 vérifications, 0 échec.**

---

## 🔴 Ce que vous devez fournir

### 1. Le volume doit appartenir à l'uid 1000

**C'est le seul point qui casse en général.** Le conteneur tourne sans
privilèges et ne peut pas s'approprier un volume qui appartient à `root`.

- **Volume Docker nommé** (ce que fait le compose livré) : rien à faire, Docker
  recopie les permissions du répertoire de l'image.
- **Répertoire de l'hôte** (bind mount) : `chown -R 1000:1000` une fois.

Le chemin dans le conteneur est `/var/lib/filemoica/storage`.

> **Votre réponse — volume nommé ou répertoire de l'hôte ?** …

### 2. Les secrets

Trois valeurs de **64 caractères hexadécimaux**, différentes entre elles :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Rôle | Si elle est perdue |
|---|---|---|
| `ENCRYPTION_KEY_V1` | Chiffrement des fichiers | **Tous les fichiers sont irrécupérables** |
| `HMAC_INDEX_KEY` | Index des emails de destinataires | Les partages existants ne se retrouvent plus |
| `JWT_SECRET` | Signature des sessions | Sans gravité : tout le monde se reconnecte |

Plus `POSTGRES_PASSWORD`, `FRONTEND_ORIGIN` et, si besoin, `COOKIE_DOMAIN`.

> **Votre réponse — où les stockez-vous ?** …

### 3. `TRUST_PROXY_HOPS`

Nombre de relais entre le client et l'application. Derrière votre reverse proxy,
c'est probablement `1`.

**Sans ce réglage, toutes les requêtes semblent venir de l'adresse du proxy** —
et la limitation de tentatives bloquerait tout le monde d'un coup dès qu'un seul
visiteur s'agite.

> **Votre réponse — combien de relais ?** …

### 4. HTTPS

Les cookies de session portent le drapeau `Secure` en production : **en HTTP, la
connexion ne fonctionne tout simplement pas.** Ce n'est pas une préférence, c'est
un prérequis.

L'application parle HTTP et n'est publiée que sur la boucle locale
(`127.0.0.1:3000`) : c'est votre reverse proxy qui l'expose au public.

### 5. Deux tâches planifiées

```cron
0 3 * * * docker compose -f /srv/filemoica/docker-compose.deploy.yml -p filemoica exec -T app node dist/purge-files.js
0 4 * * * docker compose -f /srv/filemoica/docker-compose.deploy.yml -p filemoica exec -T app node dist/purge-tokens.js
```

*(Commandes vérifiées en conteneur le 16/09.)*

Elles n'ont **pas le même niveau de risque** :

| Tâche | Ce qu'elle efface | Si elle ne tourne pas |
|---|---|---|
| `purge-tokens` | Des jetons déjà expirés | Sans conséquence |
| `purge-files` | **Des fichiers utilisateurs** | **Le disque se remplit jusqu'à saturation** |

**`purge-files` est celle qui compte pour vous.** Le quota mensuel compte les
dépôts, pas le stockage occupé : sans cette tâche, le volume grossit
indéfiniment sans qu'aucun compteur ne s'en aperçoive — jusqu'au jour où plus
aucun dépôt ne passe, pour tout le monde à la fois.

Avant la première exécution réelle, lancez-la en simulation — même décompte,
aucune suppression :

```bash
docker compose -p filemoica exec -T app node dist/purge-files.js --dry-run
```

> **Votre réponse — les deux lignes sont-elles posées ?** …

---

## 🔴 Sauvegardes — la partie qui vous revient entièrement

La procédure de restauration a été **jouée et chronométrée le 16/09** contre la
pile conteneurisée : restauration complète en **~30 secondes**, fichier récupéré
**identique au bit près**. **Ce qui reste à votre main, c'est la sauvegarde en
production.**

> ⚠️ **La procédure a été corrigée à cette occasion — prenez la version à jour.**
> La première version échouait silencieusement : les migrations recréaient le
> schéma avant la restauration, `psql` continuait après chaque erreur, et on
> obtenait une base à moitié restaurée sans qu'aucune commande ne signale
> d'échec. Deux points à retenir pour vos scripts :
>
> - **Démarrer la base seule** (`up -d db`), restaurer, et seulement ensuite
>   lancer l'application. Le dump contient déjà le schéma.
> - **Toujours `-v ON_ERROR_STOP=1`** sur `psql`. Sans lui, une restauration
>   ratée se termine sans rien dire.
>
> Commandes complètes dans
> [le document de décision](decision-stockage-fichiers.md#restauration--lordre-et-létat-de-la-base-comptent).

### Deux artefacts indissociables

Une sauvegarde complète, c'est **deux choses** :

1. le **dump de la base** — qui contient les clés de fichiers chiffrées ;
2. le **contenu du volume** — les fichiers chiffrés eux-mêmes.

**Restaurer l'un sans l'autre ne donne rien d'exploitable.** Une procédure qui
n'en sauvegarde qu'un seul est inutile.

### L'ordre n'est pas neutre

**Sauvegarder la base d'abord, les fichiers ensuite.**

Entre les deux prises, un utilisateur peut déposer un fichier :

- Base puis fichiers → les octets sont sauvegardés, la ligne en base n'existe
  pas encore : un fichier orphelin, **sans conséquence**.
- Fichiers puis base → la ligne existe, les octets manquent : un téléchargement
  **cassé** au moment où l'utilisateur en aura besoin.

**À la restauration, l'ordre s'inverse** : les fichiers d'abord, la base ensuite.

### ⚠️ La clé maître ne part jamais avec la sauvegarde

Les deux artefacts sont chiffrés, donc inexploitables tels quels. Ils cessent de
l'être dès qu'ils voyagent avec le fichier de configuration.

**Ne jamais ranger `ENCRYPTION_KEY_V1` au même endroit que les sauvegardes.**
Corollaire aussi important : **une sauvegarde sans la clé est irrécupérable** —
la perdre revient à perdre tous les fichiers.

Commandes complètes dans [le document de décision](decision-stockage-fichiers.md).

> **Votre réponse — sauvegardes planifiées, et testées ?** …

---

## 🟡 Durcissement — déjà prévu, à confirmer

Le compose livré applique `read_only`, `cap_drop: ALL` et
`no-new-privileges`. Ces options sont compatibles avec l'image : le seul chemin
dont l'application a besoin en écriture est son volume de stockage.

**Une chose qu'on ne peut pas faire à votre place :** donner à l'application un
compte PostgreSQL **sans droits DDL**, et réserver un compte habilité au
conteneur de migrations. C'est la seule vraie barrière contre un `DROP TABLE` si
l'application était compromise.

> **Votre réponse — faisable dans le temps imparti ?** …

---

## 🟢 Ce que le backend vous fournit déjà

| Besoin | Ce qui existe |
|---|---|
| Sonde de supervision | `GET /health` — `200` sain, `503` base injoignable, hors préfixe `/api`, sans authentification |
| Sonde Docker | Intégrée à l'image, `Up (healthy)` sans intervention |
| Journaux | JSON, une ligne par requête, sur la sortie standard. **Les jetons de partage y sont masqués** |
| Corrélation | En-tête `X-Request-Id` sur chaque réponse |
| Arrêt ordonné | `docker stop` en **0,5 s**, sans requête tranchée |
| Rotation des clés | `npm run keys:rotate` (`-- --dry-run` pour simuler) — mesurée à 101 ms, sans interruption |
| Conservation | Automatique : 30 jours en offre gratuite, 90 en payante, réglables sans redéploiement |
| Documentation d'API | `/api/docs`, coupable via `ENABLE_API_DOCS=false` |

**Le `/health` renvoie bien `503` quand la base tombe** — pas un `200` avec un
champ d'erreur. Votre orchestrateur peut donc retirer l'instance sans analyser le
corps de la réponse. Vérifié le 15/09 : cycle `200` → `503` → `200`, reprise en
~8 secondes sans redémarrer l'application.

---

## 🟢 Dernière question ouverte — l'espace disque

La taille maximale d'un fichier est de **200 Mo** et l'offre gratuite autorise
**200 Mo par mois et par compte**. Ces valeurs sont configurables sans toucher au
code.

Depuis que la conservation est bornée, l'occupation du volume **plafonne** au
lieu de croître indéfiniment :

> 200 Mo/mois × 30 jours de conservation ≈ **200 Mo par compte gratuit actif**,
> et jusqu'à **60 Go par compte payant** (20 Go/mois × 90 jours).

Le pic dépend donc surtout du nombre de comptes payants. Pour la démonstration,
quelques gigaoctets suffisent largement.

> **Combien d'espace est alloué au volume ?** …

---

## Récapitulatif — ce qu'on attend de vous

| # | Point | Urgence |
|---|---|---|
| 1 | Volume monté, appartenant à l'uid 1000 | 🔴 Avant le déploiement |
| 2 | Secrets générés, stockés **hors des sauvegardes** | 🔴 Avant le déploiement |
| 3 | Sauvegardes planifiées — **les deux artefacts** | 🔴 Avant le déploiement |
| 4 | HTTPS en place | 🔴 Sinon la connexion ne fonctionne pas |
| 5 | Valeur de `TRUST_PROXY_HOPS` | 🟡 Avant le déploiement |
| 6 | Les deux purges planifiées | 🟡 Avant le déploiement |
| 7 | Compte PostgreSQL sans droits DDL pour l'application | 🟢 Si le temps le permet |
| 8 | Espace alloué au volume | 🟢 À arbitrer |

*Ce qui figurait ici et n'y est plus : le Dockerfile (écrit et vérifié), la
politique de conservation (tranchée — 30 jours en gratuit, 90 en payant) et le
créneau commun pour la démonstration de restauration (elle se joue de notre
côté, la sauvegarde en production reste la vôtre).*
