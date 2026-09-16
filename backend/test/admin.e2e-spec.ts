import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { PrismaService } from './../src/prisma/prisma.service';
import { resetDatabase } from './database';

const PASSWORD = 'phrase-de-passe-suffisamment-longue';
const ADMIN = 'admin@example.fr';
const ALICE = 'alice@example.fr';

/**
 * Panneau d'administration.
 *
 * Deux garanties à prouver, et elles sont de nature différente :
 *
 * 1. **Le cloisonnement par rôle** — un compte ordinaire ne franchit aucune de
 *    ces routes, même avec une session parfaitement valide.
 * 2. **La frontière contenu/comptes** — un administrateur gère des comptes, et
 *    n'a aucun chemin vers les fichiers d'autrui.
 */
describe('Administration (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Inscrit et connecte un compte, et renvoie ses cookies et son identifiant. */
  async function connecter(
    email: string,
  ): Promise<{ cookies: string[]; id: string }> {
    const inscription = await request(app.getHttpServer())
      .post('/api/auth/register')
      .set(...CSRF)
      .send({ email, password: PASSWORD })
      .expect(201);

    const connexion = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email, password: PASSWORD })
      .expect(200);

    return {
      cookies: connexion.get('Set-Cookie') ?? [],
      id: inscription.body.id,
    };
  }

  /** Connecte un compte puis le promeut administrateur en base. */
  async function connecterAdministrateur(): Promise<{
    cookies: string[];
    id: string;
  }> {
    const compte = await connecter(ADMIN);

    await prisma.user.update({
      where: { id: compte.id },
      data: { role: 'ADMIN' },
    });

    // Reconnexion inutile : le rôle est relu en base à chaque appel, pas porté
    // par le jeton. C'est précisément ce qui rend le retrait immédiat.
    return compte;
  }

  describe('Cloisonnement par rôle', () => {
    // Le test central : une session valide ne suffit pas.
    it.each([
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/stats'],
    ])('refuse %s %s à un compte ordinaire — 403', async (_methode, route) => {
      const alice = await connecter(ALICE);

      const response = await request(app.getHttpServer())
        .get(route)
        .set('Cookie', alice.cookies)
        .expect(403);

      expect(response.body.error).toBe('INSUFFICIENT_ROLE');
    });

    it('refuse une modification d\'offre à un compte ordinaire', async () => {
      const alice = await connecter(ALICE);

      await request(app.getHttpServer())
        .patch(`/api/admin/users/${alice.id}/plan`)
        .set(...CSRF)
        .set('Cookie', alice.cookies)
        .send({ plan: 'PREMIUM' })
        .expect(403);

      // Et le compte n'a pas changé d'offre au passage.
      const user = await prisma.user.findUniqueOrThrow({
        where: { id: alice.id },
      });
      expect(user.plan).toBe('FREE');
    });

    it('refuse un accès sans session — 401', async () => {
      await request(app.getHttpServer()).get('/api/admin/users').expect(401);
    });

    it('laisse passer un administrateur', async () => {
      const admin = await connecterAdministrateur();

      await request(app.getHttpServer())
        .get('/api/admin/users')
        .set('Cookie', admin.cookies)
        .expect(200);
    });

    // Le rôle étant relu en base, un retrait prend effet sans attendre
    // l'expiration de la session.
    it('coupe l\'accès dès le retrait du rôle, sans reconnexion', async () => {
      const admin = await connecterAdministrateur();

      await request(app.getHttpServer())
        .get('/api/admin/users')
        .set('Cookie', admin.cookies)
        .expect(200);

      await prisma.user.update({
        where: { id: admin.id },
        data: { role: 'USER' },
      });

      // Même cookie, même session : l'accès est déjà refusé.
      await request(app.getHttpServer())
        .get('/api/admin/users')
        .set('Cookie', admin.cookies)
        .expect(403);
    });
  });

  describe('Frontière entre comptes et contenu', () => {
    // La garantie qui rend la promesse de confidentialité défendable.
    it('ne divulgue aucun nom de fichier', async () => {
      const alice = await connecter(ALICE);

      await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', alice.cookies)
        .attach('file', Buffer.from('Contenu privé.', 'utf8'), 'secret.txt')
        .expect(201);

      const admin = await connecterAdministrateur();

      const response = await request(app.getHttpServer())
        .get('/api/admin/users')
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('secret.txt');
      // Le décompte, lui, est bien là.
      const compteAlice = (response.body as { email: string; fileCount: number }[]).find(
        (u) => u.email === ALICE,
      );
      expect(compteAlice?.fileCount).toBe(1);
    });

    it('ne donne à l\'administrateur aucun accès aux fichiers d\'autrui', async () => {
      const alice = await connecter(ALICE);

      const depot = await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', alice.cookies)
        .attach('file', Buffer.from('Contenu privé.', 'utf8'), 'secret.txt')
        .expect(201);

      const admin = await connecterAdministrateur();

      // Les routes de fichiers restent cloisonnées par propriétaire : le rôle
      // d'administrateur n'y change rien.
      const liste = await request(app.getHttpServer())
        .get('/api/files')
        .set('Cookie', admin.cookies)
        .expect(200);
      expect(liste.body).toEqual([]);

      await request(app.getHttpServer())
        .delete(`/api/files/${depot.body.id}`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .expect(404);
    });
  });

  describe('Gestion des offres', () => {
    it('bascule un compte en offre payante', async () => {
      const alice = await connecter(ALICE);
      const admin = await connecterAdministrateur();

      const response = await request(app.getHttpServer())
        .patch(`/api/admin/users/${alice.id}/plan`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ plan: 'PREMIUM' })
        .expect(200);

      expect(response.body.plan).toBe('PREMIUM');
      // Le quota affiché suit immédiatement l'offre.
      expect(response.body.quotaBytes).toBe(5 * 1024 * 1024);
    });

    it('ramène un compte en offre gratuite', async () => {
      const alice = await connecter(ALICE);
      const admin = await connecterAdministrateur();

      await prisma.user.update({
        where: { id: alice.id },
        data: { plan: 'PREMIUM' },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/admin/users/${alice.id}/plan`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ plan: 'FREE' })
        .expect(200);

      expect(response.body.plan).toBe('FREE');
    });

    it('refuse une offre inconnue', async () => {
      const alice = await connecter(ALICE);
      const admin = await connecterAdministrateur();

      await request(app.getHttpServer())
        .patch(`/api/admin/users/${alice.id}/plan`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ plan: 'ILLIMITE' })
        .expect(400);
    });

    it('refuse un compte inexistant', async () => {
      const admin = await connecterAdministrateur();

      const response = await request(app.getHttpServer())
        .patch('/api/admin/users/3f2b8c1e-9d4a-4f6b-8e2c-7a1d5b3c9e0f/plan')
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ plan: 'PREMIUM' })
        .expect(404);

      expect(response.body.error).toBe('USER_NOT_FOUND');
    });
  });

  describe('Gestion des rôles', () => {
    it('promeut un compte administrateur', async () => {
      const alice = await connecter(ALICE);
      const admin = await connecterAdministrateur();

      const response = await request(app.getHttpServer())
        .patch(`/api/admin/users/${alice.id}/role`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ role: 'ADMIN' })
        .expect(200);

      expect(response.body.role).toBe('ADMIN');

      // Et Alice accède désormais au panneau.
      await request(app.getHttpServer())
        .get('/api/admin/users')
        .set('Cookie', alice.cookies)
        .expect(200);
    });

    // Sans ce garde-fou, le dernier administrateur peut se verrouiller dehors
    // et il faut rouvrir la base à la main pour réparer.
    it('empêche un administrateur de se rétrograder lui-même', async () => {
      const admin = await connecterAdministrateur();

      const response = await request(app.getHttpServer())
        .patch(`/api/admin/users/${admin.id}/role`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ role: 'USER' })
        .expect(400);

      expect(response.body.error).toBe('CANNOT_DEMOTE_SELF');
    });

    it('permet de rétrograder un autre administrateur', async () => {
      const alice = await connecter(ALICE);
      const admin = await connecterAdministrateur();

      await prisma.user.update({
        where: { id: alice.id },
        data: { role: 'ADMIN' },
      });

      await request(app.getHttpServer())
        .patch(`/api/admin/users/${alice.id}/role`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ role: 'USER' })
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/admin/users')
        .set('Cookie', alice.cookies)
        .expect(403);
    });
  });

  describe('Révocation des sessions', () => {
    it('coupe les sessions d\'un compte compromis', async () => {
      const alice = await connecter(ALICE);
      const admin = await connecterAdministrateur();

      const response = await request(app.getHttpServer())
        .post(`/api/admin/users/${alice.id}/revoke-sessions`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .expect(201);

      expect(response.body.revoked).toBe(1);

      // Alice ne peut plus renouveler sa session.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', alice.cookies)
        .expect(401);
    });
  });

  describe('Statistiques', () => {
    it('rend compte de l\'état du service', async () => {
      const alice = await connecter(ALICE);
      await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', alice.cookies)
        .attach('file', Buffer.from('Douze octets', 'utf8'), 'a.txt')
        .expect(201);

      const admin = await connecterAdministrateur();

      // Deux comptes gratuits pour l'instant.
      let response = await request(app.getHttpServer())
        .get('/api/admin/stats')
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(response.body).toMatchObject({
        users: { total: 2, free: 2, premium: 0 },
        files: { total: 1, totalBytes: 12 },
      });

      // La répartition suit le passage d'un compte à l'offre payante.
      await request(app.getHttpServer())
        .patch(`/api/admin/users/${alice.id}/plan`)
        .set(...CSRF)
        .set('Cookie', admin.cookies)
        .send({ plan: 'PREMIUM' })
        .expect(200);

      response = await request(app.getHttpServer())
        .get('/api/admin/stats')
        .set('Cookie', admin.cookies)
        .expect(200);

      expect(response.body.users).toEqual({ total: 2, free: 1, premium: 1 });
    });
  });
});
