import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { CryptoService } from './../src/crypto/crypto.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { resetDatabase } from './database';

const PASSWORD = 'phrase-de-passe-suffisamment-longue';
const CONTENU = 'Rapport confidentiel — chiffre annuel : 1 234 567 euros.';

/**
 * Dépôt, liste et suppression de fichiers, contre une vraie base et un vrai
 * répertoire de stockage.
 *
 * Ces tests portent les deux preuves centrales du projet : le **chiffrement au
 * repos** (le fichier sur le disque est illisible) et le **cloisonnement** (un
 * utilisateur ne voit pas les fichiers d'un autre).
 */
describe('Fichiers (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let crypto: CryptoService;

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
    crypto = app.get(CryptoService);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Inscrit et connecte un compte, puis renvoie ses cookies. */
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

  /**
   * Dépose un fichier.
   *
   * Volontairement non asynchrone : renvoyer la requête supertest elle-même
   * permet à l'appelant d'enchaîner `.expect(...)`.
   */
  function deposer(cookies: string[], nom = 'rapport.txt', contenu = CONTENU) {
    return request(app.getHttpServer())
      .post('/api/files')
      .set(...CSRF)
      .set('Cookie', cookies)
      .attach('file', Buffer.from(contenu, 'utf8'), nom);
  }

  describe('Dépôt', () => {
    it('accepte un fichier et renvoie ses métadonnées', async () => {
      const cookies = await connecter('alice@example.fr');

      const response = await deposer(cookies).expect(201);

      expect(response.body).toMatchObject({
        id: expect.any(String) as unknown as string,
        originalName: 'rapport.txt',
        sizeBytes: Buffer.byteLength(CONTENU, 'utf8'),
      });
    });

    // La preuve centrale du chiffrement au repos : on lit le fichier
    // directement sur le disque, comme le ferait quelqu'un ayant volé la
    // machine.
    it('écrit un contenu illisible sur le disque', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies).expect(201);

      const stocke = await prisma.file.findFirstOrThrow({
        select: { storageName: true },
      });
      const surDisque = await readFile(join(storageRoot, stocke.storageName));

      // Non vide : un fichier de zéro octet satisferait toutes les assertions
      // suivantes sans rien prouver. C'est exactement le défaut qu'a laissé
      // passer une première version de ce test.
      expect(surDisque.length).toBeGreaterThan(0);
      expect(surDisque.toString('utf8')).not.toContain('confidentiel');
      expect(surDisque.toString('utf8')).not.toContain('1 234 567');
      expect(surDisque.toString('utf8')).not.toBe(CONTENU);
    });

    // Le pendant indispensable du test précédent : illisible **et**
    // récupérable. Vérifier seulement l'illisibilité laisserait passer un
    // fichier vide ou corrompu, qu'on ne découvrirait qu'au premier
    // téléchargement — c'est-à-dire trop tard.
    it('écrit un contenu que la clé stockée permet de retrouver', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies).expect(201);

      const stocke = await prisma.file.findFirstOrThrow();
      const surDisque = await readFile(join(storageRoot, stocke.storageName));

      // On refait le chemin inverse : déballer la clé du fichier avec la clé
      // maître, puis déchiffrer le contenu.
      const dataKey = crypto.open(stocke.dekWrapped);
      const decipher = crypto.createContentDecipher(
        dataKey,
        Buffer.from(stocke.contentIv, 'base64'),
        Buffer.from(stocke.contentAuthTag, 'base64'),
      );

      const clair = Buffer.concat([
        decipher.update(surDisque),
        decipher.final(),
      ]);

      expect(clair.toString('utf8')).toBe(CONTENU);
      expect(stocke.sizeBytes).toBe(Buffer.byteLength(CONTENU, 'utf8'));
    });

    it('détecte un fichier altéré sur le disque', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies).expect(201);

      const stocke = await prisma.file.findFirstOrThrow();
      const surDisque = await readFile(join(storageRoot, stocke.storageName));

      // Un seul octet modifié, comme le ferait une corruption ou une
      // manipulation directe du volume.
      surDisque[0] ^= 0xff;

      const decipher = crypto.createContentDecipher(
        crypto.open(stocke.dekWrapped),
        Buffer.from(stocke.contentIv, 'base64'),
        Buffer.from(stocke.contentAuthTag, 'base64'),
      );

      expect(() => {
        decipher.update(surDisque);
        decipher.final();
      }).toThrow();
    });

    // Sans nom aléatoire, un simple listing du répertoire révélerait de quoi
    // parlent les fichiers déposés.
    it('range le fichier sous un nom sans rapport avec l\'original', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies, 'bilan-financier-secret.txt').expect(201);

      const stocke = await prisma.file.findFirstOrThrow({
        select: { storageName: true },
      });

      expect(stocke.storageName).not.toContain('bilan');
      expect(stocke.storageName).toMatch(/^[0-9a-f]{32}$/);
    });

    it('chiffre le nom d\'origine en base', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies, 'bilan-financier-secret.txt').expect(201);

      const stocke = await prisma.file.findFirstOrThrow({
        select: { originalNameEnc: true },
      });

      expect(stocke.originalNameEnc).not.toContain('bilan');
      expect(stocke.originalNameEnc).toMatch(/^v1\./);
    });

    it('ne stocke jamais la clé du fichier en clair', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies).expect(201);

      const stocke = await prisma.file.findFirstOrThrow();

      expect(stocke.dekWrapped).toMatch(/^v1\./);
      expect(stocke.keyVersion).toBe('v1');
      expect(stocke.contentIv).toBeTruthy();
      expect(stocke.contentAuthTag).toBeTruthy();
    });

    it('préserve les accents dans le nom du fichier', async () => {
      const cookies = await connecter('alice@example.fr');

      const response = await deposer(cookies, 'rapport-générique-été.txt');

      expect(response.body.originalName).toBe('rapport-générique-été.txt');
    });

    it('refuse une requête sans fichier', async () => {
      const cookies = await connecter('alice@example.fr');

      const response = await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(400);

      expect(response.body.error).toBe('FILE_REQUIRED');
    });

    it('refuse un dépôt sans session', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .attach('file', Buffer.from('x'), 'test.txt')
        .expect(401);

      expect(response.body.error).toBe('NOT_AUTHENTICATED');
    });

    it('refuse un dépôt sans en-tête CSRF', async () => {
      const cookies = await connecter('alice@example.fr');

      await request(app.getHttpServer())
        .post('/api/files')
        .set('Cookie', cookies)
        .attach('file', Buffer.from('x'), 'test.txt')
        .expect(403);
    });
  });

  describe('Contrôle du format', () => {
    /** Entêtes binaires réels, suffisants pour identifier ces formats. */
    const SIGNATURES = {
      pdf: Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'binary'),
      png: Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52,
      ]),
      zip: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]),
      // « MZ » : un exécutable Windows.
      exe: Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]),
    };

    it.each([
      ['un PDF', SIGNATURES.pdf, 'document.pdf'],
      ['une image PNG', SIGNATURES.png, 'photo.png'],
      ['une archive ZIP', SIGNATURES.zip, 'archive.zip'],
    ])('accepte %s', async (_cas, contenu, nom) => {
      const cookies = await connecter('alice@example.fr');

      await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', cookies)
        .attach('file', contenu, nom)
        .expect(201);
    });

    it('accepte un fichier texte, qui n\'a pourtant aucune signature', async () => {
      const cookies = await connecter('alice@example.fr');

      await deposer(cookies, 'notes.txt', 'Juste du texte.').expect(201);
    });

    it('refuse un exécutable', async () => {
      const cookies = await connecter('alice@example.fr');

      const response = await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', cookies)
        .attach('file', SIGNATURES.exe, 'programme.exe')
        .expect(415);

      expect(response.body.error).toBe('FILE_TYPE_NOT_ALLOWED');
    });

    // Le cœur du contrôle : ni l'extension ni le type annoncé ne viennent de
    // nous. Seuls les octets disent ce qu'est réellement un fichier.
    it('refuse un exécutable déguisé en PDF', async () => {
      const cookies = await connecter('alice@example.fr');

      const response = await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', cookies)
        .attach('file', SIGNATURES.exe, {
          filename: 'rapport-anodin.pdf',
          contentType: 'application/pdf',
        })
        .expect(415);

      expect(response.body.error).toBe('FILE_TYPE_NOT_ALLOWED');
    });

    it('refuse un binaire déguisé en texte', async () => {
      const cookies = await connecter('alice@example.fr');

      await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', cookies)
        .attach('file', SIGNATURES.exe, {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
        .expect(415);
    });

    // Un fichier refusé ne doit pas laisser de trace : ni entrée en base, ni
    // contenu partiel sur le support.
    it('ne laisse aucune trace d\'un fichier refusé', async () => {
      const cookies = await connecter('alice@example.fr');

      await request(app.getHttpServer())
        .post('/api/files')
        .set(...CSRF)
        .set('Cookie', cookies)
        .attach('file', SIGNATURES.exe, 'programme.exe')
        .expect(415);

      expect(await prisma.file.count()).toBe(0);
    });
  });

  describe('Liste', () => {
    it('renvoie les fichiers déchiffrés, du plus récent au plus ancien', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies, 'premier.txt').expect(201);
      await deposer(cookies, 'second.txt').expect(201);

      const response = await request(app.getHttpServer())
        .get('/api/files')
        .set('Cookie', cookies)
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(response.body.map((f: { originalName: string }) => f.originalName)).toEqual([
        'second.txt',
        'premier.txt',
      ]);
    });

    // Le cloisonnement : c'est le test qui répond au critère « accès vérifiés ».
    it('ne montre jamais les fichiers d\'un autre utilisateur', async () => {
      const alice = await connecter('alice@example.fr');
      await deposer(alice, 'prive-alice.txt').expect(201);

      const bob = await connecter('bob@example.fr');

      const response = await request(app.getHttpServer())
        .get('/api/files')
        .set('Cookie', bob)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('n\'expose aucune information technique de stockage', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies).expect(201);

      const response = await request(app.getHttpServer())
        .get('/api/files')
        .set('Cookie', cookies)
        .expect(200);

      const serialise = JSON.stringify(response.body);
      expect(serialise).not.toMatch(/storageName|dekWrapped|contentIv|authTag/i);
    });

    it('refuse la liste sans session', async () => {
      await request(app.getHttpServer()).get('/api/files').expect(401);
    });
  });

  describe('Suppression', () => {
    it('supprime l\'entrée et le contenu sur le disque', async () => {
      const cookies = await connecter('alice@example.fr');
      const depot = await deposer(cookies).expect(201);

      const stocke = await prisma.file.findFirstOrThrow({
        select: { storageName: true },
      });

      await request(app.getHttpServer())
        .delete(`/api/files/${depot.body.id}`)
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(204);

      expect(await prisma.file.count()).toBe(0);
      await expect(
        readFile(join(storageRoot, stocke.storageName)),
      ).rejects.toThrow();
    });

    // Un 403 confirmerait l'existence du fichier : en essayant des
    // identifiants, on pourrait dénombrer les fichiers du service.
    it('renvoie 404, et non 403, sur le fichier d\'un autre', async () => {
      const alice = await connecter('alice@example.fr');
      const depot = await deposer(alice).expect(201);

      const bob = await connecter('bob@example.fr');

      const response = await request(app.getHttpServer())
        .delete(`/api/files/${depot.body.id}`)
        .set(...CSRF)
        .set('Cookie', bob)
        .expect(404);

      expect(response.body.error).toBe('FILE_NOT_FOUND');
      // Le fichier d'Alice est toujours là.
      expect(await prisma.file.count()).toBe(1);
    });

    it('renvoie 404 sur un identifiant inexistant', async () => {
      const cookies = await connecter('alice@example.fr');

      await request(app.getHttpServer())
        .delete('/api/files/3f2b8c1e-9d4a-4f6b-8e2c-7a1d5b3c9e0f')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(404);
    });

    it('refuse un identifiant mal formé', async () => {
      const cookies = await connecter('alice@example.fr');

      await request(app.getHttpServer())
        .delete('/api/files/pas-un-uuid')
        .set(...CSRF)
        .set('Cookie', cookies)
        .expect(400);
    });
  });

  describe('Suppression du compte', () => {
    it('emporte les fichiers de l\'utilisateur', async () => {
      const cookies = await connecter('alice@example.fr');
      await deposer(cookies).expect(201);

      await prisma.user.deleteMany({ where: { email: 'alice@example.fr' } });

      expect(await prisma.file.count()).toBe(0);
    });
  });
});
