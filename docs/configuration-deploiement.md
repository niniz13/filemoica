# Configuration du backend — référence de déploiement

Toutes les variables d'environnement du service, ce qu'elles font, et ce qui
casse si elles sont mal réglées.

Ce document est une **référence** : gardez-le ouvert pendant le déploiement.
Pour ce qu'on attend de vous et les questions en suspens, voir
[coordination-src.md](coordination-src.md).

---

## En bref — le minimum vital

Si vous ne lisez qu'une section, c'est celle-ci. **Neuf valeurs à fournir**, tout
le reste a une valeur par défaut raisonnable :

| Variable | Comment l'obtenir |
|---|---|
| `POSTGRES_PASSWORD` | Au choix, long et aléatoire |
| `JWT_SECRET` | 64 caractères hexadécimaux, générés (voir plus bas) |
| `ENCRYPTION_KEY_V1` | 64 caractères hexadécimaux, générés |
| `HMAC_INDEX_KEY` | 64 caractères hexadécimaux, générés |
| **`BREVO_API_KEY`** | **Transmise par l'équipe IW** — voir « Envoi de courriels » |
| **`MAIL_FROM_ADDRESS`** | L'adresse d'expédition, **validée dans Brevo** |
| **`APP_PUBLIC_URL`** | L'URL publique du front : elle construit les liens envoyés par courriel |
| `FRONTEND_ORIGIN` | L'URL exacte du front, par exemple `https://filemoica.example.fr` |
| `TRUST_PROXY_HOPS` | Nombre de relais devant le service — `1` derrière un reverse proxy |

Plus une décision d'infrastructure : **le volume de stockage doit appartenir à
l'uid 1000**. C'est le point qui casse le plus souvent.

> ⚠️ **Deux migrations sont à appliquer** avant de servir cette version :
> `verification_adresse_email` et `double_authentification`.
> `npm run db:deploy` s'en charge. Sur une base déjà en service, **aucune
> connexion ne fonctionnera tant qu'elles ne sont pas passées** — les tables
> `email_verifications` et `mfa_challenges` n'existeraient pas.

Partez de [`backend/.env.deploy.example`](../backend/.env.deploy.example), il
contient déjà la structure.

---

## Ce qui se passe si une variable est mauvaise

**Le service refuse de démarrer.** Ce n'est pas une panne, c'est voulu : une clé
absente ou mal formée ne doit jamais passer inaperçue jusqu'à la mise en ligne.

Il affiche alors **tous** les problèmes d'un coup, pour que vous corrigiez en une
fois plutôt que de redémarrer six fois de suite :

```
Configuration invalide, le service ne peut pas démarrer :
  - ENCRYPTION_KEY_V1 : ENCRYPTION_KEY_V1 doit faire 64 caractères hexadécimaux
  - FRONTEND_ORIGIN : FRONTEND_ORIGIN must be a URL address
Voir .env.example pour la liste des variables attendues.
```

**Les valeurs fautives ne sont jamais affichées** — seulement le nom de la
variable. Un secret mal formé ne doit pas finir dans les journaux de démarrage.

---

## 1. Les secrets

### Génération

Trois valeurs de **64 caractères hexadécimaux** (32 octets), **différentes entre
elles** :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Lancez la commande trois fois. Ne réutilisez pas la même valeur pour deux
variables : une clé, un usage.

### Ce que chacune protège

| Variable | Rôle | Si elle est perdue | Si elle fuit |
|---|---|---|---|
| `ENCRYPTION_KEY_V1` | Clé maître du chiffrement des fichiers | **Tous les fichiers sont définitivement irrécupérables** | Les fichiers et les sauvegardes deviennent lisibles |
| `HMAC_INDEX_KEY` | Index aveugle des emails de destinataires | Les partages existants ne se retrouvent plus | On peut tester si un email donné a reçu un partage |
| `JWT_SECRET` | Signature des sessions | Sans gravité — tout le monde se reconnecte | On peut forger une session valide |

`JWT_SECRET` doit faire **au moins 32 caractères** ; les deux autres exactement
64 caractères hexadécimaux, ni plus ni moins. Une clé plus courte affaiblirait
silencieusement le chiffrement, d'où le refus de démarrer.

### ⚠️ Deux règles de rangement

