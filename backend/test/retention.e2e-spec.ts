import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { RetentionService } from './../src/files/retention.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { resetDatabase } from './database';

const PASSWORD = 'phrase-de-passe-suffisamment-longue';
const ALICE = 'alice@example.fr';

/** Recule une date de N jours. */
function ilYa(jours: number): Date {
  return new Date(Date.now() - jours * 24 * 60 * 60 * 1000);
}

/**
 * Conservation des fichiers.
 *
 * La tâche efface de la **donnée utilisateur** : ces tests portent autant sur ce
 * qu'elle supprime que sur ce qu'elle doit épargner. Le second point est le plus
 * important — un fichier effacé à tort est irrécupérable.
 */
describe('Conservation des fichiers (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let retention: RetentionService;

  const CSRF = ['X-Requested-With', 'XMLHttpRequest'] as const;
  const storageRoot = resolve(process.env.STORAGE_PATH ?? './storage-test');

  /** Vrai si les octets chiffrés sont encore sur le disque. */
  async function presentSurDisque(storageName: string): Promise<boolean> {
    try {
      await access(join(storageRoot, storageName));
      return true;
    } catch {
      return false;
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    prisma = app.get(PrismaService);
    retention = app.get(RetentionService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Inscrit, connecte, et renvoie les cookies. */
  async function connecter(email = ALICE): Promise<string[]> {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set(...CSRF)
      .send({ email, password: PASSWORD })
      .expect(201);

    const connexion = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set(...CSRF)
      .send({ email, password: PASSWORD })
      .expect(200);

    return connexion.get('Set-Cookie') ?? [];
  }

  /** Dépose un fichier et renvoie son identifiant. */
  async function deposer(cookies: string[]): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/files')
      .set(...CSRF)
      .set('Cookie', cookies)
      .attach('file', Buffer.from('Contenu du fichier.', 'utf8'), 'a.txt')
      .expect(201);

    return response.body.id;
  }

  /** Antidate un fichier, faute de pouvoir attendre trente jours. */
  async function vieillir(fileId: string, jours: number): Promise<void> {
    await prisma.file.update({
      where: { id: fileId },
      data: { createdAt: ilYa(jours) },
    });
  }

  describe('Ce que la purge épargne', () => {
    // Le piège que la règle naïve ferait tomber : ce fichier n'a aucun partage,
    // mais c'est la donnée de son propriétaire, pas un déchet.
    it('conserve un fichier récent jamais partagé', async () => {
      const cookies = await connecter();
      await deposer(cookies);

      const rapport = await retention.purge();

      expect(rapport.deleted).toBe(0);
      expect(await prisma.file.count()).toBe(1);
    });

    it('conserve un fichier dont un partage est encore actif', async () => {
      const cookies = await connecter();
      const fileId = await deposer(cookies);
      await vieillir(fileId, 400);

      await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', cookies)
        .send({ fileIds: [fileId], expiresInHours: 24 })
        .expect(201);

      const rapport = await retention.purge();

      expect(rapport.deleted).toBe(0);
      expect(await prisma.file.count()).toBe(1);
    });

    // Le délai court depuis la fin du partage, pas depuis le dépôt : un lien
    // qui vient d'expirer ne doit pas emporter le fichier avec lui.
    it('conserve un fichier dont le partage vient d\'expirer', async () => {
      const cookies = await connecter();
      const fileId = await deposer(cookies);
      await vieillir(fileId, 400);

      const partage = await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', cookies)
        .send({ fileIds: [fileId], expiresInHours: 24 })
        .expect(201);

      // Expiré depuis hier seulement.
      await prisma.share.update({
        where: { id: partage.body.id },
        data: { expiresAt: ilYa(1) },
      });

      const rapport = await retention.purge();

      expect(rapport.deleted).toBe(0);
      expect(await prisma.file.count()).toBe(1);
    });
  });

  describe('Ce que la purge efface', () => {
    // Effacer la ligne en base ne libère aucun octet : c'est le disque qui se
    // remplit, c'est donc le disque qu'on vérifie.
    it('efface un fichier jamais partagé au-delà du délai, disque compris', async () => {
      const cookies = await connecter();
      const fileId = await deposer(cookies);

      const { storageName } = await prisma.file.findUniqueOrThrow({
        where: { id: fileId },
        select: { storageName: true },
      });
      expect(await presentSurDisque(storageName)).toBe(true);

      await vieillir(fileId, 400);

      const rapport = await retention.purge();

      expect(rapport.deleted).toBe(1);
      expect(rapport.freedBytes).toBeGreaterThan(0);
      expect(await prisma.file.count()).toBe(0);
      expect(await presentSurDisque(storageName)).toBe(false);
    });

    it('efface un fichier dont le partage est expiré depuis longtemps', async () => {
      const cookies = await connecter();
      const fileId = await deposer(cookies);
      await vieillir(fileId, 400);

      const partage = await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', cookies)
        .send({ fileIds: [fileId], expiresInHours: 24 })
        .expect(201);

      await prisma.share.update({
        where: { id: partage.body.id },
        data: { expiresAt: ilYa(200) },
      });

      const rapport = await retention.purge();

      expect(rapport.deleted).toBe(1);
      expect(await prisma.file.count()).toBe(0);
    });

    it('efface aussi un fichier dont le partage a été révoqué', async () => {
      const cookies = await connecter();
      const fileId = await deposer(cookies);
      await vieillir(fileId, 400);

      const partage = await request(app.getHttpServer())
        .post('/api/shares')
        .set(...CSRF)
        .set('Cookie', cookies)
        .send({ fileIds: [fileId], expiresInHours: 24 })
        .expect(201);

      await prisma.share.update({
        where: { id: partage.body.id },
        data: { revoked: true, expiresAt: ilYa(200) },
      });

      expect((await retention.purge()).deleted).toBe(1);
    });
  });

  describe('La conservation dépend de l\'offre', () => {
    it('accorde un délai plus long à un compte payant', async () => {
      const cookies = await connecter();
      const fileId = await deposer(cookies);

      // 60 jours : au-delà du délai gratuit (30), en deçà du payant (90).
      await vieillir(fileId, 60);

      await prisma.user.updateMany({
        where: { email: ALICE },
        data: { plan: 'PREMIUM' },
      });
      expect((await retention.purge()).deleted).toBe(0);

      await prisma.user.updateMany({
        where: { email: ALICE },
        data: { plan: 'FREE' },
      });
      expect((await retention.purge()).deleted).toBe(1);
    });
  });

  describe('Simulation', () => {
    it('compte sans rien effacer', async () => {
      const cookies = await connecter();
      const fileId = await deposer(cookies);
      await vieillir(fileId, 400);

      const { storageName } = await prisma.file.findUniqueOrThrow({
        where: { id: fileId },
        select: { storageName: true },
      });

      const rapport = await retention.purge({ dryRun: true });

      expect(rapport.dryRun).toBe(true);
      expect(rapport.deleted).toBe(1);
      // Compté, mais toujours là — en base comme sur le disque.
      expect(await prisma.file.count()).toBe(1);
      expect(await presentSurDisque(storageName)).toBe(true);
    });

    it('ne fait rien sur une base vide', async () => {
      const rapport = await retention.purge();

      expect(rapport.scanned).toBe(0);
      expect(rapport.deleted).toBe(0);
    });
  });
});
