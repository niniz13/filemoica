import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Vide toutes les tables entre deux tests.
 *
 * Les tests end-to-end d'authentification tournent contre une **vraie** base
 * (`filemoica_test`), pas contre un double : c'est le seul moyen de prouver que
 * les contraintes d'unicité, les clés étrangères et les suppressions en cascade
 * se comportent comme prévu. En contrepartie, chaque test doit repartir d'un
 * état propre, sans quoi l'ordre d'exécution influencerait les résultats.
 *
 * `TRUNCATE ... CASCADE` plutôt qu'une suite de `deleteMany` : une seule
 * requête, et l'ordre des dépendances entre tables n'a pas à être maintenu à la
 * main au fil des évolutions du schéma.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "revoked_access_tokens",
      "refresh_tokens",
      "shares",
      "files",
      "users"
    RESTART IDENTITY CASCADE
  `);
}