**1. `ENCRYPTION_KEY_V1` ne part jamais avec les sauvegardes.** Le dump de la
base et le contenu du volume sont chiffrés, donc inexploitables tels quels. Ils
cessent de l'être à la seconde où ils voyagent avec la clé.

**2. Une sauvegarde sans la clé est irrécupérable.** Le corollaire est aussi
important : perdre la clé revient à perdre tous les fichiers, sauvegardés ou
non. Rangez-la ailleurs, mais rangez-la.

---

## 2. Envoi de courriels — Brevo

Le service envoie deux types de messages :

| Message | Quand | Sans lui |
|---|---|---|
| Lien de confirmation | À l'inscription, **toujours** | Aucun compte ne peut être activé — le service est inutilisable |
| Code à six chiffres | À la connexion, **sur les comptes ayant armé la double authentification** | Ces comptes-là ne peuvent plus se connecter |

La double authentification est un **réglage par compte**, désactivé par défaut,
que chacun active depuis sa page « Compte ». Le lien de confirmation, lui, n'est
pas optionnel : **la clé Brevo reste indispensable en production.**

| Variable | Obligatoire | Défaut | Rôle |
|---|---|---|---|
| `BREVO_API_KEY` | **oui en production** | — | Clé d'API Brevo, préfixe `xkeysib-` |
| `MAIL_FROM_ADDRESS` | oui | `martin.simn91@gmail.com` | Adresse d'expédition, **validée dans Brevo** |
| `MAIL_FROM_NAME` | non | `filemoica` | Nom affiché de l'expéditeur |
| `APP_PUBLIC_URL` | oui | `http://localhost:3001` | Base des liens envoyés par courriel |

### ⚠️ Le service refuse de démarrer sans la clé

En production, l'absence de `BREVO_API_KEY` fait **échouer le démarrage**, avec
un message explicite. Ce n'est pas une négligence de configuration qu'on
rattrape plus tard : sans clé, le service se replie sur l'écriture des messages
**dans les journaux** — et un code d'authentification écrit dans les journaux
n'est plus un secret. Il serait lisible par quiconque accède à la supervision.

Ce repli n'existe que hors production, pour permettre de développer sans compte
Brevo.

### La clé vous est transmise séparément

**Elle n'est pas dans le dépôt et ne doit jamais y entrer.** Demandez-la à
l'équipe IW, et transmettez-la comme les autres secrets — pas par messagerie
d'équipe ni par courriel.

Une clé Brevo permet d'envoyer des courriels **en votre nom** : elle se traite
comme un mot de passe. Si elle fuit, révoquez-la depuis Brevo
(*SMTP & API → API Keys*) et générez-en une neuve ; rien d'autre n'est à
changer côté service.

### L'expéditeur doit être validé dans Brevo

C'est le refus le plus courant, et il ne se voit qu'à la première tentative
d'envoi. Dans Brevo : *Senders & IP → Senders*, ajouter l'adresse, puis
**cliquer le lien de confirmation reçu**.

Sans cette validation, Brevo répond `400` avec `Sender not valid` — le service
journalise l'erreur, et **l'inscription réussit quand même** : le compte est
créé, mais son propriétaire n'a pas reçu le lien. Il peut en redemander un.

### Vérifier que l'envoi fonctionne

Inscrivez un compte de test avec une adresse que vous relevez, et regardez les
journaux :

```
[MailService] Courriel envoyé à ma***@example.fr
```

Si vous lisez à la place `BREVO_API_KEY absente — le courriel n'est PAS envoyé`,
c'est que le service tourne hors production sans clé.

---

## 3. Base de données

| Variable | Obligatoire | Défaut | Rôle |
|---|---|---|---|
| `DATABASE_URL` | **oui** | — | Chaîne de connexion complète |
| `POSTGRES_USER` | non | `filemoica` | Compte PostgreSQL (niveau compose) |
| `POSTGRES_PASSWORD` | **oui** | — | Mot de passe (niveau compose) |
| `POSTGRES_DB` | non | `filemoica` | Nom de la base (niveau compose) |

Format attendu pour `DATABASE_URL` :

```
postgresql://utilisateur:motdepasse@hote:5432/base
```

> Avec le `docker-compose.deploy.yml` livré, **vous n'avez pas à écrire
> `DATABASE_URL` vous-même** : elle est composée à partir des trois variables
> `POSTGRES_*`.

