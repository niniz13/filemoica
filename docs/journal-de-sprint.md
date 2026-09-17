# Journal de sprint — filemoica

**Tech Venture Sprint · 15 → 18 septembre 2026**
Service de transfert de fichiers chiffrés, à liens temporaires.

| | |
|---|---|
| **IW — application, API, données, tests, sécurité applicative** | Martin Simon · Jérémy Gross |
| **SRC — hébergement, réseau, déploiement, exploitation** | Enzo ANSELMO · Julien DOURLET · Killian DURANTI MACIA |

> Ce journal décrit ce qui a été **réellement fait et vérifié** pendant la
> semaine. Les mesures indiquées sont datées et reproductibles ; celles qui sont
> estimées le sont dites.

---

## 📝 À lire avant de compléter — pour toute l'équipe

Ce document est **un livrable commun**. Chacun remplit **sa propre section** au
§4 : personne ne doit écrire la contribution d'un autre.

**Cherchez `À COMPLÉTER` dans le fichier** — chaque occurrence est une case à
remplir. Il ne doit plus en rester une seule au moment du rendu.

**Deux choses sont attendues de chacun**, et elles valent **4 points
individuels** :

1. **Ce que vous avez fait**, de façon vérifiable — le sujet précise que *« le
   nombre de modifications du code ne suffit pas à établir une contribution »*.
   Dites plutôt ce que vous avez décidé, mesuré ou corrigé.
2. **Une conséquence de vos choix sur l'autre spécialité.** C'est la question
   que le jury posera, et il peut changer le contexte pour voir si vous suivez.

**Ce qu'il vaut mieux ne pas modifier sans en parler :** les décisions du §3 et
les chiffres du §8 sont vérifiables dans le dépôt. Si l'un vous paraît faux,
signalez-le plutôt que de le réécrire — il est sans doute exact, ou alors c'est
le code qu'il faut corriger.

**Relisez la description qu'on a faite de vous.** Elle a été écrite depuis
l'historique git et le code. Corrigez-la si elle est inexacte : vous devrez
pouvoir l'expliquer vendredi.

---

## 1. État initial

Le sprint part d'un dépôt **quasiment vide**, créé le 15/09.

| Élément | État au démarrage |
|---|---|
| Premier commit | `9eccdd6` — 15/09, Jérémy Gross |
| Frontend | Squelette Next.js, aucune page fonctionnelle |
| Backend | **Inexistant** |
| Base de données | Aucune |
| Tests | Aucun |
| Déploiement | Aucun |

Le cadrage initial prévoyait **Express**. Il a été revu dès le premier jour
(voir décision 1).

**Version de référence du rendu :** tag `v1.0.0`

---

## 2. Périmètre retenu

**Le public :** une personne ou une petite structure qui doit transmettre un
document sensible — un contrat, un bulletin de paie, un certificat — à un
destinataire qui n'a pas de compte et n'en veut pas.

**Le problème :** la pièce jointe d'un courriel reste indéfiniment dans une
boîte, sur des serveurs qu'on ne maîtrise pas, sans date de péremption ni moyen
de la retirer.

**Ce qu'on s'est engagé à réaliser :**

1. Déposer un fichier, en tirer un lien à durée limitée, éventuellement protégé
   par un mot de passe, révocable à tout moment.
2. **Le destinataire n'a pas de compte** — il ouvre le lien et récupère le
   fichier.
3. Les fichiers sont **chiffrés au repos**, et une fuite de la base seule ne
   donne rien d'exploitable.
4. Le service se **redéploie** et se **restaure** après incident.

---

## 3. Les décisions communes

*Le sujet en demande deux. En voici trois, retenues parce qu'elles engagent les
deux spécialités et qu'elles ont chacune changé le travail de l'autre.*

### Décision 1 — Le stockage des fichiers *(IW + SRC, 16/09)*

**La question posée à SRC :** combien d'instances vise-t-on, et le service
doit-il survivre à la perte de sa machine ?

**Leur réponse :** une seule machine virtuelle, pas de multi-instance, pas de
bascule d'hôte, durabilité non impérative.

**Ce qu'on en a conclu :** ces trois réponses écartent la seule raison qui
aurait justifié un stockage partagé. **Volume Docker nommé**, donc — aucune
ligne de code backend, aucun service de plus à superviser, aucune clé d'accès
supplémentaire à protéger.

