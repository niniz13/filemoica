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

## Sommaire

- [Lancer le projet](#lancer-le-projet)
  - [Documentation de l'API (Swagger)](#documentation-de-lapi-swagger)
  - [Lancer les tests](#lancer-les-tests)
- [État d'avancement](#état-davancement)
- [Choix techniques](#choix-techniques)
- [Sécurité : ce qui est en place](#sécurité--ce-qui-est-en-place)
- [Authentification](#authentification)
- [Fichiers](#fichiers)
- [Partages et téléchargement](#partages-et-téléchargement)
- [Modèle de données](#modèle-de-données)
- [Supervision et incident](#supervision-et-incident)
- [Contrats avec le reste de l'équipe](#contrats-avec-le-reste-de-léquipe)
- [Contraintes d'environnement rencontrées](#contraintes-denvironnement-rencontrées)
- [Tests](#tests)
- [Points ouverts](#points-ouverts)

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

**229 tests au vert** (100 unitaires, 129 end-to-end), analyse statique et
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

La version de clé voyage avec chaque donnée : ajouter `ENCRYPTION_KEY_V2` à la
configuration suffit à chiffrer les nouvelles données en v2 tout en continuant à
lire celles en v1, **sans changement de code**.

### Faire tourner les clés

```bash
# 1. Générer la nouvelle clé
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 2. L'ajouter en ENCRYPTION_KEY_V2, SANS retirer ENCRYPTION_KEY_V1

# 3. Simuler
npm run keys:rotate -- --dry-run

# 4. Exécuter
npm run keys:rotate

# 5. Rapport à zéro reste → retirer ENCRYPTION_KEY_V1
```

**Mesuré sur la base de développement : 4 fichiers et 1 partage re-scellés en
101 ms, et les fichiers sur le disque rigoureusement inchangés** (empreinte
SHA-256 identique avant et après).

C'est tout l'intérêt du chiffrement enveloppe : la rotation réécrit la clé de
chaque fichier — quelques dizaines d'octets — et jamais les fichiers eux-mêmes.
Sur un volume réel, c'est la différence entre quelques secondes et plusieurs
heures d'indisponibilité.

Trois propriétés rendent l'opération sûre :

- **Idempotente** — une donnée déjà sur la clé cible est ignorée ; relancer ne
  fait rien de plus.
- **Reprenable** — chaque enregistrement est écrit indépendamment. Une
  interruption laisse un mélange d'anciennes et de nouvelles versions, que la
  prochaine exécution achève et que le service sait lire entre-temps.
- **Sans interruption de service** — l'application peut continuer de tourner
  pendant la bascule.

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

## Authentification

### Routes

| Méthode | Route | Accès | Rôle |
|---|---|---|---|
| `POST` | `/api/auth/register` | public | Crée un compte |
| `POST` | `/api/auth/login` | public | Ouvre une session, pose les cookies |
| `POST` | `/api/auth/refresh` | cookie de rafraîchissement | Renouvelle la session |
| `POST` | `/api/auth/logout` | public | Ferme la session et révoque les jetons |
| `GET` | `/api/auth/me` | **session requise** | Compte courant |

**Aucun jeton n'apparaît dans les corps de réponse.** Ils partent uniquement
dans des cookies `httpOnly` : le front n'a rien à stocker, et le JavaScript de
la page ne peut pas lire la session.

### Deux jetons, deux rôles

- **Access token** — un JWT de 15 minutes, présenté à chaque requête. Autoportant,
  donc validé sans consulter la base.
- **Refresh token** — une valeur **opaque** de 32 octets, valable 7 jours, dont le
  seul rôle est d'obtenir un nouvel access token.

Pourquoi le second n'est-il pas un JWT ? Parce qu'un JWT ne peut pas être
révoqué : il reste valide jusqu'à expiration. Le refresh token, lui, est une
ligne en base — le révoquer est immédiat. La durée courte de l'access token borne
la fenêtre pendant laquelle un vol reste exploitable.

Son cookie est restreint au chemin `/api/auth` : le navigateur ne l'envoie jamais
sur les routes de fichiers ou de partage. Un jeton qui ne circule pas est un
jeton qu'on ne peut pas intercepter au passage.

### Détection de vol de session

Chaque utilisation d'un refresh token le consomme et en émet un nouveau. Tous les
jetons issus d'une même connexion partagent une lignée (`family_id`).

Si un jeton **déjà consommé** est présenté, il n'y a que deux explications : il a
été volé et l'attaquant le rejoue, ou il a été volé et c'est la victime qui le
rejoue. Dans les deux cas, quelqu'un d'autre en détient une copie — la **lignée
entière** est donc révoquée.

La victime est déconnectée elle aussi. C'est un choix assumé : mieux vaut une
reconnexion contrariante qu'un attaquant qui garde un accès silencieux.

### Révocation immédiate à la déconnexion

Se déconnecter fait deux choses : révoquer le refresh token et sa lignée en base,
et inscrire l'identifiant (`jti`) de l'access token sur une liste de refus,
consultée à chaque requête.

Sans cette seconde action, un jeton volé resterait valable **jusqu'à 15 minutes
après** la déconnexion. La liste ne contient jamais que quelques minutes de
déconnexions, et une purge suffit à la vider.

### Mots de passe

argon2id, avec les paramètres recommandés par l'OWASP (19 Mio de mémoire,
2 passes). Le coût mémoire est le paramètre décisif : il neutralise l'avantage
des cartes graphiques, là où un attaquant testerait des millions de mots de passe
par seconde contre du SHA-256.

**Un seul critère à l'inscription : 12 caractères minimum.** Les règles de
composition (« une majuscule, un chiffre, un caractère spécial ») poussent en
pratique vers des mots de passe courts et prévisibles du type `Password1!`,
quand une phrase longue résiste bien mieux. C'est la recommandation actuelle de
l'ANSSI et du NIST.

### Contre l'énumération des comptes

Deux précautions rendent impossible de découvrir quels emails ont un compte :

- le message d'erreur est **identique** pour un email inconnu et pour un mot de
  passe faux ;
- une vérification **factice** est exécutée quand l'email n'existe pas. Sans
  elle, la réponse serait immédiate dans ce cas et prendrait plusieurs dizaines
  de millisecondes dans l'autre : ce seul écart de temps suffirait à énumérer les
  comptes, sans jamais connaître un mot de passe.

L'inscription, elle, révèle qu'un email est déjà pris. C'est un compromis
assumé : l'alternative — accepter silencieusement — rendrait l'inscription
incompréhensible pour quelqu'un qui a simplement oublié qu'il avait un compte.

### Routes fermées par défaut

Le garde de session est **global**. Une route est protégée tant qu'elle n'est pas
explicitement ouverte par `@Public()`.

C'est l'inverse de la configuration habituelle, et c'est voulu : un oubli produit
une route **inaccessible**, qu'on remarque au premier essai, plutôt qu'une route
ouverte à tous, qu'on ne remarque jamais.

---

## Fichiers

| Méthode | Route | Rôle |
|---|---|---|
| `POST` | `/api/files` | Dépose un fichier (`multipart/form-data`, champ `file`) |
| `GET` | `/api/files` | Liste ses propres fichiers |
| `GET` | `/api/files/quota` | Volume déposé ce mois-ci et solde restant |
| `DELETE` | `/api/files/:id` | Supprime un fichier et son contenu |

### Le chiffrement a lieu pendant la réception

Les deux modes de réception fournis par la bibliothèque standard étaient
inutilisables ici :

- écrire d'abord sur le disque puis chiffrer laisserait le contenu **en clair**,
  ne serait-ce qu'un instant — et définitivement si le service s'arrêtait
  entre-temps ;
- tout garder en mémoire ferait tomber le service au bout de quelques dépôts
  simultanés.

Un [moteur de réception sur mesure](src/files/encrypted-upload.storage.ts)
branche donc le chiffrement directement sur le flux entrant. Les octets passent
de la requête au fichier chiffré **sans jamais s'arrêter en clair**, ni sur le
disque ni en mémoire.

C'est ce qui permet d'affirmer, sans nuance : à aucun moment le serveur ne
détient une version lisible d'un fichier déposé.

### Cloisonnement entre utilisateurs

Le filtre sur le propriétaire est appliqué **par la requête en base**, pas après
coup : un fichier d'autrui ne remonte jamais, même le temps d'un traitement.

La suppression d'un fichier appartenant à quelqu'un d'autre renvoie **404, pas
403**. Un 403 confirmerait l'existence du fichier : en essayant des
identifiants, on pourrait dénombrer les fichiers du service. Le 404 ne distingue
pas « n'existe pas » de « n'est pas à vous ».

### Contrôle du format par les octets, pas par l'extension

L'extension et le type annoncé viennent tous deux du client : renommer
`virus.exe` en `rapport.pdf` suffirait à tromper une vérification qui s'y
fierait. Le [contrôle](src/files/mime-sniffer.stream.ts) lit donc les **octets de
signature** du fichier.

Il est placé **dans le flux, avant le chiffrement** : un format refusé n'est
jamais écrit sur le disque. Seuls quatre kilo-octets sont retenus en mémoire, y
compris pour un fichier de 200 Mo.

Les [formats acceptés](src/files/allowed-types.ts) couvrent documents, images,
vidéo, audio et archives. En ajouter un tient en une ligne.

**Cas particulier du texte.** Un `.txt` ou un `.csv` n'a aucune signature —
rien ne le distingue d'un fragment quelconque. Ces formats sont donc acceptés
sur la foi du type déclaré, doublée d'une vérification sommaire du contenu
(absence d'octet nul). Sans cette porte, aucun fichier texte ne passerait ; sans
la vérification, il suffirait de déclarer `text/plain` pour contourner la liste.

**Ce que ce contrôle ne fait pas**, et qu'il ne faut pas prétendre : il ne
détecte ni un document porteur de macros, ni un PDF piégé, ni une archive
malveillante — tous figurent dans les formats acceptés. Seule une analyse
antivirale les repérerait, et elle est impossible sur un contenu chiffré dès sa
réception.

La liste sert donc surtout à **définir le périmètre du service**. La protection
réelle est ailleurs : le serveur n'exécute ni n'affiche jamais un fichier
déposé, et le téléchargement force l'enregistrement plutôt que l'ouverture dans
le navigateur.

### Limites appliquées

| Limite | Valeur | Raison |
|---|---|---|
| Taille d'un fichier | `MAX_FILE_SIZE_MB`, **200 par défaut** | Sans borne, un seul dépôt peut remplir le disque |
| Fichiers par requête | 1 | Réduire ce qu'on accepte réduit ce qu'il faut valider |
| Champs supplémentaires | 0 | Idem |

Un dépôt interrompu, trop volumineux ou d'un format refusé voit son contenu
partiel **retiré du support** : sans cela, chaque échec laisserait un fichier
orphelin que personne ne nettoierait.

### Quota mensuel et offres

Deux offres, portées par le champ `plan` du compte :

| Offre | Volume mensuel | Variable |
|---|---|---|
| Gratuite | 200 Mo | `FREE_PLAN_QUOTA_MB` |
| Payante | 20 Go | `PREMIUM_PLAN_QUOTA_MB` |

Les valeurs sont dans la configuration : ajuster l'offre après un retour
d'utilisateur ne demande pas de modifier le code.

**Aucun module de paiement.** Le passage en offre payante se fait en écrivant
`PREMIUM` dans la base. Ce qui est démontré, c'est la **mécanique du quota** —
brancher un prestataire reviendrait à écrire cette même valeur après une
transaction réussie.

**Le quota mesure ce qui a été déposé, pas l'espace occupé.** Supprimer un
fichier ne rend donc pas de quota : sinon, envoyer puis effacer en boucle
suffirait à contourner l'offre gratuite. Un test le vérifie.

Le compteur vit dans une table `monthly_usage`, une ligne par compte et par
mois. Aucune remise à zéro n'est à programmer : le mois suivant crée simplement
une nouvelle ligne.

Un dépassement répond **402 Paiement requis**, et non 413. Le code dit ce dont
il s'agit : la requête est légitime, c'est l'offre qui est atteinte. Le front
peut y accrocher sa proposition de passage à l'offre supérieure, là où un 413 ne
parlerait que de taille.

> **Où le refus a lieu, et pourquoi.** Le contrôle s'applique **pendant** la
> réception, à l'octet de trop, et non avant l'envoi. Refuser plus tôt sur la
> foi de la taille annoncée a été essayé puis abandonné : répondre avant que le
> client ait fini d'envoyer coupe la connexion, et il reçoit une erreur réseau
> au lieu du message expliquant que son quota est atteint. C'est le même
> compromis que celui de la taille maximale.

---

## Partages et téléchargement

| Méthode | Route | Accès | Rôle |
|---|---|---|---|
| `POST` | `/api/shares` | **session** | Crée un lien |
| `GET` | `/api/shares` | **session** | Liste ses partages avec leur état |
| `PATCH` | `/api/shares/:id/revoke` | **session** | Coupe l'accès immédiatement |
| `GET` | `/api/download/:token/info` | *public* | Décrit le lien sans le consommer |
| `GET` | `/api/download/:token` | *public* | Télécharge le fichier |

### Déposer exige un compte, recevoir non

Le destinataire **n'a pas de compte et n'en a pas besoin**. Il clique sur le
lien qu'on lui a transmis et récupère le fichier. Lui imposer une inscription
reviendrait à exiger une démarche de sa part pour rendre service à quelqu'un
d'autre.

La conséquence est nette : **le jeton est le secret**. Trois choses le rendent
acceptable, dont deux sont à la main du déposant :

| Protection | Qui la décide |
|---|---|
| 32 octets aléatoires, hors de portée d'une attaque par essais | le service |
| Une durée de vie, de 1 heure à 30 jours | le déposant |
| Un mot de passe facultatif | le déposant |
| Un usage unique, avec effacement du fichier | le déposant |
| La révocation, immédiate et à tout moment | le déposant |

### Le lien à usage unique

Option `burnAfterDownload` à la création. Le lien se consume au **premier
téléchargement réussi**, et le fichier est alors **effacé du serveur** — base et
disque — s'il ne lui reste aucun autre lien exploitable.

C'est la garantie la plus forte que le service puisse offrir : *la donnée ne
survit pas à sa transmission*. Vérifié de bout en bout : après le
téléchargement, le fichier a disparu du disque, la liste du déposant est vide,
et le lien répond `404`.

**Par défaut un lien reste réutilisable** jusqu'à son expiration ou sa
révocation : le destinataire peut avoir raté son téléchargement, ou le même lien
servir à plusieurs personnes. L'usage unique est donc une option, jamais le
comportement implicite.

Quatre points de conception qui font la différence entre une version correcte et
une version naïve :

**Le lien est réservé avant l'envoi, pas après.** Deux personnes qui ouvrent le
lien en même temps ne doivent pas repartir toutes les deux avec le fichier. La
réservation est une mise à jour conditionnée à la nullité de la date de
consommation : la base ne laisse passer qu'un seul gagnant. Un test lance deux
téléchargements simultanés et vérifie qu'il y a exactement un `200` et un `410`.

**Un transfert interrompu rend le lien.** Coupure réseau, onglet fermé : le
destinataire n'a rien reçu, détruire le fichier serait le pire des deux mondes.
Le lien n'est définitivement consommé qu'une fois le contenu **entièrement**
transmis.

**Le fichier n'est effacé que s'il n'a plus aucun lien exploitable.** Le déposant
a pu créer plusieurs partages du même fichier ; brûler l'un d'eux ne doit pas
casser silencieusement les autres.

**Le second essai répond `404`, pas `410`.** Le fichier effacé, la ligne du
partage disparaît avec lui : il ne reste littéralement rien. C'est cohérent avec
la promesse, et préférable — on ne peut pas distinguer « déjà utilisé » de « n'a
jamais existé ». Le `410 SHARE_ALREADY_USED` ne subsiste que quand le fichier
survit grâce à un autre lien.

> **À dire à l'utilisateur avant qu'il coche la case :** l'effacement est
> irréversible et touche **aussi le déposant**. Le fichier disparaît de sa
> propre liste — c'est précisément ce qui est demandé, mais cela doit être
> annoncé.

### Le mot de passe de lien

Quand il est défini, le lien seul ne suffit plus. C'est ce qui protège un lien
intercepté, transféré à la mauvaise personne ou publié par erreur.

Il est haché en argon2id, comme un mot de passe de compte, et transmis par le
destinataire dans l'en-tête **`X-Share-Password`** — jamais dans l'URL, où il
finirait dans l'historique du navigateur et dans les journaux des serveurs
traversés.

Tant qu'il n'est pas franchi, `/info` ne révèle **ni le nom ni la taille** du
fichier : quelqu'un qui intercepterait le lien apprendrait sinon ce qu'il
contient sans jamais avoir à le déverrouiller.

### Le jeton n'existe qu'une fois

Il est renvoyé à la création, puis oublié : la base n'en conserve que
l'empreinte SHA-256. Une fuite de la base ne livre donc **aucun lien
utilisable**. Un jeton perdu n'est pas récupérable, il faut créer un nouveau
partage.

L'email du destinataire est facultatif et **purement informatif** : il sert à
savoir à qui un partage était destiné, et servira à la notification. Il ne
conditionne pas l'accès. Il est tout de même chiffré en base.

### Les contrôles et leurs réponses

| Contrôle | Réponse | Code |
|---|---|---|
| Le jeton correspond à un partage | `404` | `SHARE_NOT_FOUND` |
| Le partage n'est pas révoqué | `403` | `SHARE_REVOKED` |
| Le partage n'a pas expiré | `410` | `SHARE_EXPIRED` |
| Le lien à usage unique n'a pas déjà servi | `410` | `SHARE_ALREADY_USED` |
| Le mot de passe est fourni, s'il en faut un | `401` | `SHARE_PASSWORD_REQUIRED` |
| Le mot de passe est le bon | `403` | `SHARE_PASSWORD_INVALID` |

La révocation est vérifiée **avant** l'expiration : c'est un geste délibéré du
propriétaire, il doit primer sur une date atteinte entre-temps.

Le `410` distingue « a expiré » de « n'a jamais existé », ce qui permet au front
de proposer de demander un nouveau lien plutôt qu'un message d'erreur sec.

Les mêmes refus s'appliquent à `/info` : un lien révoqué est refusé partout de
la même façon.

### Le durcissement du téléchargement

C'est **la** protection réelle contre un fichier malveillant, bien plus que la
liste des formats acceptés :

| En-tête | Effet |
|---|---|
| `Content-Disposition: attachment` | Force l'enregistrement, jamais l'affichage |
| `Content-Type: application/octet-stream` | Prive le navigateur de raison d'interpréter |
| `X-Content-Type-Options: nosniff` | L'empêche de deviner le type malgré tout |

Sans ces en-têtes, un document HTML ou une image vectorielle téléchargés depuis
notre domaine s'exécuteraient **dans notre origine** — ce qui contournerait
précisément la défense CSRF assurée par `SameSite=Strict`.

Deux en-têtes s'ajoutent pour protéger le lien lui-même, puisqu'il est le seul
secret : `Referrer-Policy: no-referrer` l'empêche de partir vers un site tiers,
et `Cache-Control: no-store` évite qu'un relais conserve le fichier déchiffré.

Le nom d'origine est préservé sous deux formes, dont une encodée pour les
accents ; les guillemets en sont retirés, faute de quoi un nom de fichier
pourrait injecter des directives dans l'en-tête.

### Déchiffrement à la volée

Le contenu est déchiffré en flux vers le destinataire : il n'existe en clair **à
aucun moment** sur le disque du serveur.

> **Une conséquence à connaître.** L'intégrité GCM ne se vérifie qu'à la fin du
> flux, donc après l'envoi des en-têtes : un fichier altéré sur le disque ne
> peut plus donner lieu à un code d'erreur propre. La connexion est alors
> coupée, ce qui donne au destinataire un téléchargement manifestement
> interrompu plutôt qu'un fichier corrompu qu'il croirait valide. C'est le prix
> du flux ; l'alternative serait de lire le fichier entier avant d'en envoyer le
> premier octet.

---

## Modèle de données

Cinq tables, identifiants UUID, migration `20260915145703_init`.
Le schéma commenté est dans [`prisma/schema.prisma`](prisma/schema.prisma).

| Table | Rôle | Colonnes notables |
|---|---|---|
| `users` | Comptes | `password_hash` |
| `files` | Métadonnées des fichiers | `original_name_enc`, `dek_wrapped`, `key_version`, `content_iv`, `content_auth_tag`, `storage_name` |
| `shares` | Liens de partage | `token_hash`, `recipient_email_enc`, `recipient_email_hmac`, `expires_at`, `revoked` |
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
| Purge | Les jetons expirés sont à purger périodiquement (script à venir) |
| `ENABLE_API_DOCS` | Expose `/api/docs`. À `true` par défaut ; peut être coupé en production pour réduire ce qu'un attaquant apprend de la surface de l'API |

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
| Un lien à usage unique efface le fichier du serveur | `shares.e2e-spec.ts` |
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
| Journalisation | Logs structurés pour la centralisation |
| Purge | Commande de nettoyage des jetons expirés, pour le cron de SRC |
| Limitation de débit | Ralentir les tentatives répétées sur la connexion |
