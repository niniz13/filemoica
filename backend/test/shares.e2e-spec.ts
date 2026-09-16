import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { PrismaService } from './../src/prisma/prisma.service';
import { resetDatabase } from './database';

const PASSWORD = 'phrase-de-passe-suffisamment-longue';
const ALICE = 'alice@example.fr';
const BOB = 'bob@example.fr';
const CAROL = 'carol@example.fr';
const CONTENU = 'Contrat signé — montant : 42 000 euros.';

/**
 * Partage, révocation et téléchargement.
 *
 * C'est le parcours complet du service et la démonstration de la soutenance :
 * Alice dépose un fichier, en tire un lien, le transmet — et le destinataire le
 * récupère **sans compte**. Puis Alice révoque, et le lien meurt.
 *
 * Ces tests portent la preuve du critère « accès vérifiés » : chaque refus est
 * vérifié séparément, avec son propre code.
 */
describe('Partages (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;
  const storageRoot = resolve(process.env.STORAGE_PATH ?? './storage-test');

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

  async function connecter(email: string): Promise<string[]> {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set(...CSRF)
      .send({ email, password: PASSWORD })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email, password: PASSWORD })
      .expect(200);

    return response.get('Set-Cookie') ?? [];
  }

  /** Dépose un fichier et renvoie son identifiant. */
  async function deposer(cookies: string[]): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/files')
      .set(...CSRF)
      .set('Cookie', cookies)
      .attach('file', Buffer.from(CONTENU, 'utf8'), 'contrat.txt')
      .expect(201);

    return response.body.id;
  }

  /** Crée un partage et renvoie son identifiant et son jeton. */
  async function partager(
    cookies: string[],
    fileId: string,
    options: {
      recipientEmail?: string;
      expiresInHours?: number;
      password?: string;
      burnAfterDownload?: boolean;
    } = {},
  ): Promise<{ id: string; token: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/shares')
      .set(...CSRF)
      .set('Cookie', cookies)
      .send({ fileId, expiresInHours: 72, ...options })
      .expect(201);

    return { id: response.body.id, token: response.body.token };
  }

  describe('Parcours complet', () => {
    // Le scénario de la démonstration : le destinataire n'a pas de compte et
    // n'en a pas besoin.
    it('un inconnu sans compte télécharge le contenu exact', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      const download = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      expect(download.body.toString('utf8')).toBe(CONTENU);
    });

    it('décrit le lien avant téléchargement, sans compte', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      const info = await request(app.getHttpServer())
        .get(`/api/download/${token}/info`)
        .expect(200);

      expect(info.body).toMatchObject({
        requiresPassword: false,
        fileName: 'contrat.txt',
        sizeBytes: Buffer.byteLength(CONTENU, 'utf8'),
      });
    });

    it('force l\'enregistrement plutôt que l\'affichage', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      const download = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      expect(download.headers['content-disposition']).toMatch(/^attachment;/);
      expect(download.headers['content-type']).toBe('application/octet-stream');
      expect(download.headers['x-content-type-options']).toBe('nosniff');
    });

    // Le jeton étant le seul secret, il ne doit pas s'échapper vers un tiers.
    it('empêche le lien de fuiter par le référent ou un cache', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      const download = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      expect(download.headers['referrer-policy']).toBe('no-referrer');
      expect(download.headers['cache-control']).toContain('no-store');
    });

    it('conserve le nom d\'origine dans l\'en-tête', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      const download = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      expect(download.headers['content-disposition']).toContain('contrat.txt');
    });
  });

  describe('Lien protégé par mot de passe', () => {
    const MOT_DE_PASSE = 'secret-du-lien';

    it('refuse le téléchargement sans mot de passe — 401', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        password: MOT_DE_PASSE,
      });

      const response = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(401);

      expect(response.body.error).toBe('SHARE_PASSWORD_REQUIRED');
    });

    it('refuse un mauvais mot de passe — 403', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        password: MOT_DE_PASSE,
      });

      const response = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .set('X-Share-Password', 'pas-le-bon')
        .expect(403);

      expect(response.body.error).toBe('SHARE_PASSWORD_INVALID');
    });

    it('accepte le bon mot de passe', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        password: MOT_DE_PASSE,
      });

      const download = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .set('X-Share-Password', MOT_DE_PASSE)
        .expect(200);

      expect(download.body.toString('utf8')).toBe(CONTENU);
    });

    // Un lien intercepté ne doit pas révéler ce qu'il contient.
    it('ne divulgue pas le nom du fichier avant le mot de passe', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        password: MOT_DE_PASSE,
      });

      const info = await request(app.getHttpServer())
        .get(`/api/download/${token}/info`)
        .expect(200);

      expect(info.body.requiresPassword).toBe(true);
      expect(info.body.fileName).toBeUndefined();
      expect(info.body.sizeBytes).toBeUndefined();
    });

    it('stocke le mot de passe haché, jamais en clair', async () => {
      const alice = await connecter(ALICE);
      await partager(alice, await deposer(alice), { password: MOT_DE_PASSE });

      const stocke = await prisma.share.findFirstOrThrow();

      expect(stocke.passwordHash).toMatch(/^\$argon2id\$/);
      expect(stocke.passwordHash).not.toContain(MOT_DE_PASSE);
    });

    it('signale au déposant quels liens sont protégés', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);
      await partager(alice, fileId, { password: MOT_DE_PASSE });

      const liste = await request(app.getHttpServer())
        .get('/api/shares')
        .set('Cookie', alice)
        .expect(200);

      expect(liste.body[0].protectedByPassword).toBe(true);
      expect(JSON.stringify(liste.body)).not.toContain(MOT_DE_PASSE);
    });

    it('refuse un mot de passe trop court à la création', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);

      await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', alice)
        .send({ fileId, expiresInHours: 24, password: 'court' })
        .expect(400);
    });
  });

  describe('Création', () => {
    it('ne montre le jeton qu\'à la création', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);
      const { token } = await partager(alice, fileId);

      const liste = await request(app.getHttpServer())
        .get('/api/shares')
        .set('Cookie', alice)
        .expect(200);

      expect(JSON.stringify(liste.body)).not.toContain(token);
    });

    // La garantie principale : une fuite de la base ne livre aucun lien.
    it('ne stocke jamais le jeton en clair', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      const stocke = await prisma.share.findFirstOrThrow();

      expect(stocke.tokenHash).not.toBe(token);
      expect(stocke.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('chiffre l\'email du destinataire', async () => {
      const alice = await connecter(ALICE);
      await partager(alice, await deposer(alice), { recipientEmail: BOB });

      const stocke = await prisma.share.findFirstOrThrow();

      expect(stocke.recipientEmailEnc).not.toContain('bob');
      expect(stocke.recipientEmailEnc).toMatch(/^v1\./);
      expect(stocke.recipientEmailHmac).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuse de partager le fichier de quelqu\'un d\'autre', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);

      const bob = await connecter(BOB);

      const response = await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', bob)
        .send({ fileId, recipientEmail: CAROL, expiresInHours: 24 })
        .expect(404);

      expect(response.body.error).toBe('FILE_NOT_FOUND');
    });

    it.each([
      ['une durée nulle', 0],
      ['une durée négative', -5],
      ['une durée de plus de 30 jours', 24 * 31],
    ])('refuse %s', async (_cas, expiresInHours) => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);

      await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', alice)
        .send({ fileId, recipientEmail: BOB, expiresInHours })
        .expect(400);
    });

    it('refuse un email de destinataire invalide', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);

      await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', alice)
        .send({ fileId, recipientEmail: 'pas-un-email', expiresInHours: 24 })
        .expect(400);
    });
  });

  describe('Lien à usage unique', () => {
    it('sert le fichier au premier téléchargement', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        burnAfterDownload: true,
      });

      const download = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      expect(download.body.toString('utf8')).toBe(CONTENU);
    });

    // Le fichier ayant été effacé, la ligne du partage a disparu avec lui : il
    // ne reste littéralement rien, d'où le 404 plutôt qu'un 410. C'est même
    // préférable — on ne peut pas distinguer « déjà utilisé » de « n'a jamais
    // existé ».
    it('refuse le second téléchargement — 404, plus rien n\'existe', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        burnAfterDownload: true,
      });

      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      const second = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(404);

      expect(second.body.error).toBe('SHARE_NOT_FOUND');
    });

    // Quand le fichier survit — parce qu'un autre lien l'utilise — la ligne du
    // partage reste, et on peut dire précisément ce qui s'est passé.
    it('répond 410 sur un lien consommé dont le fichier survit', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);
      const jetable = await partager(alice, fileId, {
        burnAfterDownload: true,
      });
      await partager(alice, fileId);

      await request(app.getHttpServer())
        .get(`/api/download/${jetable.token}`)
        .expect(200);

      const second = await request(app.getHttpServer())
        .get(`/api/download/${jetable.token}`)
        .expect(410);

      expect(second.body.error).toBe('SHARE_ALREADY_USED');
    });

    // La promesse forte du service : la donnée ne survit pas à sa transmission.
    it('efface le fichier du serveur après le téléchargement', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);

      const stocke = await prisma.file.findUniqueOrThrow({
        where: { id: fileId },
        select: { storageName: true },
      });

      const { token } = await partager(alice, fileId, {
        burnAfterDownload: true,
      });

      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      // Ni en base...
      expect(await prisma.file.count({ where: { id: fileId } })).toBe(0);
      // ...ni sur le disque.
      await expect(
        readFile(join(storageRoot, stocke.storageName)),
      ).rejects.toThrow();
    });

    it('disparaît aussi de la liste du déposant', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        burnAfterDownload: true,
      });

      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      const fichiers = await request(app.getHttpServer())
        .get('/api/files')
        .set('Cookie', alice)
        .expect(200);

      expect(fichiers.body).toEqual([]);
    });

    // Sans cette vérification, brûler un lien détruirait silencieusement les
    // autres partages du même fichier.
    it('conserve le fichier s\'il lui reste un autre lien exploitable', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);

      const jetable = await partager(alice, fileId, {
        burnAfterDownload: true,
      });
      const durable = await partager(alice, fileId);

      await request(app.getHttpServer())
        .get(`/api/download/${jetable.token}`)
        .expect(200);

      // Le fichier est toujours là, et l'autre lien fonctionne encore.
      expect(await prisma.file.count({ where: { id: fileId } })).toBe(1);
      await request(app.getHttpServer())
        .get(`/api/download/${durable.token}`)
        .expect(200);
    });

    it('signale au destinataire que le lien ne servira qu\'une fois', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        burnAfterDownload: true,
      });

      const info = await request(app.getHttpServer())
        .get(`/api/download/${token}/info`)
        .expect(200);

      expect(info.body.singleUse).toBe(true);
    });

    // Deux personnes ouvrent le lien en même temps : une seule doit l'obtenir.
    it('ne laisse passer qu\'un seul téléchargement simultané', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        burnAfterDownload: true,
      });

      const [un, deux] = await Promise.all([
        request(app.getHttpServer()).get(`/api/download/${token}`),
        request(app.getHttpServer()).get(`/api/download/${token}`),
      ]);

      const codes = [un.status, deux.status].sort((a, b) => a - b);
      expect(codes).toEqual([200, 410]);
    });

    it('reste un lien ordinaire quand l\'option n\'est pas demandée', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      // Deux téléchargements de suite, sans encombre.
      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);
    });

    it('combine usage unique et mot de passe', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice), {
        burnAfterDownload: true,
        password: 'secret-du-lien',
      });

      // Un essai raté ne doit pas consumer le lien.
      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .set('X-Share-Password', 'mauvais')
        .expect(403);

      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .set('X-Share-Password', 'secret-du-lien')
        .expect(200);
    });
  });

  describe('Contrôles d\'accès au téléchargement', () => {
    it('refuse un jeton inconnu — 404', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/download/jeton-invente-de-toutes-pieces')
        .expect(404);

      expect(response.body.error).toBe('SHARE_NOT_FOUND');
    });

    it('refuse un lien expiré — 410', async () => {
      const alice = await connecter(ALICE);
      const { id, token } = await partager(alice, await deposer(alice));

      // On ramène l'expiration dans le passé plutôt que d'attendre trois jours.
      await prisma.share.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(410);

      expect(response.body.error).toBe('SHARE_EXPIRED');
    });

    it('applique les mêmes refus à la consultation du lien', async () => {
      const alice = await connecter(ALICE);
      const { id, token } = await partager(alice, await deposer(alice));

      await prisma.share.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(app.getHttpServer())
        .get(`/api/download/${token}/info`)
        .expect(410);
    });

    // La durée de vie n'est pas décorative : elle borne la fenêtre pendant
    // laquelle un lien oublié reste exploitable.
    it('respecte la durée de vie choisie par le déposant', async () => {
      const alice = await connecter(ALICE);
      const { id } = await partager(alice, await deposer(alice), {
        expiresInHours: 1,
      });

      const share = await prisma.share.findUniqueOrThrow({ where: { id } });
      const dureeMs = share.expiresAt.getTime() - share.createdAt.getTime();

      expect(dureeMs).toBeGreaterThan(55 * 60 * 1000);
      expect(dureeMs).toBeLessThan(65 * 60 * 1000);
    });

    // Déposer exige un compte, contrairement à recevoir.
    it('exige toujours une session pour déposer et partager', async () => {
      await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .send({ fileId: '3f2b8c1e-9d4a-4f6b-8e2c-7a1d5b3c9e0f' })
        .expect(401);
    });
  });

  describe('Révocation', () => {
    // La démonstration « je retire l'accès » de la soutenance.
    it('coupe l\'accès immédiatement', async () => {
      const alice = await connecter(ALICE);
      const { id, token } = await partager(alice, await deposer(alice));

      // Le lien fonctionne...
      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/api/shares/${id}/revoke`)
        .set(...CSRF)
        .set('Cookie', alice)
        .expect(204);

      // ...et ne fonctionne plus, sans que le lien ait changé.
      const response = await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(403);

      expect(response.body.error).toBe('SHARE_REVOKED');
    });

    it('peut être répétée sans erreur', async () => {
      const alice = await connecter(ALICE);
      const { id } = await partager(alice, await deposer(alice));

      await request(app.getHttpServer())
        .patch(`/api/shares/${id}/revoke`)
        .set(...CSRF)
        .set('Cookie', alice)
        .expect(204);

      await request(app.getHttpServer())
        .patch(`/api/shares/${id}/revoke`)
        .set(...CSRF)
        .set('Cookie', alice)
        .expect(204);
    });

    it('n\'est possible que pour le propriétaire du fichier', async () => {
      const alice = await connecter(ALICE);
      const { id, token } = await partager(alice, await deposer(alice));

      const bob = await connecter(BOB);

      await request(app.getHttpServer())
        .patch(`/api/shares/${id}/revoke`)
        .set(...CSRF)
        .set('Cookie', bob)
        .expect(404);

      // Le partage est toujours actif : Bob n'a rien pu casser.
      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);
    });

    it('exige l\'en-tête CSRF', async () => {
      const alice = await connecter(ALICE);
      const { id } = await partager(alice, await deposer(alice));

      await request(app.getHttpServer())
        .patch(`/api/shares/${id}/revoke`)
        .set('Cookie', alice)
        .expect(403);
    });
  });

  describe('Liste des partages', () => {
    it('affiche l\'état de chaque partage', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);
      const actif = await partager(alice, fileId, { recipientEmail: BOB });
      const revoque = await partager(alice, fileId, { recipientEmail: CAROL });

      await request(app.getHttpServer())
        .patch(`/api/shares/${revoque.id}/revoke`)
        .set(...CSRF)
        .set('Cookie', alice)
        .expect(204);

      const response = await request(app.getHttpServer())
        .get('/api/shares')
        .set('Cookie', alice)
        .expect(200);

      const parId = Object.fromEntries(
        (response.body as { id: string; status: string }[]).map((s) => [
          s.id,
          s.status,
        ]),
      );

      expect(parId[actif.id]).toBe('ACTIVE');
      expect(parId[revoque.id]).toBe('REVOKED');
    });

    it('déchiffre le nom du fichier et l\'email du destinataire', async () => {
      const alice = await connecter(ALICE);
      await partager(alice, await deposer(alice), { recipientEmail: BOB });

      const response = await request(app.getHttpServer())
        .get('/api/shares')
        .set('Cookie', alice)
        .expect(200);

      expect(response.body[0]).toMatchObject({
        fileName: 'contrat.txt',
        recipientEmail: BOB,
      });
    });

    // Le destinataire est facultatif : on peut créer un lien sans savoir
    // encore à qui on le transmettra.
    it('accepte un partage sans destinataire indiqué', async () => {
      const alice = await connecter(ALICE);
      const { token } = await partager(alice, await deposer(alice));

      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(200);

      const liste = await request(app.getHttpServer())
        .get('/api/shares')
        .set('Cookie', alice)
        .expect(200);

      expect(liste.body[0].recipientEmail).toBeUndefined();
    });

    it('ne montre pas les partages des autres', async () => {
      const alice = await connecter(ALICE);
      await partager(alice, await deposer(alice));

      const bob = await connecter(BOB);

      const response = await request(app.getHttpServer())
        .get('/api/shares')
        .set('Cookie', bob)
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe('Suppression du fichier', () => {
    it('emporte ses partages', async () => {
      const alice = await connecter(ALICE);
      const fileId = await deposer(alice);
      const { token } = await partager(alice, fileId);

      await request(app.getHttpServer())
        .delete(`/api/files/${fileId}`)
        .set(...CSRF)
        .set('Cookie', alice)
        .expect(204);

      await request(app.getHttpServer())
        .get(`/api/download/${token}`)
        .expect(404);
    });
  });
});