MinIO a été évalué et **écarté** : à une seule instance, il déplace le problème
d'un cran sans le résoudre, tout en ajoutant un service et deux secrets.

**Conséquence pour IW :** le backend écrit derrière une interface `FileStorage`,
ce qui rend le passage au stockage objet réalisable en une heure si le besoin
apparaissait — mais ce code n'a pas été écrit, faute de besoin.

**Conséquence pour SRC :** la sauvegarde devient obligatoire, alors que la
durabilité n'était pas exigée — parce que la restauration est un livrable noté.

Analyse complète : [decision-stockage-fichiers.md](decision-stockage-fichiers.md).

### Décision 2 — Node 24 imposé à l'image de déploiement *(IW → SRC, 15/09)*

**Découvert en écrivant les premiers tests :** NestJS 12 est distribué
uniquement en ESM, et Jest ne sait charger de l'ESM qu'à partir de Node 24.9.

**L'arbitrage :** revenir à NestJS 11 pour rester sur Node 22, ou monter le
poste et l'image de production en Node 24. Nous avons choisi Node 24 — les
gardes et les pipes de NestJS 12 rendent les contrôles d'accès lisibles, ce qui
est exactement ce qu'il fallait pouvoir montrer.

**Conséquence directe pour SRC :** l'image de base est **`node:24-alpine`**, et
`node:22` ne fonctionnera pas. C'est verrouillé dans `package.json` et signalé
en gras dans le document de coordination.

### Décision 3 — L'authentification renforcée, et son risque assumé *(IW, 16/09)*

**La demande :** vérification de l'adresse à l'inscription et double
authentification par courriel.

**Le risque signalé avant de coder :** rendre la double authentification
obligatoire pour tous fait dépendre **toute** connexion d'un envoi de courriel.
Sans réseau le jour de la soutenance, la démonstration s'arrête à l'écran de
connexion. Trois options ont été posées — activable par compte, obligatoire, ou
vérification d'adresse seule.

**Le choix :** obligatoire pour tous, et blocage complet de la connexion tant
que l'adresse n'est pas confirmée.

**Ce qui a été mis en place pour que ce choix reste tenable :** sans clé d'API,
hors production, le service écrit le contenu des courriels dans ses journaux au
lieu de les envoyer. La démonstration reste donc possible sans réseau. **En
production, ce repli est impossible** : le démarrage échoue sans clé, parce
qu'un code d'authentification écrit dans des journaux n'est plus un secret.

**Conséquence pour SRC :** une clé Brevo à configurer, un expéditeur à valider,
et **deux migrations** à appliquer — sans lesquelles aucune connexion ne
fonctionne.

---

## 4. Contribution de chacun

**49 commits** au total sur la semaine.

| Auteur | Commits | Domaine |
|---|---|---|
| Martin Simon | 37 | Backend intégral, chiffrement, tests, conteneurisation, documentation |
| Jérémy Gross | 12 | Frontend, interface d'administration, partage multi-fichiers |
| SRC | — | *À COMPLÉTER — leurs traces : dépôt, tickets, configuration* |

### Martin Simon — IW, backend

Ce qui est vérifiable dans le dépôt :

- **Chiffrement enveloppe** — une clé par fichier, elle-même chiffrée par la clé
  maître. Permet de **changer la clé maître sans relire un octet de fichier** :
  mesuré à **101 ms** sur le jeu de données complet.
- **Authentification** — argon2id, session courte de 15 min, jeton de
  renouvellement opaque avec rotation et **détection de rejeu** : présenter deux
  fois le même jeton révoque toute la lignée.
- **Chiffrement au repos** vérifié jusqu'aux octets : relevé hexadécimal du
  fichier sur le disque, relevé `psql` des colonnes chiffrées.
- **Conteneurisation** — image multi-étapes, utilisateur non-root, système de
  fichiers en lecture seule, capacités noyau retirées. Auditée en la lançant.
- **324 tests** (140 unitaires, 184 de bout en bout contre une vraie base
  PostgreSQL et un vrai répertoire de stockage — pas des doubles).

**Une conséquence de mes choix sur l'infrastructure :** le quota mensuel compte
les **dépôts**, pas le stockage occupé. C'est plus simple à comprendre pour
l'utilisateur et plus simple à calculer — mais cela signifie que le disque se
remplit sans qu'aucun compteur ne s'en aperçoive. D'où la **conservation bornée**
et la tâche de purge quotidienne, qui devient une charge d'exploitation pour
SRC : un choix produit qui crée une obligation côté infrastructure.

