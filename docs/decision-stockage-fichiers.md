# Où stocker les fichiers — options, procédures et répartition des rôles

**Décision commune IW / SRC · tranchée le 16/09/2026**

Ce document a servi de base à la décision. Il décrit les options envisagées, ce
que chacune impliquait, et qui en a la charge. L'analyse est conservée telle
quelle : elle justifie le choix retenu et documente les options écartées.

---

## ✅ Décision retenue

**Option A — volume Docker nommé**, monté sur `STORAGE_PATH`.

### Ce que SRC a répondu (16/09)

| Question | Réponse |
|---|---|
| Plusieurs instances en parallèle ? | **Non** — une seule machine virtuelle |
| Survivre à la perte de la machine sans perdre de fichiers ? | **Pas impérativement** — projet temporaire, une seule VM |
| Redémarrage automatique sur un autre hôte ? | **Non** |

### Pourquoi cette option

Les trois réponses écartent la seule raison qui aurait justifié un stockage
partagé. Restent les critères de simplicité et de surface d'attaque, et le volume
nommé l'emporte sur les deux : **aucune ligne de code backend**, aucun service
supplémentaire à superviser, aucune clé d'accès de plus à protéger.

MinIO aurait ajouté un service et deux secrets sans rien résoudre à une seule
instance. Le stockage objet infogéré est payant, ce que le sujet exclut, et
rendrait la démonstration dépendante du réseau.

### Bind mount plutôt que volume nommé : à SRC de voir

L'option B (répertoire de l'hôte monté) reste équivalente côté backend — le
changement tient en **une ligne du fichier compose**. Certaines équipes
d'infrastructure la préfèrent parce que la sauvegarde devient un `tar` ou un
`rsync` ordinaire, sans conteneur intermédiaire. En contrepartie, il faut poser
les permissions à la main.

Le backend est indifférent aux deux : c'est un chemin de fichier dans les deux
cas. **Le choix appartient à SRC et peut changer à tout moment.**

### ⚠️ Deux conséquences à ne pas manquer

**1. La sauvegarde reste nécessaire, même si la durabilité n'est pas exigée.**
Le sujet impose de démontrer une restauration de données (critère « incident
maîtrisé »). La procédure de la section 8 doit donc exister et être jouée, non
pas pour protéger le service, mais parce que c'est un livrable évalué.

**2. `docker compose down -v` détruit le volume et tous les fichiers avec.**
Le drapeau `-v` supprime les volumes. Pendant le sprint, préférer
`docker compose down` seul. Cette commande est justement celle qu'on utilisera
**volontairement** pour la démonstration de restauration.

---

## 1. Ce que la décision ne remet pas en cause

Trois choses sont déjà acquises et ne dépendent pas du choix de stockage :

- **Les fichiers sont chiffrés par l'application** (AES-256-GCM, chiffrement
  enveloppe). Ce qui est écrit sur le support est illisible sans la clé maître,
  qui vit dans les variables d'environnement — jamais avec les données.
- **Le nom sur le support est aléatoire.** Lister le répertoire ou le bucket ne
  révèle ni le nom d'origine, ni le propriétaire.
- **L'application survit déjà à une panne de sa base** et se reconnecte seule
  (cycle 200 → 503 → 200 vérifié le 15/09).

**Conséquence importante :** le support de stockage ne protège plus la
confidentialité des fichiers, elle est déjà assurée. Le choix se joue donc sur
la **disponibilité**, la **durabilité** et la **complexité**, pas sur le secret.

---

## 2. Trois questions qui déterminent la réponse

La bonne option dépend entièrement des réponses à ces trois questions. Ce sont
elles qu'il faut trancher avec SRC.

| # | Question | Si « non » | Si « oui » |
|---|---|---|---|
| 1 | Le service doit-il tourner sur **plusieurs instances en parallèle** ? | Volume local suffit | Stockage partagé obligatoire |
| 2 | Doit-il survivre à la **perte de sa machine** sans perdre de fichiers ? | Volume local suffit | Copie hors machine obligatoire |
| 3 | Doit-il **redémarrer automatiquement sur un autre hôte** ? | Volume local suffit | Stockage partagé obligatoire |

