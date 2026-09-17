import request from 'supertest';
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
      "email_verifications",
      "monthly_usage",
      "shares",
      "files",
      "users"
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Marque une adresse comme confirmée, sans passer par le courriel.
 *
 * La connexion est refusée tant que l'adresse ne l'est pas. Faire dépendre
 * toute la suite d'un envoi réel de courriel la rendrait lente, non
 * reproductible, et dépendante du réseau — on confirme donc en base.
 *
 * Le parcours de confirmation lui-même est éprouvé séparément, dans
 * `auth.e2e-spec.ts`, avec un vrai jeton.
 */
export async function confirmerAdresse(
  prisma: PrismaService,
  email: string,
): Promise<void> {
  await prisma.user.updateMany({
    where: { email: email.trim().toLowerCase() },
    data: { emailVerifiedAt: new Date() },
  });
}

/**
 * Ouvre une session et rend les cookies.
 *
 * Le second facteur est **désactivé par défaut** sur un compte neuf : une
 * connexion ordinaire pose donc directement les cookies, et les tests qui ont
 * seulement besoin d'être authentifiés n'ont pas à jouer de défi.
 *
 * Le parcours avec second facteur est éprouvé séparément dans
 * `auth.e2e-spec.ts`, sur un compte où il a été explicitement activé.
 */
export async function ouvrirSession(
  app: { getHttpServer: () => unknown },
  email: string,
  password: string,
): Promise<string[]> {
  const session = await request(app.getHttpServer() as never)
    .post('/api/auth/login')
    .set('X-Requested-With', 'XMLHttpRequest')
    .send({ email, password })
    .expect(200);

  return session.get('Set-Cookie') ?? [];
}

/**
 * Code utilisé par les tests pour franchir le second facteur.
 *
 * Le code réel n'existe en clair que dans le courriel : la base n'en garde que
 * l'empreinte argon2id. Les tests réécrivent donc l'empreinte avec celle de ce
 * code, puis jouent la vraie route de vérification.
 */
export const CODE_DE_TEST = '123456';
