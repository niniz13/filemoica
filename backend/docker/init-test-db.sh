#!/bin/bash
# Crée la base dédiée aux tests, à côté de la base de développement.
#
# Exécuté une seule fois, au tout premier démarrage du volume PostgreSQL.
# Séparer les deux bases évite qu'un test qui vide les tables n'efface les
# données sur lesquelles on est en train de travailler.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE DATABASE ${POSTGRES_DB}_test;
  GRANT ALL PRIVILEGES ON DATABASE ${POSTGRES_DB}_test TO $POSTGRES_USER;
EOSQL