Les migrations sont appliquées par un conteneur séparé, qui doit réussir avant
que l'application démarre. Voir [coordination-src.md](coordination-src.md).

---

## 4. Exposition et réseau

| Variable | Obligatoire | Défaut | Rôle |
|---|---|---|---|
| `FRONTEND_ORIGIN` | **oui** | — | Origine exacte du front |
| `PORT` | non | `3000` | Port d'écoute **dans** le conteneur |
| `APP_PORT` | non | `3000` | Port publié sur l'hôte (niveau compose) |
| `COOKIE_DOMAIN` | non | absent | Domaine des cookies de session |
| `TRUST_PROXY_HOPS` | non | `0` | Nombre de relais devant le service |

### `FRONTEND_ORIGIN` — une seule origine, jamais de joker

Elle sert **à la fois** au CORS et à la défense CSRF. C'est une liste blanche
d'une seule entrée : l'URL exacte, protocole compris, sans barre oblique finale.

`https://filemoica.example.fr` — et non `*`, ni `example.fr`, ni
`https://filemoica.example.fr/`.

### `TRUST_PROXY_HOPS` — à ne pas oublier

Nombre de relais à traverser pour retrouver l'adresse réelle du client.
Derrière un reverse proxy, c'est `1`.

**Sans ce réglage, toutes les requêtes semblent venir de l'adresse du proxy.**
La limitation de tentatives compterait alors tout le monde ensemble et
bloquerait l'ensemble des visiteurs dès qu'un seul s'agite.

Il reste à `0` en développement, et ce n'est pas un oubli : faire confiance à un
en-tête `X-Forwarded-For` que personne ne réécrit permettrait à n'importe qui de
se faire passer pour n'importe quelle adresse. Ne mettez que le nombre réel de
relais que **vous** contrôlez.

### HTTPS est un prérequis, pas une préférence

En production, les cookies de session portent le drapeau `Secure`. **En HTTP, la
connexion ne fonctionne tout simplement pas** — le navigateur refuse de renvoyer
le cookie, et l'utilisateur semble déconnecté à chaque requête.

L'application parle HTTP en interne ; c'est votre reverse proxy qui termine le
TLS.

---

## 5. Stockage

| Variable | Obligatoire | Défaut | Rôle |
|---|---|---|---|
| `STORAGE_PATH` | **oui** | — | Répertoire des fichiers chiffrés |

> Dans l'image Docker, `STORAGE_PATH` vaut déjà
> **`/var/lib/filemoica/storage`** : vous n'avez pas à la fournir, seulement à
> monter un volume sur ce chemin.

### ⚠️ Le volume doit appartenir à l'uid 1000

Le conteneur tourne sans privilèges, sous l'utilisateur `node` (uid 1000). Il ne
peut pas s'approprier un volume qui appartient à `root`.

- **Volume Docker nommé** — rien à faire, Docker recopie les permissions du
  répertoire de l'image.
- **Répertoire de l'hôte** (bind mount) — `chown -R 1000:1000` une fois.

Symptôme d'un volume mal monté : le service démarre, `/health` répond `200`,
et le **premier dépôt de fichier échoue**. C'est pour cela que le script de
vérification dépose réellement un fichier.

### Ce que contient ce volume

Les fichiers des utilisateurs, chiffrés en AES-256-GCM. **À sauvegarder avec le
dump de la base** : les clés de déchiffrement sont en base, le contenu est ici.
Restaurer l'un sans l'autre ne donne rien d'exploitable.

---

## 6. Offre et quotas

