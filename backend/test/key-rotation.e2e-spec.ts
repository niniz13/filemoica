import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { CryptoService } from './../src/crypto/crypto.service';
import { KeyRotationService } from './../src/crypto/key-rotation.service';
import { PrismaService } from './../src/prisma/prisma.service';
import { confirmerAdresse, ouvrirSession, resetDatabase } from './database';

const PASSWORD = 'phrase-de-passe-suffisamment-longue';
const CONTENU = 'Document dont le chiffrement doit survivre � la rotation.';

/** Nouvelle cl� ma�tre, celle vers laquelle on bascule. */
const CLE_V2 = 'ab'.repeat(32);

/**
 * Rotation des cl�s de chiffrement.
 *
 * Ces tests portent la promesse la plus technique du projet : **changer la cl�
 * ma�tre sans relire un seul fichier**. Ils v�rifient donc deux choses
 * indissociables � que les donn�es restent lisibles apr�s la bascule, et que
 * les fichiers sur le disque n'ont pas boug� d'un octet.
 */
describe('Rotation des cl�s (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let rotation: KeyRotationService;
  let cryptoV2: CryptoService;

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

    // L'application tourne avec la seule cl� v1. On construit � c�t� un service
    // qui conna�t les deux cl�s : c'est exactement la configuration d'un
    // service en cours de rotation.
    const config = app.get(ConfigService);
    cryptoV2 = new CryptoService({
      get: (key: string) =>
        key === 'ENCRYPTION_KEY_V2' ? CLE_V2 : config.get(key),
    } as unknown as ConfigService<never, true>);

    rotation = new KeyRotationService(prisma, cryptoV2);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  afterAll(async () => {
    await app.close();
  });

  /** Inscrit un compte, d�pose un fichier et cr�e un partage. */
  async function preparerDonnees(): Promise<{
    fileId: string;
    storageName: string;
  }> {
    const email = 'alice@example.fr';

    await request(app.getHttpServer())
      .post('/api/auth/register')
      .set(...CSRF)
      .send({ email, password: PASSWORD })
      .expect(201);

      // La connexion est refusée tant que l'adresse n'est pas confirmée.
      await confirmerAdresse(prisma, email);

    const cookies = await ouvrirSession(app, email, PASSWORD);

    const depot = await request(app.getHttpServer())
      .post('/api/files')
      .set(...CSRF)
      .set('Cookie', cookies)
      .attach('file', Buffer.from(CONTENU, 'utf8'), 'document.txt')
      .expect(201);

    await request(app.getHttpServer())
      .post('/api/shares')
      .set(...CSRF)
      .set('Cookie', cookies)
      .send({
        fileIds: [depot.body.id],
        expiresInHours: 24,
        recipientEmail: 'bob@example.fr',
      })
      .expect(201);

    const file = await prisma.file.findUniqueOrThrow({
      where: { id: depot.body.id },
      select: { storageName: true },
    });

    return { fileId: depot.body.id, storageName: file.storageName };
  }

  it('bascule les donn�es existantes vers la nouvelle cl�', async () => {
    await preparerDonnees();

    const rapport = await rotation.rotate();

    expect(rapport.targetVersion).toBe('v2');
    expect(rapport.files.rewrapped).toBe(1);
    expect(rapport.shares.rewrapped).toBe(1);

    const file = await prisma.file.findFirstOrThrow();
    expect(file.keyVersion).toBe('v2');
    expect(file.dekWrapped.startsWith('v2.')).toBe(true);
    expect(file.originalNameEnc.startsWith('v2.')).toBe(true);
  });

  it('pr�serve les donn�es : tout reste lisible apr�s la bascule', async () => {
    await preparerDonnees();
    await rotation.rotate();

    const file = await prisma.file.findFirstOrThrow();
    const share = await prisma.share.findFirstOrThrow();

    expect(cryptoV2.openToString(file.originalNameEnc)).toBe('document.txt');
    expect(cryptoV2.openToString(share.recipientEmailEnc ?? '')).toBe(
      'bob@example.fr',
    );
  });

  // La promesse centrale du chiffrement enveloppe : la rotation ne relit pas
  // les fichiers. Sur un volume r�el, c'est la diff�rence entre quelques
  // secondes et plusieurs heures.
  it('ne touche pas au fichier sur le disque', async () => {
    const { storageName } = await preparerDonnees();

    const avant = await readFile(join(storageRoot, storageName));
    await rotation.rotate();
    const apres = await readFile(join(storageRoot, storageName));

    expect(apres.equals(avant)).toBe(true);
  });

  // Et malgr� cela, le contenu reste d�chiffrable � avec la cl� re-scell�e.
  it('laisse le contenu d�chiffrable avec la cl� re-scell�e', async () => {
    const { storageName } = await preparerDonnees();
    await rotation.rotate();

    const file = await prisma.file.findFirstOrThrow();
    const surDisque = await readFile(join(storageRoot, storageName));

    const decipher = cryptoV2.createContentDecipher(
      cryptoV2.open(file.dekWrapped),
      Buffer.from(file.contentIv, 'base64'),
      Buffer.from(file.contentAuthTag, 'base64'),
    );

    const clair = Buffer.concat([
      decipher.update(surDisque),
      decipher.final(),
    ]);

    expect(clair.toString('utf8')).toBe(CONTENU);
  });

  it('ne r��crit rien lors d\'une seconde ex�cution', async () => {
    await preparerDonnees();
    await rotation.rotate();

    const seconde = await rotation.rotate();

    expect(seconde.files.rewrapped).toBe(0);
    expect(seconde.shares.rewrapped).toBe(0);
  });

  it('ne modifie rien en simulation', async () => {
    await preparerDonnees();

    const rapport = await rotation.rotate({ dryRun: true });

    expect(rapport.dryRun).toBe(true);
    expect(rapport.files.rewrapped).toBe(1);

    // Compt�, mais pas touch�.
    const file = await prisma.file.findFirstOrThrow();
    expect(file.keyVersion).toBe('v1');
    expect(file.dekWrapped.startsWith('v1.')).toBe(true);
  });

  it('g�re un partage sans destinataire', async () => {
    await preparerDonnees();
    await prisma.share.updateMany({
      data: { recipientEmailEnc: null, recipientEmailHmac: null },
    });

    const rapport = await rotation.rotate();

    expect(rapport.shares.rewrapped).toBe(0);
    expect(rapport.files.rewrapped).toBe(1);
  });

  it('ne fait rien sur une base vide', async () => {
    const rapport = await rotation.rotate();

    expect(rapport.files.scanned).toBe(0);
    expect(rapport.shares.scanned).toBe(0);
  });
});
