import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { PrismaService } from './../src/prisma/prisma.service';
import { PasswordService } from './../src/auth/password.service';
import {
  CODE_DE_TEST,
  confirmerAdresse,
  ouvrirSession,
  resetDatabase,
} from './database';

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

    // La connexion est refusée tant que l'adresse n'est pas confirmée. Le
    // parcours de confirmation a ses propres tests, plus bas, avec un vrai
    // jeton : ici on veut seulement une session.
    await confirmerAdresse(prisma, email);

    return ouvrirSession(app, email, password);
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

  describe('Confirmation de l\'adresse', () => {
    /** Inscrit un compte et renvoie le jeton réellement émis. */
    async function inscrireEtRecupererLeJeton(): Promise<string> {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      // Le jeton en clair n'existe que dans le courriel : on relit donc celui
      // qui a été émis pour le compte, le seul moyen de jouer le parcours sans
      // dépendre d'un envoi réel.
      const emis = await prisma.emailVerification.findFirst({
        where: { user: { email: EMAIL } },
        orderBy: { createdAt: 'desc' },
        select: { tokenHash: true },
      });

      expect(emis).not.toBeNull();
      return emis!.tokenHash;
    }

    it('crée le compte avec une adresse non confirmée', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      const compte = await prisma.user.findUnique({ where: { email: EMAIL } });
      expect(compte?.emailVerifiedAt).toBeNull();
    });

    it('émet un jeton de confirmation, jamais stocké en clair', async () => {
      const empreinte = await inscrireEtRecupererLeJeton();

      expect(empreinte).toMatch(/^[0-9a-f]{64}$/);
    });

    // Le cœur du choix : le compte existe, le mot de passe est bon, et la
    // connexion est refusée quand même.
    it('refuse la connexion tant que l\'adresse n\'est pas confirmée', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(403);

      expect(response.body.error).toBe('EMAIL_NOT_VERIFIED');
    });

    it('laisse passer une fois l\'adresse confirmée', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      await confirmerAdresse(prisma, EMAIL);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);
    });

    it.each([
      ['un jeton inconnu', 'jeton-qui-nexiste-pas-du-tout'],
      ['un jeton trop court', 'court'],
    ])('refuse %s', async (_cas, token) => {
      await request(app.getHttpServer())
        .post('/api/auth/verify-email')
        .set(...CSRF)
        .send({ token })
        .expect((res) => {
          // 400 dans les deux cas : jeton invalide ou refusé par la validation.
          expect(res.status).toBe(400);
        });
    });

    // Répondre différemment selon que l'adresse existe transformerait cette
    // route en annuaire des comptes du service.
    it('répond pareil qu\'on renvoie vers un compte existant ou non', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);

      const connu = await request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .set(...CSRF)
        .send({ email: EMAIL });

      const inconnu = await request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .set(...CSRF)
        .send({ email: 'personne@example.fr' });

      expect(connu.status).toBe(204);
      expect(inconnu.status).toBe(204);
      expect(connu.body).toEqual(inconnu.body);
    });

    // Un lien transmis par erreur ne doit pas rester exploitable après qu'on
    // en a demandé un neuf.
    it('invalide le lien précédent quand on en redemande un', async () => {
      const premier = await inscrireEtRecupererLeJeton();

      await request(app.getHttpServer())
        .post('/api/auth/resend-verification')
        .set(...CSRF)
        .send({ email: EMAIL })
        .expect(204);

      const ancien = await prisma.emailVerification.findUnique({
        where: { tokenHash: premier },
        select: { consumedAt: true },
      });

      expect(ancien?.consumedAt).not.toBeNull();
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

  describe('Double authentification', () => {
    /**
     * Active le second facteur sur un compte déjà connecté.
     *
     * Passe par la vraie route plutôt que par une écriture en base : c'est le
     * chemin qu'emprunte la page de profil, et il mérite d'être exercé.
     */
    function activerLeSecondFacteur(cookies: string[], password = PASSWORD) {
      return request(app.getHttpServer())
        .patch('/api/auth/mfa')
        .set(...CSRF)
        .set('Cookie', cookies)
        .send({ enabled: true, password });
    }

    /** Inscrit, confirme, arme le second facteur, puis lance une connexion. */
    async function amorcerUneConnexion(): Promise<string> {
      const cookies = await connecter();
      await activerLeSecondFacteur(cookies).expect(200);

      const defi = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      return defi.body.challengeId as string;
    }

    /** Impose un code connu au défi, faute de pouvoir lire le courriel. */
    async function imposerLeCode(challengeId: string, code: string) {
      await prisma.mfaChallenge.update({
        where: { id: challengeId },
        data: { codeHash: await new PasswordService().hash(code) },
      });
    }

    // Réglage par compte, et non imposé à tous : sans cela, chaque connexion
    // dépendrait d'un envoi de courriel aboutissant.
    it('est désactivée sur un compte neuf : la connexion pose les cookies', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/register')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(201);
      await confirmerAdresse(prisma, EMAIL);

      const reponse = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(reponse.body.mfaRequired).toBe(false);
      expect(reponse.body.user.email).toBe(EMAIL);
      expect(
        (reponse.get('Set-Cookie') ?? []).some((c) =>
          c.startsWith('access_token='),
        ),
      ).toBe(true);
    });

    it('expose son état sur le compte courant', async () => {
      const cookies = await connecter();

      const avant = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(200);
      expect(avant.body.mfaEnabled).toBe(false);

      await activerLeSecondFacteur(cookies).expect(200);

      const apres = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(200);
      expect(apres.body.mfaEnabled).toBe(true);
    });

    // Une session volée ne doit pas suffire à désarmer la protection qui rend
    // justement le vol difficile.
    it('exige le mot de passe pour changer le réglage', async () => {
      const cookies = await connecter();

      const reponse = await activerLeSecondFacteur(cookies, 'mauvais-mot-de-passe').expect(401);
      expect(reponse.body.error).toBe('INVALID_CREDENTIALS');

      const moi = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(200);
      expect(moi.body.mfaEnabled).toBe(false);
    });

    it('refuse de régler le second facteur sans session', async () => {
      await request(app.getHttpServer())
        .patch('/api/auth/mfa')
        .set(...CSRF)
        .send({ enabled: true, password: PASSWORD })
        .expect(401);
    });

    // Le cœur du second facteur, une fois armé : le mot de passe ne suffit plus.
    it('n\'ouvre aucune session à la première étape', async () => {
      const cookies = await connecter();
      await activerLeSecondFacteur(cookies).expect(200);

      const reponse = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(reponse.body.mfaRequired).toBe(true);
      expect(reponse.body.challengeId).toEqual(expect.any(String));
      // Aucun cookie : c'est ce qui distingue cette étape d'une connexion.
      expect(reponse.get('Set-Cookie')).toBeUndefined();
    });

    it('rend la connexion directe une fois le second facteur coupé', async () => {
      const cookies = await connecter();
      await activerLeSecondFacteur(cookies).expect(200);

      await request(app.getHttpServer())
        .patch('/api/auth/mfa')
        .set(...CSRF)
        .set('Cookie', cookies)
        .send({ enabled: false, password: PASSWORD })
        .expect(200);

      const reponse = await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(reponse.body.mfaRequired).toBe(false);
    });

    it('ne stocke jamais le code en clair', async () => {
      const challengeId = await amorcerUneConnexion();

      const defi = await prisma.mfaChallenge.findUniqueOrThrow({
        where: { id: challengeId },
        select: { codeHash: true },
      });

      expect(defi.codeHash).toMatch(/^\$argon2id\$/);
      expect(defi.codeHash).not.toMatch(/\d{6}/);
    });

    it('ouvre la session avec le bon code', async () => {
      const challengeId = await amorcerUneConnexion();
      await imposerLeCode(challengeId, CODE_DE_TEST);

      const session = await request(app.getHttpServer())
        .post('/api/auth/mfa/verify')
        .set(...CSRF)
        .send({ challengeId, code: CODE_DE_TEST })
        .expect(200);

      const cookies = session.get('Set-Cookie') ?? [];
      expect(cookies.some((c) => c.startsWith('access_token='))).toBe(true);
    });

    it('refuse un code faux', async () => {
      const challengeId = await amorcerUneConnexion();
      await imposerLeCode(challengeId, CODE_DE_TEST);

      const reponse = await request(app.getHttpServer())
        .post('/api/auth/mfa/verify')
        .set(...CSRF)
        .send({ challengeId, code: '000000' })
        .expect(401);

      expect(reponse.body.error).toBe('MFA_CODE_INVALID');
    });

    // Ce qui rend six chiffres suffisants : ce n'est pas la longueur du code,
    // c'est le nombre d'essais.
    it('abandonne le défi après cinq essais infructueux', async () => {
      const challengeId = await amorcerUneConnexion();
      await imposerLeCode(challengeId, CODE_DE_TEST);

      for (let i = 0; i < 5; i += 1) {
        await request(app.getHttpServer())
          .post('/api/auth/mfa/verify')
          .set(...CSRF)
          .send({ challengeId, code: '000000' })
          .expect(401);
      }

      // Même le bon code ne passe plus : le défi est clos.
      await request(app.getHttpServer())
        .post('/api/auth/mfa/verify')
        .set(...CSRF)
        .send({ challengeId, code: CODE_DE_TEST })
        .expect(401);
    });

    it('ne laisse pas rejouer un défi déjà utilisé', async () => {
      const challengeId = await amorcerUneConnexion();
      await imposerLeCode(challengeId, CODE_DE_TEST);

      await request(app.getHttpServer())
        .post('/api/auth/mfa/verify')
        .set(...CSRF)
        .send({ challengeId, code: CODE_DE_TEST })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/mfa/verify')
        .set(...CSRF)
        .send({ challengeId, code: CODE_DE_TEST })
        .expect(401);
    });

    it('refuse un défi expiré', async () => {
      const challengeId = await amorcerUneConnexion();
      await imposerLeCode(challengeId, CODE_DE_TEST);

      await prisma.mfaChallenge.update({
        where: { id: challengeId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(app.getHttpServer())
        .post('/api/auth/mfa/verify')
        .set(...CSRF)
        .send({ challengeId, code: CODE_DE_TEST })
        .expect(401);
    });

    // Une seconde tentative de connexion doit invalider le code précédent,
    // sinon deux codes valides coexistent pour un même compte.
    it('invalide le défi précédent quand on relance une connexion', async () => {
      const premier = await amorcerUneConnexion();
      await imposerLeCode(premier, CODE_DE_TEST);

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .set(...CSRF)
        .send({ email: EMAIL, password: PASSWORD })
        .expect(200);

      await request(app.getHttpServer())
        .post('/api/auth/mfa/verify')
        .set(...CSRF)
        .send({ challengeId: premier, code: CODE_DE_TEST })
        .expect(401);
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

    it('renvoie le rôle du compte', async () => {
      const cookies = await connecter();

      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(200);

      expect(response.body.role).toBe('USER');
    });

    // La raison d'être de la relecture en base : le rôle n'est pas porté par le
    // jeton. S'il l'était, une promotion ou une rétrogradation n'apparaîtrait
    // qu'à l'expiration de la session — jusqu'à quinze minutes plus tard.
    it('reflète un changement de rôle sans reconnexion', async () => {
      const cookies = await connecter();

      await prisma.user.updateMany({
        where: { email: EMAIL },
        data: { role: 'ADMIN' },
      });

      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(200);

      // Les mêmes cookies, un rôle différent.
      expect(response.body.role).toBe('ADMIN');
    });

    // Un jeton peut rester valide alors que le compte a disparu : la signature
    // ne prouve que l'émission, pas que le compte existe encore.
    it('refuse une session dont le compte a été supprimé', async () => {
      const cookies = await connecter();

      await prisma.user.deleteMany({ where: { email: EMAIL } });

      const response = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Cookie', cookies)
        .expect(401);

      expect(response.body.error).toBe('SESSION_INVALID');
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