Ajustables **sans redéployer le code** — c'est le but. Les valeurs par défaut
conviennent à la mise en ligne.

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_FILE_SIZE_MB` | `200` | Taille maximale d'un fichier (max 2048) |
| `FREE_PLAN_QUOTA_MB` | `200` | Dépôt mensuel inclus dans l'offre gratuite |
| `PREMIUM_PLAN_QUOTA_MB` | `20480` | Dépôt mensuel de l'offre payante |
| `FREE_PLAN_RETENTION_DAYS` | `30` | Conservation en offre gratuite |
| `PREMIUM_PLAN_RETENTION_DAYS` | `90` | Conservation en offre payante |

### Dimensionner le volume

Le quota compte les **dépôts**, la rétention borne le **stockage**. L'occupation
plafonne donc au lieu de croître indéfiniment :

> 200 Mo/mois × 30 jours ≈ **200 Mo par compte gratuit actif**
> 20 Go/mois × 90 jours ≈ **jusqu'à 60 Go par compte payant**

Si le volume alloué est plus petit que prévu, **baissez les durées de
rétention** : c'est le levier le plus direct, et il ne demande qu'un
redémarrage.

---

## 7. Variables à laisser tranquilles

Elles ont une valeur par défaut choisie pour de bonnes raisons. Les changer sans
raison dégrade la sécurité.

| Variable | Défaut | Pourquoi ne pas y toucher |
|---|---|---|
| `NODE_ENV` | `development` | **À mettre à `production`** — active les cookies `Secure` et les journaux JSON |
| `JWT_ACCESS_TTL` | `15m` | Durée de vie courte : un cookie volé n'est exploitable que sur cette fenêtre |
| `REFRESH_TOKEN_TTL_DAYS` | `7` | Max 90. Plus long = fenêtre de vol plus large |
| `RATE_LIMIT_ENABLED` | `true` | Protège les mots de passe contre les tentatives répétées |
| `ENABLE_API_DOCS` | `true` | Peut être mis à `false` en production pour réduire ce qu'un attaquant apprend de l'API |
| `APP_VERSION` | `dev` | **À renseigner** avec le tag git — c'est ce que `/health` affiche |

> `NODE_ENV=production` et `APP_VERSION` sont les deux seules de ce tableau que
> vous devez vraiment poser.

**Pour les booléens** (`RATE_LIMIT_ENABLED`, `ENABLE_API_DOCS`), sont considérés
comme faux : `false`, `0`, `no`, `non`, et la chaîne vide. Toute autre valeur
est vraie.

---

## 8. Rotation de clé — `ENCRYPTION_KEY_V2`

Variable **optionnelle**, absente en temps normal. Elle ne sert que pendant une
rotation de la clé maître.

Le service utilise le **chiffrement enveloppe** : chaque fichier a sa propre clé,
et seule cette petite clé est chiffrée par la clé maître. Changer la clé maître
ne demande donc pas de relire un seul octet de fichier — on rechiffre uniquement
les petites clés.

```bash
# 1. Ajouter ENCRYPTION_KEY_V2 à la configuration, redémarrer
# 2. Simuler
docker compose -p filemoica exec -T app node dist/rotate-keys.js --dry-run
# 3. Appliquer
docker compose -p filemoica exec -T app node dist/rotate-keys.js
# 4. Une fois terminé : V2 devient V1, et V2 disparaît
```

Mesuré à **101 ms** sur le jeu de données de développement, sans interruption de
service. **Gardez l'ancienne clé** jusqu'à ce que la rotation soit confirmée
terminée : tant qu'un fichier est encore en `v1`, la perdre le rend illisible.

---

## 9. Tâches planifiées

```cron
0 3 * * * docker compose -f /srv/filemoica/docker-compose.deploy.yml -p filemoica exec -T app node dist/purge-files.js
0 4 * * * docker compose -f /srv/filemoica/docker-compose.deploy.yml -p filemoica exec -T app node dist/purge-tokens.js
```

| Tâche | Ce qu'elle efface | Si elle ne tourne pas |
|---|---|---|
| `purge-tokens` | Des jetons déjà expirés | Sans conséquence |
| `purge-files` | **Des fichiers utilisateurs** | **Le disque se remplit jusqu'à saturation** |

Avant la première exécution réelle de `purge-files`, lancez-la en simulation —
même décompte, aucune suppression :

```bash
docker compose -p filemoica exec -T app node dist/purge-files.js --dry-run
```

---

## 10. Vérifier que le déploiement fonctionne

`/health` ne prouve que la capacité du service à répondre à sa propre sonde. Le
script de vérification, lui, joue un **parcours complet** — compte, dépôt, lien,
téléchargement sans compte — et compare les octets reçus à ceux déposés :

```bash
node backend/scripts/verifier-deploiement.mjs https://filemoica.example.fr
```

Il nettoie derrière lui et sort en **code 0 ou 1** : utilisable tel quel dans un
déploiement automatisé.

### La sonde

```bash
curl https://filemoica.example.fr/health
# {"status":"ok","version":"v1.0.0","checks":{"database":"up"},"checkedAt":"..."}
```

- **`200`** — sain
- **`503`** — base injoignable

Le statut HTTP porte l'information, pas seulement le corps : votre orchestrateur
peut retirer l'instance sans analyser la réponse. L'URL est volontairement **hors
du préfixe `/api`** et sans authentification.

---

## Aide-mémoire — dans l'ordre

- [ ] Générer les trois clés, **différentes entre elles**
- [ ] Les ranger **ailleurs que les sauvegardes**
- [ ] **Récupérer `BREVO_API_KEY` auprès de l'équipe IW**, hors messagerie
- [ ] **Vérifier que `MAIL_FROM_ADDRESS` est validée dans Brevo**
- [ ] `APP_PUBLIC_URL` = l'URL publique du front (elle part dans les courriels)
- [ ] Remplir `.env.deploy` à partir du modèle
- [ ] `NODE_ENV=production`
- [ ] `APP_VERSION` = le tag git déployé
- [ ] `FRONTEND_ORIGIN` = l'URL exacte du front
- [ ] `TRUST_PROXY_HOPS` = nombre réel de relais
- [ ] Volume monté sur `/var/lib/filemoica/storage`, **propriétaire uid 1000**
- [ ] HTTPS en place sur le reverse proxy
- [ ] Migrations appliquées — dont **`verification_adresse_email`** et **`double_authentification`**
- [ ] Les deux tâches `cron` posées
- [ ] Sauvegardes planifiées — **base ET volume**
- [ ] `node scripts/verifier-deploiement.mjs <url>` → 0 échec
- [ ] **Un compte de test inscrit, courriel reçu, connexion complète jusqu'au code**

---

## Récapitulatif de toutes les variables

| Variable | Obligatoire | Défaut | Contrainte |
|---|---|---|---|
| `DATABASE_URL` | **oui** | — | `postgresql://…` |
| `JWT_SECRET` | **oui** | — | ≥ 32 caractères |
| `ENCRYPTION_KEY_V1` | **oui** | — | 64 caractères hexadécimaux |
| `HMAC_INDEX_KEY` | **oui** | — | 64 caractères hexadécimaux |
| `FRONTEND_ORIGIN` | **oui** | — | URL `http`/`https` |
| `STORAGE_PATH` | **oui** | *posé par l'image* | chemin non vide |
| `NODE_ENV` | non | `development` | `development`/`test`/`production` |
| `PORT` | non | `3000` | 1 – 65535 |
| `APP_VERSION` | non | `dev` | texte libre |
| `JWT_ACCESS_TTL` | non | `15m` | `15m`, `1h`, `7d`… |
| `REFRESH_TOKEN_TTL_DAYS` | non | `7` | 1 – 90 |
| `MAX_FILE_SIZE_MB` | non | `200` | 1 – 2048 |
| `FREE_PLAN_QUOTA_MB` | non | `200` | ≥ 1 |
| `PREMIUM_PLAN_QUOTA_MB` | non | `20480` | ≥ 1 |
| `FREE_PLAN_RETENTION_DAYS` | non | `30` | ≥ 1 |
| `PREMIUM_PLAN_RETENTION_DAYS` | non | `90` | ≥ 1 |
| `TRUST_PROXY_HOPS` | non | `0` | 0 – 5 |
| `RATE_LIMIT_ENABLED` | non | `true` | booléen |
| `ENABLE_API_DOCS` | non | `true` | booléen |
| `COOKIE_DOMAIN` | non | absent | texte |
| **`BREVO_API_KEY`** | **oui en production** | — | clé Brevo, préfixe `xkeysib-` |
| `MAIL_FROM_ADDRESS` | oui | `martin.simn91@gmail.com` | adresse **validée dans Brevo** |
| `MAIL_FROM_NAME` | non | `filemoica` | texte |
| `APP_PUBLIC_URL` | oui | `http://localhost:3001` | URL `http`/`https` |
| `ENCRYPTION_KEY_V2` | non | absent | 64 caractères hexadécimaux, **rotation seulement** |
| `POSTGRES_USER` | non | `filemoica` | *niveau compose* |
| `POSTGRES_PASSWORD` | **oui** | — | *niveau compose* |
| `POSTGRES_DB` | non | `filemoica` | *niveau compose* |
| `APP_PORT` | non | `3000` | *niveau compose* |