### Jérémy Gross — IW, frontend

> *Description établie depuis l'historique git et le code.*
> **Jérémy : relis et corrige, c'est toi qui devras l'expliquer.**

- Interface complète : dépôt avec progression, liste des fichiers, page de
  téléchargement pour destinataire sans compte, panneau d'administration.
- **Passage au multi-fichiers** : un lien couvre désormais une session de dépôt
  entière, ce qui a demandé de reprendre le schéma et les contrôleurs.
- Écran de déverrouillage des liens protégés par mot de passe.
- Conteneurisation du frontend et pile complète à la racine du dépôt.

**Ce que j'ai décidé, mesuré ou corrigé :**

- **Prototype d'interface sans backend** — l'UI et ses animations
  (`lib/file-transfer-engine.ts`) ont d'abord tourné sur un catalogue de
  fichiers fictif, pour avancer sur l'UX pendant que le backend se
  construisait. Une fois l'API prête, seule la couche de données a été
  remplacée par `lib/api.ts` ; l'animation, purement visuelle, est restée
  telle quelle.
- **Table de jointure plutôt qu'un `fileId` unique sur `Share`** — pour que le
  multi-fichiers tienne, une session de dépôt entière est désormais couverte
  par un modèle `ShareFile` (voir `schema.prisma`), avec un plafond volontaire
  de **50 fichiers par lien** : au-delà, un seul jeton devient
  disproportionnellement précieux à voler.
- **Port et version Node figés** — frontend sur le port **3001** (le backend
  occupe déjà 3000), backend épinglé sur **Node 24.9.0** exactement
  (`backend/.nvmrc`) et pas seulement « 24 » : c'est le patch minimal où Jest
  sait charger l'ESM de NestJS 12 (décision 2, §3).
