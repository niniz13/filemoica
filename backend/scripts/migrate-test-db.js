/**
 * Applique les migrations sur la base de test.
 *
 * Les tests end-to-end d'authentification tournent contre une vraie base
 * PostgreSQL : sans migrations à jour, ils échouent sur des tables absentes.
 *
 * Ce script existe pour une raison de portabilité : passer une variable
 * d'environnement en ligne avant une commande (`DATABASE_URL=... npx prisma`)
 * fonctionne sur un shell POSIX mais pas sur PowerShell. Le faire en Node donne
 * la même commande pour tout le monde, y compris en intégration continue.
 *
 * L'URL de test est dérivée de `DATABASE_URL` en suffixant le nom de la base
 * par `_test`, cohérent avec la base créée au démarrage du conteneur.
 */
const { spawnSync } = require('node:child_process');

require('dotenv').config();

const url = process.env.DATABASE_URL;

if (!url) {
  console.error(
    'DATABASE_URL absente. Copier .env.example en .env avant de lancer ce script.',
  );
  process.exit(1);
}

const testUrl = new URL(url);
testUrl.pathname = `${testUrl.pathname}_test`;

console.log(`Migrations sur la base de test : ${testUrl.pathname.slice(1)}`);

const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], {
  stdio: 'inherit',
  // `shell: true` est nécessaire sous Windows, où `npx` est un script `.cmd`
  // que Node ne sait pas lancer directement.
  shell: true,
  env: { ...process.env, DATABASE_URL: testUrl.toString() },
});

process.exit(result.status ?? 1);
