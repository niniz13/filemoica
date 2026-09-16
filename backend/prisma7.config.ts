import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Configuration de l'outillage Prisma (migrations, génération du client).
 *
 * Depuis Prisma 7, le fichier `.env` n'est plus lu automatiquement : d'où
 * l'import explicite de `dotenv/config` en première ligne. Sans lui,
 * `DATABASE_URL` serait vide et les migrations échoueraient sans raison visible.
 *
 * Ce fichier ne concerne que la ligne de commande. L'application, elle, lit sa
 * configuration via `ConfigModule` et la valide au démarrage.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'],
  },
});
