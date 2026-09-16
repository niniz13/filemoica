# syntax=docker/dockerfile:1

# =============================================================================
# Image du frontend filemoica (Next.js).
#
# Construction en plusieurs étapes, à l'image de `backend/Dockerfile` :
# l'outillage — TypeScript, Next.js CLI — produit `.next/standalone` puis
# disparaît. L'image finale ne contient que le serveur autonome généré par
# `output: "standalone"` (voir next.config.ts) et ses dépendances tracées,
# jamais le node_modules complet.
#
#   docker build -t filemoica-frontend .
#
# NEXT_PUBLIC_API_URL est inlinée dans le bundle **au moment du build**, pas au
# démarrage : changer cette valeur exige de reconstruire l'image.
# =============================================================================

ARG NODE_IMAGE=node:24-alpine

# --- Étape 1 : dépendances ---------------------------------------------------
FROM ${NODE_IMAGE} AS deps

WORKDIR /app

COPY package.json package-lock.json ./

# `--ignore-scripts` : le frontend n'a pas de postinstall, mais aucune raison
# de laisser une dépendance tierce en exécuter un pendant la construction.
RUN npm ci --ignore-scripts


# --- Étape 2 : compilation ---------------------------------------------------
FROM deps AS builder

WORKDIR /app

# Url de l'API telle que le navigateur du visiteur doit la joindre — jamais le
# nom du service Docker, qui ne veut rien dire hors du réseau interne.
ARG NEXT_PUBLIC_API_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}

COPY . .

RUN npm run build


# --- Étape 3 : image finale --------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="filemoica-frontend" \
      org.opencontainers.image.description="Interface web de filemoica (Next.js)"

# `tini` comme PID 1, pour les mêmes raisons que côté backend : sans lui,
# `docker stop` attendrait dix secondes avant de trancher au lieu de laisser
# Next.js fermer proprement ses connexions sur SIGTERM.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0

WORKDIR /app

# Le serveur autonome n'a besoin que de ces trois éléments : le traçage de
# `output: "standalone"` a déjà réduit node_modules au strict nécessaire.
COPY --from=builder --chown=root:root /app/.next/standalone ./
COPY --from=builder --chown=root:root /app/.next/static ./.next/static
COPY --from=builder --chown=root:root /app/public ./public

# L'image officielle fournit `node` (uid 1000), sans privilèges — même compte
# que le backend, pour la même raison : un accès obtenu dans le conteneur ne
# donne pas root dedans.
USER node

EXPOSE 3001

# Sonde en `fetch` natif plutôt qu'un client HTTP dédié, comme côté backend.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]

CMD ["node", "server.js"]
