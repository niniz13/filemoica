import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { PrismaService } from './../src/prisma/prisma.service';
import { resetDatabase } from './database';

const EMAIL = 'alice@example.fr';
const PASSWORD = 'phrase-de-passe-suffisamment-longue';

/**
 * Parcours d'authentification complet, contre une **vraie** base PostgreSQL.
 *
 * Ces tests constituent la preuve du critère « accès vérifiés » : ils montrent
 * qu'une personne sans autorisation ne peut pas atteindre une ressource
 * protégée, et qu'une session révoquée cesse réellement de fonctionner.
 *
 * **Prérequis :** `npm run db:up` puis les migrations appliquées sur
 * `filemoica_test` (`prisma migrate deploy` avec l'URL de test).
 */
describe('Authentification (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  /** En-tête exigé par la protection CSRF sur toute écriture. */
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

  /** Inscrit puis connecte un compte, et renvoie ses cookies de session. */
  async function connecter(
    email = EMAIL,
    password = PASSWORD,
  ): Promise<string[]> {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set(...CSRF)
      .send({ email, password })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email, password })
      .expect(200);

    return response.get('Set-Cookie') ?? [];
  }

  describe('Inscription', () => {
    it('crée un compte et ne renvoie jamais l\'empreinte du mot de passe', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      expect(response.body).toEqual({
        id: expect.any(String) as unknown as string,
        email: EMAIL,
        role: 'USER',
      });
      expect(JSON.stringify(response.body)).not.toContain('argon2');
    });

    it('stocke une empreinte argon2id, jamais le mot de passe', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      const user = await prisma.user.findUnique({ where: { email: EMAIL } });

      expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
      expect(user?.passwordHash).not.toContain(PASSWORD);
    });

    it('refuse un email déjà utilisé', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(409);

      expect(response.body.error).toBe('EMAIL_ALREADY_USED');
    });

    it('traite l\'email sans tenir compte de la casse', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: 'ALICE@Example.FR', password: PASSWORD })
        .expect(409);
    });

    it.each([
      ['email invalide', { email: 'pas-un-email', password: PASSWORD }],
      ['mot de passe trop court', { email: EMAIL, password: 'court' }],
      ['champ manquant', { email: EMAIL }],
    ])('refuse une inscription avec %s', async (_cas, payload) => {
      const response = await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send(payload)
        .expect(400);

      expect(response.body.error).toBe('VALIDATION_ERROR');
    });

    // `forbidNonWhitelisted` en action : sans lui, un champ inattendu serait
    // ignoré silencieusement au lieu d'être refusé.
    it('refuse un champ non prévu, comme une tentative d\'élévation', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD, role: 'ADMIN' })
        .expect(400);
    });
  });

  describe('Connexion', () => {
    it('pose deux cookies httpOnly et ne renvoie aucun jeton dans le corps', async () => {
      const cookies = await connecter();
      const corps = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      const access = cookies.find((c) => c.startsWith('access_token='));
      const refresh = cookies.find((c) => c.startsWith('refresh_token='));

      expect(access).toContain('HttpOnly');
      expect(access).toContain('SameSite=Strict');
      expect(refresh).toContain('HttpOnly');
      expect(refresh).toContain('Path=/api/auth');
      expect(JSON.stringify(corps.body)).not.toContain('token');
    });

    // Distinguer les deux cas permettrait d'énumérer les comptes du service.
    it.each([
      ['email inconnu', 'inconnu@example.fr', PASSWORD],
      ['mot de passe faux', EMAIL, 'mauvaise-phrase-de-passe-longue'],
    ])('renvoie la même erreur pour %s', async (_cas, email, password) => {
      await connecter();

      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email, password })
        .expect(401);

      expect(response.body).toEqual({
        error: 'INVALID_CREDENTIALS',
        message: 'Email ou mot de passe incorrect.',
      });
    });
  });

  describe('Accès aux routes protégées', () => {
    it('laisse passer une session valide', async () => {
      const cookies = await connecter();

      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(200);

      expect(response.body.email).toBe(EMAIL);
    });

    // Le test central du critère « accès vérifiés ».
    it('refuse une requête sans cookie', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .expect(401);

      expect(response.body.error).toBe('NOT_AUTHENTICATED');
    });

    it.each([
      ['un jeton inventé', 'access_token=nimportequoi'],
      ['un JWT mal formé', 'access_token=aaa.bbb.ccc'],
      [
        'un JWT signé avec une autre clé',
        'access_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhdHRhcXVhbnQifQ.signature-inventee',
      ],
    ])('refuse %s', async (_cas, cookie) => {
      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookie)
        .expect(401);

      expect(response.body.error).toBe('SESSION_INVALID');
    });

    it('ne divulgue rien sur la cause du refus', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', 'access_token=aaa.bbb.ccc');

      expect(JSON.stringify(response.body)).not.toMatch(
        /signature|jwt|malformed|secret/i,
      );
    });
  });

  describe('Déconnexion', () => {
    // La révocation immédiate : sans liste de refus, ce jeton resterait
    // valable jusqu'à 15 minutes après la déconnexion.
    it('rend l\'access token inutilisable immédiatement', async () => {
      const cookies = await connecter();

      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(204);

      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(401);

      expect(response.body.error).toBe('SESSION_INVALID');
    });

    it('révoque aussi le refresh token', async () => {
      const cookies = await connecter();

      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(204);

      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(401);
    });

    it('aboutit même sans session active', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set(...CSRF)
        .expect(204);
    });
  });

  describe('Rotation du refresh token', () => {
    it('échange le refresh token contre un couple neuf', async () => {
      const cookies = await connecter();

      const response = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(200);

      const nouveaux = response.get('Set-Cookie') ?? [];

      expect(nouveaux.some((c) => c.startsWith('access_token='))).toBe(true);
      expect(
        nouveaux.find((c) => c.startsWith('refresh_token=')),
      ).not.toBe(cookies.find((c) => c.startsWith('refresh_token=')));
    });

    it('permet d\'utiliser la session rafraîchie', async () => {
      const cookies = await connecter();

      const refreshed = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(200);

      await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', refreshed.get('Set-Cookie') ?? [])
        .expect(200);
    });

    // Le scénario de vol de jeton, et la réponse : couper toute la lignée.
    it('révoque toute la famille si un refresh token est rejoué', async () => {
      const cookies = await connecter();

      // L'attaquant a copié le refresh token ; la victime s'en sert d'abord.
      const legitime = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(200);

      // L'attaquant rejoue le jeton volé, déjà consommé.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(401);

      // Conséquence : la session de la victime est coupée elle aussi. C'est le
      // prix à payer, mais l'attaquant n'a plus rien non plus.
      await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', legitime.get('Set-Cookie') ?? [])
        .expect(401);

      const actifs = await prisma.refreshToken.count({
        where: { revokedAt: null },
      });
      expect(actifs).toBe(0);
    });

    it('refuse un refresh token inventé', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .set('Cookie', 'refresh_token=jeton-invente')
        .expect(401);

      expect(response.body.error).toBe('REFRESH_REJECTED');
    });

    it('refuse une demande sans refresh token', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/auth/refresh')
        .set(...CSRF)
        .expect(401);

      expect(response.body.error).toBe('NO_REFRESH_TOKEN');
    });
  });

  describe('Protection CSRF sur les routes d\'authentification', () => {
    it('refuse une connexion sans l\'en-tête attendu', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: EMAIL, password: PASSWORD })
        .expect(403);

      expect(response.body.error).toBe('CSRF_HEADER_MISSING');
    });

    it('refuse une déconnexion sans l\'en-tête attendu', async () => {
      const cookies = await connecter();

      await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', cookies)
        .expect(403);
    });
  });

  describe('Stockage en base', () => {
    // Ce qui rend une fuite de la base inexploitable côté sessions.
    it('ne stocke jamais le refresh token en clair', async () => {
      const cookies = await connecter();
      const refreshCookie = cookies.find((c) =>
        c.startsWith('refresh_token='),
      );
      const valeur = refreshCookie?.split('=')[1]?.split(';')[0] ?? '';

      const stockes = await prisma.refreshToken.findMany();

      expect(stockes).toHaveLength(1);
      expect(stockes[0].tokenHash).not.toBe(valeur);
      expect(stockes[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('supprime les sessions quand le compte est supprimé', async () => {
      await connecter();

      await prisma.user.deleteMany({ where: { email: EMAIL } });

      expect(await prisma.refreshToken.count()).toBe(0);
    });
  });
});
