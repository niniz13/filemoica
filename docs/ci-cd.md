# Intégration et livraison continues

Ce que fait la chaîne automatique, quand elle se déclenche, et où récupérer les
images à déployer.

Le pipeline vit dans [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).

---

## En bref

| | |
|---|---|
| **Se déclenche sur** | une pull request vers `main`, un `push` sur `main` (donc aussi tout `merge`), un tag `v*`, ou une relance manuelle |
| **Étape 1 — vérifier** | lint, types, 145 tests unitaires, 189 tests de bout en bout, compilation |
| **Étape 2 — livrer** | construction et publication de trois images sur GHCR |
| **Sur une pull request** | l'étape 1 seule. Une branche en revue vérifie, elle ne livre pas |
| **Si l'étape 1 échoue** | **rien n'est publié** — les images gardent la version précédente |
| **Ce qu'il ne fait pas** | déployer. Il livre des images, SRC décide quand les prendre |

---

## 1. Ce qui est vérifié, dans l'ordre

Le job `tests-backend` enchaîne, et **s'arrête au premier échec** :

| # | Étape | Ce qu'elle attrape |
|---|---|---|
| 1 | `npm ci` | Un `package.json` et un `package-lock.json` qui divergent |
| 2 | `npm run lint` | Les erreurs que l'analyse statique voit sans exécuter |
| 3 | `npx tsc --noEmit -p tsconfig.spec.json` | Les erreurs de type, **dans `src/` comme dans `test/`** |
| 4 | `npx prisma migrate deploy` | Une migration qui ne s'applique pas sur une base vierge |
| 5 | `npm test` | 145 tests unitaires |
| 6 | `npm run test:e2e` | 189 tests contre un **vrai** PostgreSQL 17 |
| 7 | `npm run build` | Une compilation qui casse alors que les tests passent |

L'étape 4 mérite une mention : elle rejoue **toutes** les migrations sur une base
vide à chaque exécution. C'est la seule façon de savoir qu'un déploiement neuf
fonctionnera encore — une migration peut très bien marcher sur la base de
développement, qui a l'historique, et échouer sur une base créée du jour.

### Le PostgreSQL du pipeline

Un service `postgres:17-alpine` démarre à côté du job, avec une sonde
`pg_isready` : les tests n'attaquent pas une base qui n'écoute pas encore.

Il porte des identifiants lisibles dans le fichier (`filemoica`/`filemoica`).
Ce n'est pas une fuite : cette base naît et meurt avec le job, sur un runner
isolé, sans port exposé au-delà. **Aucun secret de production n'entre dans le
pipeline** — les tests tournent sur des clés factices définies dans
[`backend/test/setup-env.ts`](../backend/test/setup-env.ts), et le `.env` réel
n'est pas versionné.

### Ce qui n'est pas vérifié

- **Le frontend n'a pas de tests.** Il est seulement compilé, à l'étape de
  construction de son image : si le build casse, la publication échoue. C'est
  une garantie faible, et c'est assumé faute de suite de tests côté interface.
- **Pas d'analyse de vulnérabilités** sur les images. Voir « Ce qu'on pourrait
  ajouter ».

---

## 2. Ce qui est publié

Trois images, sur le registre de conteneurs de GitHub (**GHCR**) :

| Image | Rôle |
|---|---|
| `ghcr.io/niniz13/filemoica-backend` | L'API. C'est elle qui tourne en permanence |
| `ghcr.io/niniz13/filemoica-migrations` | **Jetable** : applique `prisma migrate deploy`, puis s'arrête |
| `ghcr.io/niniz13/filemoica-frontend` | L'interface web (Next.js autonome) |

### Pourquoi une image de migrations séparée

C'est le point qu'on oublie le plus souvent, et l'oubli coûte cher : sans cette
image, il n'existe aucun moyen d'appliquer les migrations sur le serveur sans
recloner le dépôt et reconstruire à la main.

Elle est séparée de l'application **à dessein**. Migrer le schéma est un acte
d'administration, pas un effet de bord du démarrage : deux instances qui
démarrent ensemble ne se disputent pas le schéma, et une migration qui échoue se
voit immédiatement au lieu d'être noyée dans les journaux de démarrage.

### Les étiquettes

Chaque image reçoit plusieurs tags à la fois :

| Tag | Quand | À quoi il sert |
|---|---|---|
| `sha-a1b2c3d` | À chaque publication | **Immuable.** Désigne un commit et un seul |
| `latest` | Sur `main` | Pratique pour un environnement de test. **Ne jamais déployer ça en production** |
| `1.0.0`, `1.0` | Sur un tag git `v1.0.0` | La version qu'on déploie et qu'on peut citer |

> ⚠️ `latest` bouge sous les pieds. Deux `docker pull latest` à dix minutes
> d'écart peuvent donner deux images différentes, et plus personne ne sait ce qui
> tourne. **En production, déployez un tag `sha-…` ou une version.**

L'image expose sa version : `GET /health` renvoie `{"version":"v1.0.0",…}`. On
peut donc vérifier depuis l'extérieur quelle version tourne réellement, sans se
fier à ce qui était censé être déployé.

---

## 3. Récupérer les images — pour SRC

### S'authentifier

Les paquets GHCR héritent par défaut de la visibilité du dépôt et sont donc
**privés**. Deux options, au choix de l'équipe IW :

**Option A — rendre les paquets publics** (le plus simple pour ce projet) :
sur GitHub, `Packages` → le paquet → `Package settings` → `Change visibility` →
`Public`. Plus aucune authentification n'est nécessaire pour tirer l'image.

**Option B — un jeton de lecture** : créer un *personal access token*
(classique) avec la seule portée `read:packages`, puis :

