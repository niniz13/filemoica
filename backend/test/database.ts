import request from 'supertest';
import { PasswordService } from '../src/auth/password.service';
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
 * Ouvre une session complète : identifiants, puis second facteur.
 *
 * Le code à six chiffres n'existe qu'en clair dans le courriel — on ne peut
 * donc pas le relire en base, seule son empreinte argon2id y figure. Plutôt
 * que d'intercepter l'envoi, on court-circuite le défi en base : la session
 * s'ouvre comme si le bon code avait été donné.
 *
 * Le parcours réel du second facteur, lui, est éprouvé dans `auth.e2e-spec.ts`
 * avec un vrai code, en remplaçant l'empreinte par celle d'un code connu.
 */
export async function ouvrirSession(
  app: { getHttpServer: () => unknown },
  prisma: PrismaService,
  email: string,
  password: string,
): Promise<string[]> {
  const CSRF: [string, string] = ['X-Requested-With', 'XMLHttpRequest'];

  const defi = await request(app.getHttpServer() as never)
    .post('/api/auth/login')
    .set(...CSRF)
    .send({ email, password })
    .expect(200);

  const challengeId = defi.body.challengeId as string;

  // On remplace l'empreinte du code par celle d'un code connu, puis on joue la
  // route réelle : tout le chemin est exercé, sauf la lecture du courriel.
  const empreinte = await new PasswordService().hash(CODE_DE_TEST);

  await prisma.mfaChallenge.update({
    where: { id: challengeId },
    data: { codeHash: empreinte },
  });

  const session = await request(app.getHttpServer() as never)
    .post('/api/auth/mfa/verify')
    .set(...CSRF)
    .send({ challengeId, code: CODE_DE_TEST })
    .expect(200);

  return session.get('Set-Cookie') ?? [];
}

/** Code utilisé par les tests pour franchir le second facteur. */
export const CODE_DE_TEST = '123456';