**Attention à ne pas confondre deux choses souvent appelées « résilience » :**

- **Résilience applicative** — le service redémarre après un plantage, se
  reconnecte à sa base, ne perd pas de données. *Déjà acquis, quel que soit le
  stockage.* Un volume Docker nommé survit à un redémarrage de conteneur, à un
  `docker compose down/up` et à un redéploiement de l'image.
- **Résilience d'infrastructure** — le service survit à la perte de la machine
  elle-même, ou tourne sur plusieurs machines. *C'est le seul enjeu réel de
  cette décision.*

---

## 3. Les options

### Option A — Volume Docker nommé

Docker gère un espace de stockage persistant, monté dans le conteneur. C'est
l'option par défaut pour des données qui doivent survivre au conteneur.

```yaml
services:
  api:
    volumes:
      - file-storage:/var/lib/filemoica/storage
    environment:
      STORAGE_PATH: /var/lib/filemoica/storage

volumes:
  file-storage:
```

| | |
|---|---|
| **Code backend** | Aucun changement — écriture de fichiers classique |
| **Survit au redémarrage du conteneur** | ✅ |
| **Survit au redéploiement de l'image** | ✅ |
| **Survit à la perte de la machine** | ❌ sauf sauvegarde hors machine |
| **Plusieurs instances** | ❌ |
| **Coût** | Nul |
| **Mise en place** | ~10 minutes |

**Limite à énoncer au jury plutôt qu'à cacher :** les fichiers sont attachés à
une machine. C'est un choix défendable pour un service à une instance, à
condition d'assumer la sauvegarde.

---

### Option B — Montage d'un répertoire de l'hôte

Variante de A : au lieu de laisser Docker gérer l'emplacement, on désigne un
répertoire précis de la machine.

```yaml
volumes:
  - /srv/filemoica/storage:/var/lib/filemoica/storage
```

| | |
|---|---|
| **Code backend** | Aucun changement |
| **Avantage sur A** | SRC voit et sauvegarde les fichiers avec ses outils habituels, sans passer par Docker |
| **Inconvénient sur A** | Les permissions doivent être posées à la main : l'utilisateur du conteneur doit correspondre au propriétaire du répertoire, sinon l'application ne peut pas écrire |
| **Coût** | Nul |
| **Mise en place** | ~15 minutes |

C'est souvent ce que préfèrent les équipes d'infrastructure, parce que la
sauvegarde devient un `tar` ou un `rsync` ordinaire.

---

### Option C — MinIO (stockage objet auto-hébergé)

MinIO expose une API compatible S3, dans un conteneur à côté du service.

```yaml
services:
  minio:
    image: minio/minio
    command: server /data
    environment:
      MINIO_ROOT_USER: ${MINIO_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
    volumes:
      - minio-data:/data
```

| | |
|---|---|
| **Code backend** | **À réécrire** : plus un chemin de fichier mais un SDK (`@aws-sdk/client-s3`) |
| **Plusieurs instances** | ✅ toutes parlent au même MinIO |
| **Survit à la perte de la machine** | ❌ — MinIO tourne sur cette machine et stocke dans… un volume Docker |
| **Coût** | Nul |
| **Mise en place** | ~1 h 30 (service, identifiants, bucket, réécriture du code, tests) |

**Le piège :** MinIO à une instance ne résout **pas** la perte de machine. Il
déplace le problème d'un cran sans le supprimer, tout en ajoutant un service à
superviser et une paire de clés d'accès à protéger. Il ne devient réellement
utile qu'avec plusieurs instances applicatives.

---

### Option D — Stockage objet infogéré (S3, Scaleway, OVH…)

| | |
|---|---|
| **Code backend** | **À réécrire**, comme en C |
| **Survit à la perte de la machine** | ✅ les fichiers ne sont plus chez nous |
| **Plusieurs instances** | ✅ |
| **Coût** | **Payant** au-delà des paliers gratuits |
| **Mise en place** | ~1 h + création de compte |

