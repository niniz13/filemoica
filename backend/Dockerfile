# syntax=docker/dockerfile:1

# =============================================================================
# Image du backend filemoica.
#
# Construction en plusieurs étapes : l'outillage de compilation — TypeScript,
# CLI NestJS, CLI Prisma — produit `dist/` puis disparaît. L'image finale ne
# contient que du code compilé, les dépendances de production et un utilisateur
# sans privilèges. Ce n'est pas qu'une question de taille : tout binaire présent
# dans l'image est un outil offert à qui obtiendrait un shell dedans.
#
#   docker build -t filemoica-backend .
#   docker build -t filemoica-migrations --target migrations .
#
# Voir `docs/exploitation.md` pour l'exécution et les options de durcissement.
# =============================================================================

# Node 24 est imposé par NestJS 12, distribué uniquement en ESM.
#
# Alpine est sans risque ici, ce qui n'allait pas de soi : les deux dépendances
# natives du projet ont été vérifiées. `@node-rs/argon2` publie un binaire musl
# (`@node-rs/argon2-linux-x64-musl`), et le client Prisma est généré en
# TypeScript pur — l'accès à la base passe par l'adaptateur `pg`, donc aucun
# moteur natif à charger. C'est ce second point qui écarte le piège habituel
# d'Alpine avec Prisma (OpenSSL, glibc).
#
# En production, remplacer ce tag par une empreinte (`node:24-alpine@sha256:…`)
# pour que deux constructions à un mois d'écart partent du même octet près.
ARG NODE_IMAGE=node:24-alpine

# Version applicative exposée par `/health`. À renseigner au déploiement avec le
# tag git, pour pouvoir vérifier quelle version tourne réellement.
ARG APP_VERSION=dev


# --- Étape 1 : dépendances ---------------------------------------------------
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# `npm ci` et non `npm install` : la construction est reproductible et ne peut
# pas remonter silencieusement une version de dépendance.
#
# `--ignore-scripts` neutralise les scripts d'installation des paquets tiers.
# Sans lui, n'importe quelle dépendance — ou dépendance de dépendance —
# exécuterait du code arbitraire pendant la construction, avec accès au réseau.
# Le `postinstall` du projet (`prisma generate`) est donc relancé explicitement
# à l'étape suivante.
RUN npm ci --ignore-scripts


# --- Étape 2 : compilation ---------------------------------------------------
FROM deps AS builder

WORKDIR /app

COPY prisma7.config.ts ./
COPY prisma ./prisma
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

# `prisma generate` n'ouvre aucune connexion, mais la configuration exige une
# URL. Celle-ci est un mannequin, valable le temps de la commande : l'étape est
# jetée avant l'image finale et cette valeur ne s'y retrouve pas.
RUN DATABASE_URL="postgresql://build:build@127.0.0.1:5432/build" \
    npx prisma generate

RUN npm run build


# --- Étape 3 : dépendances de production ------------------------------------
# Réinstallation à part plutôt que `npm prune` : on repart du verrou, sans
# risque qu'un résidu de l'étape de construction se glisse dans l'image finale.
FROM ${NODE_IMAGE} AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force


# --- Étape 4 : migrations (image jetable) -----------------------------------
#
# Volontairement séparée de l'image applicative : les migrations sont un acte
# d'administration, pas un effet de bord du démarrage. Deux instances qui
# démarrent ensemble ne se disputent pas le schéma, et une migration qui échoue
# se voit immédiatement au lieu d'être noyée dans les journaux de démarrage.
#
# **L'intérêt est dans les droits, pas dans l'absence d'outil.** Seule cette
# image embarque les fichiers de migration ; en revanche la CLI Prisma est, elle,
# présente dans les deux — depuis Prisma 7, `@prisma/client` en dépend, elle
# arrive donc avec les dépendances de production, qu'on le veuille ou non.
# Ce qui protège vraiment le schéma, c'est de donner à cette image un compte
# PostgreSQL habilité au DDL et à l'application un compte qui ne l'est pas :
# l'outil devient alors sans effet faute de privilèges. C'est à poser côté SRC,
# et c'est la seule barrière qui tienne.
#
#   docker run --rm --env-file .env filemoica-migrations
FROM builder AS migrations

USER node

CMD ["npx", "prisma", "migrate", "deploy"]


# --- Étape 5 : image finale --------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG APP_VERSION

LABEL org.opencontainers.image.title="filemoica-backend" \
      org.opencontainers.image.description="Service de transfert de fichiers chiffrés" \
      org.opencontainers.image.version="${APP_VERSION}"

# `tini` comme PID 1. Un processus PID 1 n'hérite d'aucune action par défaut
# pour les signaux : si l'application ne gère pas elle-même SIGTERM, `docker
# stop` reste sans effet pendant dix secondes, puis SIGKILL tranche net. Sur un
# dépôt en cours, cela laisse un fichier à moitié écrit sur le disque.
# NestJS gère bien SIGTERM (voir `enableShutdownHooks` dans `main.ts`) ; `tini`
# garantit le comportement même si cet appel disparaissait un jour.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3000 \
    APP_VERSION=${APP_VERSION} \
    STORAGE_PATH=/var/lib/filemoica/storage

WORKDIR /app

# Le code appartient à `root` et l'application tourne en `node` : elle peut lire
# ses propres fichiers, jamais les réécrire. Une exécution de code arbitraire ne
# peut donc pas se rendre persistante en modifiant `dist/`.
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=builder   --chown=root:root /app/dist ./dist
COPY                  --chown=root:root package.json ./

# Le seul répertoire inscriptible, et le seul qui appartienne à `node`.
# 0700 : le contenu est déjà chiffré, mais rien ne justifie qu'un autre compte
# du conteneur puisse le lire.
RUN install -d -o node -g node -m 0700 "${STORAGE_PATH}"

# L'image officielle fournit `node` (uid 1000), sans privilèges. Tout ce qui
# suit s'exécute sous ce compte : un dépassement dans le traitement d'un fichier
# déposé ne donne pas root dans le conteneur.
USER node

EXPOSE 3000

# Sonde écrite avec le `fetch` natif de Node plutôt qu'avec `curl` : cela évite
# d'installer un client HTTP complet pour trois lignes. À noter tout de même —
# l'image de base apporte déjà `wget` et `nc` par BusyBox, ainsi que `npm` : la
# surface n'est pas nulle, elle est seulement inchangée.
#
# `start-period` laisse le temps à la connexion PostgreSQL de s'établir : sans
# lui, le conteneur serait déclaré malade pendant son démarrage normal.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

# `node` directement, pas `npm start` : npm resterait un processus
# intermédiaire qui ne retransmet pas proprement les signaux, et ajouterait un
# gestionnaire de paquets complet à la surface d'attaque de l'exécution.
CMD ["node", "dist/main.js"]