- **Le rôle n'est jamais porté par le jeton de session** — en écrivant le
  panneau admin, il fallait qu'un changement de rôle décidé par un
  administrateur soit visible tout de suite, pas seulement à la prochaine
  connexion (jusqu'à 15 minutes plus tard, décision 3). `GET /api/auth/me`
  relit donc le rôle en base à chaque appel, comme côté administration.
- **Progression d'envoi mesurée, pas simulée** — l'upload passe par
  `XMLHttpRequest` plutôt que `fetch`, seul moyen d'obtenir un évènement de
  progression réel sur les octets déjà envoyés.

**Une conséquence de mes choix sur l'infrastructure :**

L'URL de l'API (`NEXT_PUBLIC_API_URL`) est inlinée dans le bundle Next.js **au
moment de la construction** de l'image frontend (`frontend/Dockerfile`), pas
lue au démarrage comme les variables du backend. Changer de domaine ou
d'environnement impose donc de reconstruire l'image frontend — SRC ne peut pas
se contenter d'ajuster une variable au déploiement, il faut relancer le build.

### Enzo ANSELMO, SRC

**Ce que j'ai décidé, mesuré ou corrigé :**
*À COMPLÉTER* — hébergement, reverse proxy, HTTPS, déploiement, sauvegardes,
supervision.

**Une conséquence de mes choix sur l'application :**
*À COMPLÉTER.* Par exemple : le choix d'une instance unique a écarté le stockage
partagé côté backend, ou le nombre de relais devant le service détermine
`TRUST_PROXY_HOPS`, sans lequel la limitation de tentatives bloque tout le monde
d'un coup.

### Julien DOURLET, SRC

Ce que j'ai décidé, mesuré ou corrigé :

Décidé : Mise en place d'une architecture d'observabilité hybride (proactive via Uptime Kuma sur le sous-domaine dédié status.filemoica.duckdns.org et réactive via Grafana/Loki), couplée à une stratégie de sauvegarde incrémentale automatisée avec Restic (dépôt local des dumps PostgreSQL et des fichiers uploads).

Mesuré : Validation expérimentale d'un RPO de 24 heures (Recovery Point Objective) et d'un RTO < 5 minutes (Recovery Time Objective) grâce au déroulement complet d'un crash-test de destruction/restauration en conditions réelles.

Corrigé : Résolution du conflit de routage SPA entre Caddy et Next.js en isolant la page de statut sur un sous-domaine propre, et correction des requêtes LogQL sous Grafana pour éliminer les erreurs d'expressions régulières vides.

Une conséquence de mes choix sur l'application :

Garantie de résilience et détection instantanée : L'application dispose d'un plan de reprise d'activité (DRP) formellement éprouvé qui élimine tout risque de perte définitive de données. En cas de panne critique ou de corruption, l'équipe est alertée immédiatement sur Discord/Telegram et la remise en service complète s'effectue en quelques commandes sans altérer l'expérience utilisateur globale.

### Killian DURANTI MACIA — SRC

**Ce que j'ai décidé, mesuré ou corrigé :**

* **Prise en charge de la machine de déploiement** — j'ai préparé et administré la VM Ubuntu utilisée pour héberger le projet : installation de Docker et Docker Compose, organisation des répertoires de déploiement dans `/opt`, gestion des services système et préparation de l'environnement nécessaire à l'exécution de la pile complète.

* **Déploiement et intégration du projet des développeurs** — j'ai récupéré les versions successives du frontend Next.js et du backend NestJS, intégré leur code dans l'infrastructure, construit leurs images Docker multi-étapes et assuré les mises à jour par reconstruction des images sans supprimer les volumes persistants. J'ai également pris en compte les migrations Prisma lors des redéploiements.

* **Architecture de reverse proxy à deux niveaux** — j'ai conservé Caddy directement sur la machine comme point d'entrée public et gestionnaire HTTPS, puis ajouté Nginx dans Docker comme reverse proxy interne. Caddy reçoit les connexions sur le domaine `filemoica.duckdns.org` et transmet uniquement vers Nginx sur `127.0.0.1:8080`. Nginx distribue ensuite les requêtes vers le frontend sur le port `3001` ou le backend sur le port `3000`.

* **Isolation réseau des services** — PostgreSQL, le backend, le frontend et Vault ne sont pas publiés directement sur Internet. PostgreSQL utilise un réseau Docker interne dédié et Vault un réseau privé séparé. Le port de Nginx est lié uniquement à `127.0.0.1`, de sorte que le seul véritable point d'entrée public reste Caddy.

* **Gestion du pare-feu et de l'exposition réseau** — j'ai configuré la machine afin de limiter l'accès extérieur aux services nécessaires au fonctionnement du site, principalement HTTP/HTTPS, tout en laissant PostgreSQL, Vault et les ports applicatifs accessibles uniquement depuis la machine ou les réseaux Docker concernés. Cette organisation évite d'exposer directement les composants internes de l'application.

* **Intégration de HashiCorp Vault** — j'ai ajouté Vault à la pile Docker afin de centraliser les secrets applicatifs tels que `JWT_SECRET`, `ENCRYPTION_KEY_V1` et `HMAC_INDEX_KEY`. Une première intégration avec stockage Raft, initialisation et mécanisme d'unseal a été mise en place et testée. Pour l'environnement de démonstration, j'ai ensuite simplifié le fonctionnement avec un Vault en mode développement et un service d'initialisation automatique, afin que le déploiement reste reproductible sans intervention manuelle à chaque redémarrage.

* **Diagnostic et correction des problèmes de déploiement** — plusieurs défauts n'apparaissaient qu'une fois la pile réellement exécutée : changement du chemin de volume de PostgreSQL 18, double chargement de la configuration Vault provoquant un conflit sur le port `8200`, erreur de configuration Nginx, résolution DNS des services uniquement disponible depuis le réseau Docker, et configuration Caddy invalide provoquant une erreur HTTP 502. Ces problèmes ont été reproduits avec les logs Docker, `curl`, les healthchecks et les outils de validation de configuration avant correction.

* **Persistance et redéploiement** — PostgreSQL et le stockage des fichiers utilisent des volumes Docker persistants. La pile peut ainsi être reconstruite avec `docker compose up -d --build` sans supprimer les données. Les volumes ne sont détruits que volontairement lors d'une remise à zéro de l'environnement.

* **Validation du fonctionnement réel** — après intégration, j'ai vérifié séparément chaque niveau de la chaîne : PostgreSQL en état `healthy`, Vault en état `healthy`, backend et frontend en état `healthy`, accès au frontend via Nginx sur `127.0.0.1:8080`, endpoint `/health` du backend, puis accès final en HTTPS par `filemoica.duckdns.org`.

**Une conséquence de mes choix sur l'application :**

Le choix de placer l'application derrière **deux reverse proxies, Caddy puis Nginx**, a directement influencé la configuration du backend. Le backend doit connaître le nombre de relais avec `TRUST_PROXY_HOPS=2` et recevoir correctement les en-têtes `X-Forwarded-For` et `X-Forwarded-Proto`. Sans cette configuration, l'application risque de considérer toutes les requêtes comme provenant du reverse proxy, ce qui fausserait notamment l'adresse IP utilisée par les mécanismes de limitation de tentatives et les journaux.

Le déploiement du frontend impose également une contrainte à SRC : `NEXT_PUBLIC_API_URL` est intégrée dans le bundle Next.js au moment du build. Un changement de domaine ou d'URL d'API ne peut donc pas être corrigé uniquement dans l'environnement d'exécution ; il faut reconstruire l'image frontend.

Enfin, l'intégration de Vault m'a obligé à coordonner la gestion des secrets avec les variables attendues par le backend. L'infrastructure doit fournir exactement les variables définies par l'application ; un changement de nom ou l'ajout d'un nouveau secret côté IW doit donc être répercuté dans la configuration de déploiement.


## 5. Ce qui a changé après les retours

### Le multi-fichiers, et la décision qu'il a forcée

Jérémy a fait évoluer le partage pendant que le backend travaillait sur la même
zone. **Trois fichiers en conflit**, résolus dans la branche pour que la fusion
reste propre.

Cette fusion a imposé de trancher une question de conception : **un lien à usage
unique se consume-t-il au premier fichier téléchargé, ou au dernier ?** Nous
avons choisi le dernier. Consumer au premier aurait fait de l'option un piège :
un destinataire recevant trois documents n'en aurait récupéré qu'un.

**Deux défauts ont été trouvés en fusionnant, que ni les tests ni la relecture
n'auraient montrés séparément :**

1. Le filtre de nettoyage interrogeait une colonne supprimée par le
   multi-fichiers. L'erreur était **avalée par un `catch`** : les fichiers
   n'étaient jamais effacés, et rien ne le signalait.
2. Un lien consommé **disparaissait de la liste de son créateur**, au moment
   précis où il voulait vérifier que le transfert avait eu lieu.

### Les défauts trouvés en manipulant l'interface

Le travail à deux a fait remonter des problèmes qu'aucun test ne couvrait :

- Après avoir révoqué un lien, **le fichier devenait impartageable** — la seule
  action restante était de le supprimer. Signalé par Martin en testant.
- Les fichiers supprimés côté serveur **restaient affichés** faute de
  rafraîchissement.
- Un lien dont le fichier avait été supprimé s'affichait **« Actif »** et
  proposait d'être révoqué, alors qu'il ne servait plus rien.

### Le défaut qui empêchait purement et simplement de se connecter

`FRONTEND_ORIGIN` valait `http://localhost:5173` — le port de Vite, reste d'un
cadrage antérieur — alors que Next.js écoute sur **3001**.

Le symptôme était trompeur : **le serveur acceptait la connexion et posait les
cookies**, mais le navigateur rejetait la réponse entière pour origine non
autorisée. Dans l'onglet Réseau, le `login` apparaissait en `200`. Tout avait
l'air de marcher, sauf que rien ne marchait.

---

## 6. Usage de l'intelligence artificielle, et vérifications

**L'IA (Claude) a été utilisée de façon intensive** sur la partie backend :
conception, rédaction du code, des tests et de la documentation. Cette section
décrit ce qui a été vérifié, et ce qui s'est révélé faux.

### Le principe de travail retenu

Aucune affirmation n'a été acceptée sans exécution. Chaque lot s'est terminé par
la même séquence — `npm test`, `npm run test:e2e`, `npm run lint`,
`tsc --noEmit`, `npm run build` — et les manipulations sensibles ont été jouées
en réel, pas décrites.

### Ce qui a été vérifié avant d'écrire

| Hypothèse | Vérification | Résultat |
|---|---|---|
| Alpine convient malgré les dépendances natives | Inspection des paquets publiés par `@node-rs/argon2` | ✅ un binaire musl existe |
| Le client Prisma n'a pas de moteur natif | Recherche de `.node` dans le client généré | ✅ aucun — le piège habituel d'Alpine est écarté |
| La CLI Prisma trouve un fichier de configuration au nom non standard | `npx prisma validate` | ✅ `Loaded Prisma config from prisma7.config.ts` |

### Ce que l'IA a affirmé à tort, et comment ça a été rattrapé

**Une justification fausse dans un commentaire de code.** L'étape de migration
du Dockerfile était justifiée par « le conteneur applicatif n'a aucun moyen de
modifier le schéma ». **L'audit de l'image a montré le contraire** : depuis
Prisma 7, `@prisma/client` dépend de la CLI, qui arrive donc avec les
dépendances de production. Le commentaire a été corrigé, et la vraie barrière
identifiée : un compte PostgreSQL sans droits DDL.

**Une procédure documentée qui ne fonctionnait pas.** La procédure de
restauration, écrite mais jamais jouée, a échoué au premier essai :
**42 erreurs**, et un résultat plus dangereux qu'un échec franc —
`users=1 files=0 shares=0`, une base qui *paraît* restaurée. Deux causes : les
migrations recréaient le schéma avant la restauration, et `psql` poursuit après
chaque erreur par défaut. Corrigé, rejoué, **0 erreur**.

> C'est la meilleure illustration du principe : le document affirmait
> lui-même qu'« une procédure jamais exécutée n'est pas une procédure ». Il l'a
> prouvé sur lui-même.

**Des lignes de `cron` inexécutables.** Transmises aux SRC sous la forme
`cd /srv/filemoica && npm run files:purge`, qui suppose une installation hors
conteneur. Découvert en les jouant réellement ; corrigé en
`docker compose exec -T`.

**Une contradiction interne rattrapée avant exécution.** Une contrainte de
validation `@Min(31)` avec une valeur par défaut de `30` aurait empêché le
service de démarrer. Repérée à la relecture, corrigée avant le premier
lancement.

### Des bugs latents révélés par la vérification

**Un bug que les tests ne voyaient pas.** Les fichiers déposés faisaient
**0 octet** : mettre le flux en mode « flowing » avant de le brancher perdait
les données. Les tests passaient quand même — l'assertion vérifiait que le
contenu n'était *pas* lisible en clair, ce qu'un fichier vide satisfait. Des
tests d'aller-retour et d'altération ont été ajoutés.

**Un script inexécutable en silence.** `docker/init-test-db.sh` avait des fins
de ligne CRLF : PostgreSQL passait le script **sans rien dire**, et la base de
test n'était jamais créée. Trouvé en reconstruisant un volume depuis zéro.

**Un contrôle de sécurité trop permissif.** La vérification d'adresse testait
`emailVerifiedAt === null`, ce qui laissait passer une valeur **absente**.
Corrigé en `!emailVerifiedAt` : un contrôle qui s'ouvre quand la donnée manque
finira par s'ouvrir. Deux tests le verrouillent désormais.

### Ce que cela dit du rapport à l'outil

L'IA a produit beaucoup de code correct, très vite. Elle a aussi produit **des
justifications plausibles et fausses**, et **de la documentation qui décrivait
un fonctionnement jamais essayé**. Ces erreurs-là ne se voient pas à la
relecture : elles ne se voient qu'en exécutant.

Le tri ne s'est pas fait sur la qualité apparente du code, mais sur la
**vérification** — construire l'image, la lancer, auditer ce qu'elle contient,
détruire la base et la restaurer, compter les octets.

---

## 7. Ce que nous n'avons pas fait, et pourquoi

| Point | Raison |
|---|---|
| Module de paiement | Hors périmètre assumé. L'offre payante se bascule en base |
| Stockage objet (S3/MinIO) | Évalué et écarté : inutile à une seule instance |
| Plusieurs instances | Le compteur de limitation de tentatives est en mémoire ; à revoir si cela change |
| Annulation d'un téléchargement | Le lien se consume à **l'envoi** du fichier. Ce que le navigateur en fait ensuite échappe au serveur — c'est vrai de tous les services de ce type |
| Révocation **instantanée** d'une session | Les jetons d'accès sont autoportants : couper une session prend jusqu'à 15 minutes. Le retrait de rôle, lui, est immédiat |

---

## 8. Chiffres du sprint

| | |
|---|---|
| Commits | 49 |
| Tests | **324** (140 unitaires · 184 bout en bout) |
| Migrations | 9 |
| Rotation de clé maître | **101 ms**, sans interruption |
| Restauration complète | **~50 s**, contenu **identique au bit près** |
| Reprise après perte de la base | **~8 s**, sans redémarrer l'application |

Détail et preuves : [resultats-des-tests.md](resultats-des-tests.md).