⚠️ **Le sujet précise qu'aucun compte payant n'est obligatoire.** Cette option
n'est donc envisageable que si quelqu'un dispose déjà d'un accès, et elle ne doit
pas devenir une dépendance de la démonstration. Une coupure réseau le vendredi
rendrait le service inutilisable.

---

### Option E — Système de fichiers réseau (NFS)

Un partage réseau monté par toutes les instances, qui le voient comme un
répertoire ordinaire.

| | |
|---|---|
| **Code backend** | Aucun changement — c'est un chemin de fichier |
| **Plusieurs instances** | ✅ |
| **Survit à la perte de la machine applicative** | ✅ (mais pas à celle du serveur NFS) |
| **Coût** | Nul si une machine est disponible |
| **Mise en place** | ~1 h côté SRC, 0 côté backend |

C'est le seul moyen d'avoir **plusieurs instances sans toucher au code**. En
contrepartie, le serveur NFS devient le point de défaillance unique, et sa panne
fait tomber les téléchargements.

---

## 4. Comparaison

| Critère | A · Volume | B · Répertoire hôte | C · MinIO | D · Objet infogéré | E · NFS |
|---|---|---|---|---|---|
| Code backend à écrire | Aucun | Aucun | Réécriture | Réécriture | Aucun |
| Survit au redémarrage | ✅ | ✅ | ✅ | ✅ | ✅ |
| Survit à la perte de la machine | Par sauvegarde | Par sauvegarde | ❌ | ✅ | Partiellement |
| Plusieurs instances | ❌ | ❌ | ✅ | ✅ | ✅ |
| Services à superviser | 0 | 0 | +1 | 0 | +1 |
| Secrets supplémentaires | 0 | 0 | +2 | +2 | 0 |
| Coût | Nul | Nul | Nul | **Payant** | Nul |
| Effort total | ~10 min | ~15 min | ~1 h 30 | ~1 h | ~1 h |

---

## 5. Recommandation

**Option A ou B, plus une sauvegarde hors machine**, sauf si SRC répond « oui »
à la question 1 ou 3 de la section 2.

Le raisonnement : la seule faiblesse réelle du volume local est la perte de la
machine, et une sauvegarde régulière vers un autre emplacement y répond à un
délai de reprise près. Les options C et D coûtent une réécriture du dépôt et du
téléchargement, ajoutent des secrets à protéger, et C ne résout même pas le
problème qu'on lui prête.

**Si SRC veut plusieurs instances, l'option E (NFS) est préférable à MinIO** : le
code backend reste identique, et l'effort est entièrement du côté de
l'infrastructure — ce qui correspond mieux à la répartition des rôles du projet.

**Le point à défendre devant le jury**, quelle que soit l'option : ce qui est
stocké est déjà chiffré. Une sauvegarde qui traîne, un disque volé ou un bucket
mal configuré ne livrent rien d'exploitable, **à condition que la clé maître ne
voyage jamais avec les données**.

---

## 6. Ce que le backend fera dans tous les cas

Pour que le choix reste réversible, le code passera par une interface unique
plutôt que d'appeler directement le système de fichiers :

```ts
interface FileStorage {
  /** Écrit un flux déjà chiffré, renvoie le nom sous lequel il est rangé. */
  write(content: Readable): Promise<{ storageName: string; sizeBytes: number }>;

  /** Relit un fichier chiffré. */
  read(storageName: string): Promise<Readable>;

  /** Supprime définitivement un fichier. */
  remove(storageName: string): Promise<void>;
}
```

Une implémentation sur système de fichiers couvre les options A, B et E. Passer
en C ou D reviendrait à écrire une seconde implémentation **sans toucher au reste
du code** — environ une heure au lieu d'une réécriture.

**Cette interface sera écrite dès le prochain lot, quelle que soit la décision.**
Elle ne coûte rien et évite de se retrouver coincé.

---

## 7. Qui fait quoi

### Backend (IW)

