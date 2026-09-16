# Guide de soutenance — filemoica

Tout ce qu'il faut lancer, et dans quel ordre le montrer.
**Commandes vérifiées le 16/09 sur `main`.**

---

## 1. Démarrage

### Option A — mode développement *(recommandée)*

La plus rapide et la plus maîtrisable : on voit les journaux défiler, et on peut
redémarrer une brique sans toucher aux autres.

**Terminal 1 — backend**

```bash
cd backend
npm install              # la première fois seulement
cp .env.example .env     # puis remplir les 3 clés (voir plus bas)
npm run db:up            # PostgreSQL dans Docker, port 5433
npm run db:migrate       # crée les tables
npm run build
npm run seed             # crée les 3 comptes de démonstration
npm run start:dev        # → http://localhost:3000
```

**Terminal 2 — frontend**

```bash
cd frontend
npm install              # ⚠️ pas encore fait sur ce poste — comptez 1 à 2 min
npm run dev              # → http://localhost:3001
```

> **Générer les trois clés** (64 caractères hexadécimaux chacune, différentes) :
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> `JWT_SECRET`, `ENCRYPTION_KEY_V1`, `HMAC_INDEX_KEY`. Le service refuse de
> démarrer si l'une manque — et le dit clairement.

> ⚠️ **Vérifiez `FRONTEND_ORIGIN=http://localhost:3001`** dans `backend/.env`.
> Le modèle portait `5173` (le port de Vite, reste d'un cadrage antérieur) alors
> que Next.js écoute sur **3001**. Avec la mauvaise valeur, la connexion
> *réussit côté serveur* mais le navigateur rejette la réponse pour cause
> d'origine non autorisée, jette les cookies, et l'utilisateur reste bloqué à
> l'écran de connexion sans message d'erreur parlant. Corrigé dans le modèle le
> 16/09.

### Option B — tout en conteneurs

Une seule commande, et c'est ce qui tourne en production. Plus lent à démarrer
(construction des images), moins pratique pour redémarrer une brique.

```bash
cp .env.example .env      # à la racine cette fois, remplir les 3 clés
docker compose up -d --build
docker compose exec backend node dist/seed.js
```

Front sur **3001**, backend sur **3000**.

> Les deux options se disputent le port **5433**. Arrêtez l'une avant de lancer
> l'autre : `npm run db:down` côté backend, ou `docker compose down` à la racine.

---

## 2. Les comptes de démonstration

**Mot de passe commun : `demonstration-filemoica-2026`**

| Compte | Rôle | Offre | Ce qu'il sert à montrer |
|---|---|---|---|
| `admin@filemoica.fr` | ADMIN | Payante | Le panneau de gestion des comptes |
| `alice@filemoica.fr` | USER | Gratuite | La limite de quota |
| `bob@filemoica.fr` | USER | Payante | La levée de la limite |

`npm run seed` est **rejouable** : relancez-le si la démonstration part de
travers, il remet les trois comptes d'aplomb sans toucher au reste.

---

## 3. Le parcours à jouer

Dans cet ordre : chaque étape prépare la suivante, et l'ensemble raconte le
produit puis la sécurité.

### Acte 1 — le parcours normal *(3 min)*

| # | Action | Ce que ça prouve |
|---|---|---|
| 1 | Se connecter en `alice@filemoica.fr` | — |
| 2 | Déposer un fichier | Le dépôt est chiffré **pendant** le transfert, jamais en clair sur le disque |
| 3 | Créer un lien : durée **1 h**, mot de passe, usage unique | Le déposant maîtrise la durée de vie et la protection |
| 4 | Copier le lien, l'ouvrir **en navigation privée** | **Le destinataire n'a pas de compte** — c'est le cœur du produit |
| 5 | Saisir le mot de passe, télécharger | Le fichier arrive intact |
| 6 | Recharger le lien | `410` — le lien à usage unique est consommé, le fichier effacé du serveur |

> La navigation privée n'est pas un détail de mise en scène : elle prouve qu'il
> n'y a **aucune session** derrière le téléchargement.

### Acte 2 — le contrôle d'accès *(2 min)*

| # | Action | Résultat attendu |
|---|---|---|
| 7 | Créer un second lien, puis le **révoquer** depuis la liste | Le lien répond `403`, immédiatement |
| 8 | Se connecter en `bob@filemoica.fr` | Sa liste de fichiers est **vide** — il ne voit pas ceux d'Alice |
| 9 | Se connecter en `admin@filemoica.fr`, ouvrir le panneau | Comptes, offres, quotas |
| 10 | Passer Alice en **offre payante** | Son quota passe de 200 Mo à 20 Go |

> **La phrase à dire au point 9 :** un administrateur gère des **comptes**,
> jamais du **contenu**. Il voit *combien* de fichiers un compte possède, jamais
> *lesquels*. C'est une frontière de conception : le serveur détient les clés et
> pourrait tout lire — ne pas offrir ce chemin dans l'API est précisément ce qui
> rend la promesse défendable.

### Acte 3 — l'incident maîtrisé *(2 min)*

```bash
curl http://localhost:3000/health      # 200, database: up
npm run db:down                        # on coupe la base
curl http://localhost:3000/health      # 503 — sans redémarrer l'application
npm run db:up                          # on la remonte
curl http://localhost:3000/health      # 200 — reprise en ~8 s, seule
```

Le **statut HTTP** porte l'information, pas seulement le corps : un
orchestrateur retire l'instance sans analyser la réponse.

---

## 4. Les preuves à sortir si on vous les demande

### « Les fichiers sont vraiment chiffrés ? »

```bash
# Le contenu sur le disque, illisible
Get-Content backend/storage/<nom> -Encoding Byte -TotalCount 32
```

Le nom du fichier sur le disque est aléatoire : lister le répertoire ne révèle
ni le nom d'origine, ni le propriétaire.

### « Et en base ? »

```bash
docker exec filemoica-db psql -U filemoica -d filemoica -c \
  "select original_name_enc, dek_wrapped from files limit 1;"
```

Nom du fichier et clé du fichier : **chiffrés**. Les jetons de partage sont
**hachés** (SHA-256), les mots de passe en **argon2id**.

### « Une fuite de la base suffirait-elle ? »

Non, et c'est le chiffrement enveloppe : chaque fichier a sa propre clé, elle-même
chiffrée par la clé maître qui n'est **que** dans les variables d'environnement.
Fuite du disque seul → illisible. Fuite de la base seule → clés inutilisables.
Les deux → il manque encore la clé maître.

### « Vous savez changer la clé maître ? »

```bash
npm run keys:rotate -- --dry-run   # compte sans rien modifier
npm run keys:rotate                # mesuré à 101 ms
```

Aucun fichier n'est relu : seules les petites clés sont re-scellées.

### Les autres chiffres

- **296 tests** au vert (128 unitaires, 168 de bout en bout)
- Restauration complète mesurée, contenu **identique au bit près**
- Détail : [résultats des tests](resultats-des-tests.md)

---

## 5. Si ça casse

| Symptôme | Cause | Remède |
|---|---|---|
| `port is already allocated` sur 5433 | Deux composes se disputent le port | `npm run db:down`, ou `docker compose down` à la racine |
| Le backend refuse de démarrer, liste des variables | `.env` incomplet | Générer les trois clés |
| Le front affiche une erreur réseau | Backend éteint, ou mauvais port | Vérifier `curl localhost:3000/health` |
| Connecté puis déconnecté à chaque page | Cookies `Secure` en HTTP | Rester en `NODE_ENV=development` |
| **La connexion ne « prend » pas**, `/api/auth/me` répond `401` | `FRONTEND_ORIGIN` ne correspond pas au port du front | Mettre `http://localhost:3001`, **puis redémarrer le backend** |
| Les tests e2e échouent sur des tables absentes | Migrations de test non rejouées | `npm run db:migrate:test` |

### ⚠️ Ne lancez pas `npm run db:reset` avant l'oral

Cette commande détruit le volume et le recrée. Sur `main`, le script
`backend/docker/init-test-db.sh` a des fins de ligne **CRLF** : le shebang se lit
`#!/bin/bash\r`, PostgreSQL passe le script **sans rien dire**, et la base
`filemoica_test` n'est jamais recréée. Les tests end-to-end tombent alors tous,
sans message clair.

Le volume actuel a été créé avant ce défaut : tant qu'on n'y touche pas, tout va
bien. *(Le correctif — un `.gitattributes` avec `*.sh text eol=lf` — existe sur
la branche `consolidation-compose`.)*

---

## 6. Récapitulatif — à cocher avant d'entrer

- [ ] `npm install` fait dans **frontend** *(pas encore fait)*
- [ ] `backend/.env` rempli avec les 3 clés
- [ ] `npm run db:up` → base démarrée
- [ ] `npm run seed` → 3 comptes créés
- [ ] Backend sur 3000, frontend sur 3001, `/health` répond `200`
- [ ] Un onglet de **navigation privée** déjà ouvert, pour l'acte 1
- [ ] Un fichier de test sous la main (un PDF ou une image, pas un fichier vide)
