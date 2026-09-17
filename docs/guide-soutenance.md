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

> ⚠️ **La connexion se fait en deux temps.** Après le mot de passe, un **code à
> six chiffres** arrive par courriel. Les comptes de démonstration utilisent des
> adresses `@filemoica.fr` qui n'existent pas : **vous ne recevrez jamais leur
> code.**
>
> **Sans clé Brevo dans `backend/.env`, le code s'affiche dans le terminal du
> backend** — c'est le mode de secours prévu pour cela :
>
> ```
> WARN [MailService] BREVO_API_KEY absente — le courriel n'est PAS envoyé
> WARN [MailService]   Message : Votre code de connexion : 482913 | ...
> ```
>
> **C'est le réglage que je recommande pour l'oral** : aucune dépendance au
> réseau, et le code est sous les yeux. Pour montrer un vrai envoi, inscrivez un
> compte avec **votre propre adresse** — là, la clé Brevo est nécessaire.

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

### Acte 0 — l'inscription et la double authentification *(2 min)*

| # | Action | Ce que ça prouve |
|---|---|---|
| 1 | S'inscrire avec **votre propre adresse** | Écran « Compte créé — vérifiez votre boîte » |
| 2 | Tenter de se connecter **sans confirmer** | ❌ Refusé : une adresse non confirmée n'ouvre aucun compte |
| 3 | Ouvrir le lien reçu par courriel | ✅ « Adresse confirmée » |
| 4 | Se connecter : mot de passe accepté | Écran **« Code de connexion »** — *aucune session n'est encore ouverte* |
| 5 | Saisir le code à six chiffres | ✅ Vous entrez |

> **La phrase à dire au point 4 :** le mot de passe seul ne donne plus accès au
> compte. Même volé, il ne suffit pas — il faut aussi la boîte aux lettres.

**Si on vous demande pourquoi six chiffres suffisent** : ce n'est pas la
longueur du code qui protège, c'est **cinq essais par défi et dix minutes de
validité**. Le code est en plus haché en argon2id, pas en SHA-256 — un million
de combinaisons se casserait en millisecondes autrement.

### Acte 1 — le parcours normal *(3 min)*

| # | Action | Ce que ça prouve |
|---|---|---|
| 1 | Déposer un fichier | Le dépôt est chiffré **pendant** le transfert, jamais en clair sur le disque |
| 2 | Cocher **usage unique**, mettre un **mot de passe**, durée **1 h** | Le déposant maîtrise la durée de vie et la protection |
| 3 | Copier le lien, l'ouvrir **en navigation privée** | **Le destinataire n'a pas de compte** — c'est le cœur du produit |
| 4 | Avant le mot de passe, regarder l'écran | **Aucun nom de fichier n'est divulgué** |
| 5 | Saisir le mot de passe, télécharger | Le fichier arrive intact |
| 6 | Recharger le lien | « Lien épuisé » — consommé, fichiers effacés du serveur |
| 7 | Revenir sur **« Mes fichiers »** | Le fichier a disparu : la donnée ne survit pas à sa transmission |

> La navigation privée n'est pas un détail de mise en scène : elle prouve qu'il
> n'y a **aucune session** derrière le téléchargement.

**Le point 4 mérite qu'on s'y arrête** : tant que le mot de passe n'est pas
donné, le serveur ne dit même pas *comment s'appellent* les fichiers.

### Acte 2 — le contrôle d'accès *(2 min)*

| # | Action | Résultat attendu |
|---|---|---|
| 8 | Créer un lien sur un fichier, l'ouvrir, puis le **révoquer** depuis **« Mes liens »** | Recharger la page du destinataire : accès coupé **immédiatement** |
| 9 | Regarder l'onglet **« Mes liens »** | Les états sont distingués : Actif, **Consommé**, Expiré, **Révoqué** |
| 10 | Faire remarquer qu'aucun lien n'y est réaffiché | Le serveur n'en garde qu'une **empreinte SHA-256** — il en est incapable |
| 11 | Se connecter en `bob@filemoica.fr` | Sa liste de fichiers est **vide** — il ne voit pas ceux d'Alice |
| 12 | Se connecter en `admin@filemoica.fr`, ouvrir le panneau | Comptes, offres, quotas |
| 13 | Passer Alice en **offre payante** | Son quota passe de 200 Mo à 20 Go |
| 14 | Cliquer **« Déconnecter partout »** sur un compte | « N sessions coupées » |

> **Au point 14, la nuance qui fait la différence :** cette action révoque les
> jetons de *renouvellement*. La session en cours reste valable **jusqu'à 15
> minutes** — les jetons d'accès sont autoportants, le serveur n'en tient pas la
> liste. Ce qui est **instantané**, c'est le retrait du rôle : il est relu en
> base à chaque appel.
>
> Face à un compte compromis : **« Retirer admin » d'abord**, puis déconnecter.

> **La phrase à dire au point 12 :** un administrateur gère des **comptes**,
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

- **324 tests** au vert (140 unitaires, 184 de bout en bout)
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

- [ ] `npm install` fait dans **frontend**
- [ ] `backend/.env` rempli, avec `FRONTEND_ORIGIN=http://localhost:3001`
- [ ] **Décidé pour les courriels** : clé Brevo renseignée (envoi réel) *ou* laissée vide (code dans le terminal)
- [ ] `npm run db:up` → base démarrée
- [ ] `npm run build` puis `npm run seed` → 3 comptes créés **et confirmés**
- [ ] Backend sur 3000, frontend sur 3001, `/health` répond `200`
- [ ] **Le terminal du backend est visible** — c'est là que s'affiche le code de connexion
- [ ] Une connexion de démonstration **déjà répétée une fois** : le code à six chiffres surprend la première fois
- [ ] Un onglet de **navigation privée** déjà ouvert, pour l'acte 1
- [ ] Un fichier de test sous la main (un PDF ou une image, pas un fichier vide)