| Responsabilité | Détail |
|---|---|
| Chiffrement | Génère une clé par fichier, chiffre le contenu, ne stocke jamais de clair |
| Nommage | Tire un nom aléatoire ; le nom d'origine est chiffré en base |
| Écriture et lecture | Via l'interface `FileStorage`, en flux |
| Intégrité | Vérifie le tag GCM à la lecture — un fichier altéré fait échouer le téléchargement |
| Limites | Refuse un fichier au-delà de la taille maximale, avant de l'écrire |
| Nettoyage | Supprime le fichier du support quand l'utilisateur supprime l'entrée |
| Disque plein | Renvoie une erreur explicite plutôt qu'un fichier tronqué |
| Configuration | Lit `STORAGE_PATH`, refuse de démarrer si le chemin est absent ou non inscriptible |

### Infrastructure (SRC)

| Responsabilité | Détail |
|---|---|
| Emplacement physique | Crée le volume ou le répertoire, le monte dans le conteneur |
| Permissions | `0700`, propriétaire = utilisateur non-root du conteneur. Personne d'autre ne doit pouvoir lire |
| Capacité | Dimensionne l'espace et **surveille son remplissage** — un disque plein casse les dépôts |
| Sauvegarde | Planifie la copie, **hors de la machine** |
| Restauration | Rédige et **teste** la procédure (c'est un livrable attendu) |
| Secrets | Injecte `ENCRYPTION_KEY_V1` et les autres, **jamais dans la même sauvegarde que les données** |
| Supervision | Surveille l'espace disque et l'état du service |

### À décider ensemble

| Sujet | Question |
|---|---|
| Taille maximale d'un fichier | Détermine l'espace nécessaire et la limite codée côté backend |
| Durée de conservation | Un fichier dont tous les partages ont expiré doit-il être supprimé, et après combien de temps ? |
| Fréquence de sauvegarde | Combien de minutes de dépôts accepte-t-on de perdre ? |
| Comportement si le disque est plein | Refus des dépôts, alerte, ou les deux ? |

---

## 8. Sauvegarde et restauration

### La règle essentielle : deux artefacts indissociables

Une sauvegarde complète, c'est **deux choses** :

1. le **dump de la base** — qui contient les clés de fichiers chiffrées, les
   noms d'origine chiffrés et les partages ;
2. le **contenu du stockage** — les fichiers chiffrés eux-mêmes.

Restaurer l'un sans l'autre ne donne rien d'exploitable. C'est une démonstration
concrète de la défense en profondeur, et c'est aussi un piège opérationnel : une
procédure qui n'en sauvegarde qu'un seul est inutile.

### L'ordre compte

**Sauvegarder la base d'abord, les fichiers ensuite.**

La raison est subtile mais décisive. Entre les deux prises, un utilisateur peut
déposer un fichier :

- Base puis fichiers → les octets sont sauvegardés, la ligne en base n'existe
  pas encore. Résultat : un fichier orphelin, **sans conséquence**.
- Fichiers puis base → la ligne existe, les octets manquent. Résultat : un
  téléchargement **cassé** au moment où l'utilisateur en aura besoin.

**À la restauration, l'ordre s'inverse : les fichiers d'abord, la base ensuite**,
pour ne jamais exposer une entrée dont le contenu n'est pas encore revenu.

### Commandes (options A et B)

```bash
# 1. Base d'abord
docker compose exec -T db pg_dump -U filemoica filemoica > sauvegarde-base.sql

# 2. Fichiers ensuite — volume nommé
docker run --rm \
  -v filemoica_file-storage:/data:ro \
  -v "$PWD":/backup \
  alpine tar czf /backup/sauvegarde-fichiers.tar.gz -C /data .

# 2 bis. Fichiers ensuite — répertoire de l'hôte
tar czf sauvegarde-fichiers.tar.gz -C /srv/filemoica/storage .
```

### Restauration — l'ordre **et** l'état de la base comptent

> ⚠️ **Cette procédure a été corrigée après l'avoir jouée le 16/09.** La version
> précédente remontait toute la pile avant de restaurer, ce qui produisait
> **42 erreurs et une base à moitié restaurée** — sans que rien n'échoue
> franchement. Détail du défaut plus bas.

```bash
# 1. Démarrer la base SEULE — ni migrations, ni application
docker compose -f docker-compose.deploy.yml -p filemoica up -d db

# 2. Fichiers d'abord
docker run --rm \
  -v filemoica_file-storage:/data \
  -v "$PWD":/backup \
  alpine tar xzf /backup/sauvegarde-fichiers.tar.gz -C /data

# 3. Base ensuite, avec arrêt à la première erreur
docker cp sauvegarde-base.sql filemoica-db-1:/tmp/base.sql
docker compose -f docker-compose.deploy.yml -p filemoica exec -T db \
  psql -U filemoica -d filemoica -v ON_ERROR_STOP=1 -f /tmp/base.sql

# 4. Démarrer l'application seulement maintenant
docker compose -f docker-compose.deploy.yml -p filemoica up -d app
```

À l'étape 4, le conteneur de migrations se lance, retrouve la table
`_prisma_migrations` restaurée, annonce « No pending migrations to apply » et
s'arrête. C'est le comportement attendu : **le dump contient déjà le schéma**,
il n'y a rien à migrer.

#### Les deux corrections, et pourquoi elles sont indispensables

**1. Ne pas laisser les migrations s'exécuter avant la restauration.** Un
`pg_dump` contient les `CREATE TYPE` et `CREATE TABLE`. Si le schéma a déjà été
recréé par le conteneur de migrations, chaque création échoue
(`type "Plan" already exists`), puis les insertions de données tombent en
cascade sur des contraintes de clé étrangère. D'où l'étape 1 : la base démarre
**seule**, vierge.

**2. `-v ON_ERROR_STOP=1` n'est pas un détail.** Par défaut, `psql` **continue
après chaque erreur**. Sans ce drapeau, la restauration ratée se termine sans
rien signaler et laisse une base qui *paraît* restaurée :

```
users=1  files=0  shares=0
```

Un compte, aucun fichier. C'est exactement ce qu'on a obtenu en jouant la
procédure d'origine — et c'est le pire des cas, parce qu'on ne s'en aperçoit
qu'en cherchant un fichier qui n'est plus là.

### ⚠️ La clé maître ne part jamais avec la sauvegarde

Les deux artefacts sont chiffrés et donc inexploitables tels quels. Ils cessent
de l'être dès qu'ils voyagent avec le `.env`.

**Ne jamais ranger `ENCRYPTION_KEY_V1` au même endroit que les sauvegardes.** Ce
serait annuler d'un coup tout le chiffrement au repos.

Corollaire, tout aussi important : **une sauvegarde sans la clé est
irrécupérable**. La clé doit donc être conservée ailleurs, mais sûrement — la
perdre revient à perdre tous les fichiers.

### Le test de restauration — joué le 16/09

Le sujet demande explicitement de tester une remise en fonctionnement. **Une
procédure jamais exécutée n'est pas une procédure** — et celle-ci vient de le
démontrer à ses dépens : jouée pour la première fois, elle a échoué.

Le scénario :

1. déposer un fichier, créer un partage, vérifier le téléchargement ;
2. sauvegarder base **puis** fichiers ;
3. tout détruire (`docker compose down -v`) ;
4. restaurer fichiers **puis** base, sur une base démarrée seule ;
5. re-télécharger le **même** fichier et vérifier qu'il est identique.

| Étape | Attendu | Obtenu |
|---|---|---|
| 1 | Dépôt et lien fonctionnels | ✅ 337 octets, SHA-256 `a74f4a44…`, téléchargement `200` |
| 2 | Deux artefacts | ✅ dump 14 453 o en **0,6 s** ; archive 510 o en **0,9 s** |
| 3 | Destruction réelle | ✅ `down -v` en **2,0 s** — plus aucun volume `filemoica_*` |
| 4 | Restauration sans erreur | ✅ fichiers en **1,1 s** (permissions et uid 1000 préservés), base **0 erreur** |
| 4 bis | Migrations | ✅ « 7 migrations found — No pending migrations to apply » |
| 5 | **Contenu identique** | ✅ SHA-256 `a74f4a44…` — **identique au bit près** |

**Durée de la restauration : environ 30 secondes**, démarrage des conteneurs
compris. La construction de l'image (83 s) n'en fait pas partie : en production
l'image est déjà là.

L'étape 5 est celle qui compte : le nom `contrat.txt` est revenu déchiffré et le
lien d'origine fonctionne encore, ce qui prouve que la clé maître, la DEK
chiffrée, le contenu et le tag d'intégrité sont tous cohérents entre eux.

#### La règle des deux artefacts, vérifiée elle aussi

Le scénario a été rejoué en ne restaurant **que la base**, volume laissé vide :

| Observation | Résultat |
|---|---|
| Consultation du lien (`/info`) | **200** — le lien *paraît* valide |
| Téléchargement | **Échec**, connexion fermée sans contenu |
| Journal applicatif | `ENOENT … /var/lib/filemoica/storage/189c10ef…` |
| État du service | **Reste sain** — aucune instance à redémarrer |

« Restaurer l'un sans l'autre ne donne rien d'exploitable » n'est donc plus une
affirmation de principe : c'est une observation. Et le cas est plus perfide
qu'un échec franc, puisque la liste des fichiers et les liens semblent intacts.

#### Deux défauts relevés à cette occasion — et corrigés

La répétition n'a pas seulement validé la procédure, elle a mis au jour deux
défauts du service lui-même. Les deux sont réparés et couverts par des tests.

**1. Un contenu manquant coupait la connexion au lieu de renvoyer une erreur.**
Le fichier part en flux : quand la lecture échouait, les en-têtes étaient déjà
émis et le statut ne pouvait plus changer. Le destinataire recevait une
connexion fermée, sans la moindre explication.

Le service vérifie désormais la présence du contenu **avant** d'écrire quoi que
ce soit, et répond :

```json
{ "error": "CONTENT_UNAVAILABLE", "message": "Le contenu de ce fichier est momentanément indisponible." }
```

**`500` et non `404`** : le lien est valide et le fichier devrait exister. Le
destinataire n'a rien à corriger de son côté — c'est le service qui a perdu la
donnée. Un `404` l'enverrait vérifier son lien pour rien.

Le contrôle est placé **avant la réservation** du fichier, de sorte qu'un lien à
usage unique n'est pas consumé par un échec : une fois le volume remonté, le
destinataire peut réessayer. C'est le second test ajouté.

**2. Le message d'erreur confondait deux causes sans rapport.** Il annonçait
« fichier altéré ou clé invalide » alors que la cause réelle était un fichier
absent — de quoi lancer une enquête sur le chiffrement quand le problème est un
volume non monté. Les deux cas sont maintenant distingués dans les journaux.

> Le cas du **tag d'intégrité qui ne correspond pas**, lui, reste
> nécessairement détecté en fin de flux : GCM ne se vérifie qu'au dernier octet.
> La connexion est alors coupée, volontairement — mieux vaut un téléchargement
> manifestement interrompu qu'un fichier corrompu que le destinataire croirait
> valide.

---

## 9. Limites assumées

À énoncer au jury plutôt qu'à laisser découvrir :

- **Les fichiers sont attachés à une machine.** La perte de la VM entraîne la
  perte des fichiers déposés depuis la dernière sauvegarde. C'est un choix
  assumé, cohérent avec un service temporaire à une instance.
- **Une seule instance.** Pas de répartition de charge ni de bascule
  automatique. Monter en charge signifierait ici agrandir la machine, pas en
  ajouter.
- **Le service est indisponible pendant un redémarrage.** Quelques secondes,
  mesurées lors du test d'incident du 15/09.

Ces limites viennent du cadre du projet, pas d'un oubli de conception. Le passage
à un stockage partagé a été évalué et écarté, et l'interface `FileStorage` de la
section 6 le garde réalisable en environ une heure si le besoin apparaissait.