```bash
echo "$GHCR_TOKEN" | docker login ghcr.io -u <votre-identifiant> --password-stdin
```

Le jeton se traite comme un mot de passe : jamais dans un dépôt, jamais par
messagerie instantanée.

### Tirer et lancer

```bash
# 1. Récupérer les images (remplacer le tag par la version à déployer)
docker pull ghcr.io/niniz13/filemoica-migrations:1.0.0
docker pull ghcr.io/niniz13/filemoica-backend:1.0.0
docker pull ghcr.io/niniz13/filemoica-frontend:1.0.0

# 2. Migrer le schéma AVANT de démarrer l'application
docker run --rm --env-file .env.deploy \
  ghcr.io/niniz13/filemoica-migrations:1.0.0

# 3. Démarrer l'application
docker run -d --name filemoica-backend --env-file .env.deploy \
  -v filemoica-storage:/var/lib/filemoica/storage \
  ghcr.io/niniz13/filemoica-backend:1.0.0
```

L'ordre compte : l'application démarrée avant ses migrations répondra `503` sur
`/health`, faute de trouver les tables.

Pour la pile complète avec durcissement (`read_only`, `cap_drop`, base non
publiée), partez de
[`backend/docker-compose.deploy.yml`](../backend/docker-compose.deploy.yml) et
remplacez la directive `build:` par `image: ghcr.io/niniz13/filemoica-backend:<tag>`.

Toutes les variables d'environnement attendues sont décrites dans
[configuration-deploiement.md](configuration-deploiement.md).

---

## 4. Ce qu'il faut régler une fois

Côté dépôt GitHub, avant que la chaîne soit pleinement utile :

- [ ] **`NEXT_PUBLIC_API_URL`** — `Settings` → `Secrets and variables` →
      `Actions` → onglet `Variables` → `New repository variable`. Valeur :
      l'URL publique de l'API, par exemple `https://api.filemoica.example.fr`.

      ⚠️ Cette valeur est **inlinée dans le bundle JavaScript au moment de la
      construction**, pas lue au démarrage du conteneur. Sans elle, l'image
      frontend publiée pointe sur `http://localhost:3000` et ne vaut que pour
      une démonstration locale. La corriger impose de **reconstruire** l'image.

- [ ] **Visibilité des paquets** — voir la section 3 ci-dessus.

- [ ] *(recommandé)* **Rendre la vérification bloquante** — `Settings` →
      `Branches` → `Add branch ruleset` sur `main` → `Require status checks to
      pass` → cocher **`Tests backend`**.

      Sans ce réglage, la vérification sur pull request est **informative** : le
      bouton « Merge » reste vert même en rouge, et rien n'empêche de fusionner
      du code qui casse. Avec, GitHub refuse la fusion tant que la suite n'est
      pas passée. C'est ce qui transforme la chaîne d'un indicateur en garde-fou.

Rien d'autre. En particulier, **aucun secret à créer** : l'authentification au
registre passe par le `GITHUB_TOKEN` fourni automatiquement à chaque exécution,
dont la portée est limitée à ce dépôt et qui expire avec le job.

---

## 5. Choix assumés

### Le pipeline ne déploie pas

Il s'arrête au registre. Une mise en production ne doit pas être l'effet de bord
d'un `git push` : SRC tient l'infrastructure, c'est à eux de décider quand une
version y arrive. La chaîne leur garantit seulement qu'une image publiée a passé
l'intégralité des tests.

### On vérifie sur les pull requests, on ne livre que depuis `main`

Les deux moitiés de la chaîne n'ont pas le même déclencheur, et c'est délibéré.

**Vérifier** a d'autant plus de valeur que c'est fait tôt : une branche cassée
détectée seulement après sa fusion l'est au pire moment, sur `main`, là où tout
le monde travaille. Le job `tests-backend` tourne donc aussi sur chaque pull
request visant `main`.

**Livrer**, en revanche, n'a de sens que depuis du code fusionné. Les deux jobs
de publication portent :

```yaml
if: github.event_name != 'pull_request'
```

Sans cette condition, une branche en cours de revue publierait ses images sur le
registre, sous les mêmes tags que ceux que SRC tirent — du code non relu
arriverait en déploiement par le seul fait d'avoir ouvert une PR.

### Il ne publie pas depuis une branche autre que `main`

Corollaire du point précédent : pousser sur `authentification` ou `link` ne
déclenche rien du tout. Pour faire vérifier une branche, on ouvre une pull
request — ce qui est de toute façon le passage obligé pour la fusionner.

### Les jobs sont enchaînés, pas parallèles

`image-backend` et `image-frontend` attendent tous deux `tests-backend`
(`needs:`). Une suite de tests en échec ne produit donc **aucune** image, pas
même celle du frontend. C'est plus lent qu'une exécution en parallèle, et c'est
le but : on ne livre pas des morceaux d'une pile dont on sait qu'une partie est
cassée.

---

## Ce qu'on pourrait ajouter

Par ordre de valeur, si le temps le permet :

| Ajout | Pourquoi | Coût |
|---|---|---|
| Analyse des images (Trivy) | Un projet qui vend de la sécurité gagne à scanner ce qu'il livre | 1 étape |
| `npm audit --audit-level=high` | Les vulnérabilités connues des dépendances | 1 étape |
| Signature des images (cosign) | Prouve qu'une image vient bien de cette chaîne | 1 étape + clé |
| Tests du frontend | La seule vraie lacune de couverture | Plusieurs jours |

Les deux étapes d'analyse ont été volontairement laissées de côté **pour la
semaine de soutenance** : une CVE publiée dans une image de base ferait passer
`main` au rouge un mercredi soir, sans rapport avec le code écrit. À rebrancher
en bloquant une fois le projet stabilisé.
