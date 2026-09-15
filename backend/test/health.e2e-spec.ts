import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * Tests de la sonde de supervision.
 *
 * La base est remplacée par un double : ces tests doivent pouvoir tourner sans
 * PostgreSQL, et surtout pouvoir simuler une base tombée — ce qu'on ne peut pas
 * faire de façon fiable en arrêtant un vrai serveur au milieu d'une suite.
 * La panne réelle, elle, est vérifiée à la main lors du test d'incident.
 */
describe('Health (e2e)', () => {
  let app: INestApplication<App>;
  const isReachable = jest.fn<Promise<boolean>, []>();

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({ isReachable, $connect: jest.fn(), $disconnect: jest.fn() })
      .compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('répond sur /health, hors du préfixe /api', async () => {
    isReachable.mockResolvedValue(true);

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      checks: { database: 'up' },
    });
  });

  // C'est le code HTTP que regarde un orchestrateur, pas le corps de la
  // réponse : sans le 503, une instance cassée continuerait de recevoir du
  // trafic.
  it('répond 503 quand la base est injoignable', async () => {
    isReachable.mockResolvedValue(false);

    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(503);

    expect(response.body).toMatchObject({
      status: 'degraded',
      checks: { database: 'down' },
    });
  });

  it('reste accessible sans authentification', async () => {
    isReachable.mockResolvedValue(true);

    await request(app.getHttpServer())
      .get('/health')
      .expect((response) => {
        expect(response.status).not.toBe(401);
      });
  });

  // Une sonde publique ne doit renseigner ni sur la topologie, ni sur les
  // identifiants : un attaquant ne doit rien apprendre en l'appelant.
  it('ne divulgue aucun détail d\'infrastructure', async () => {
    isReachable.mockResolvedValue(true);

    const response = await request(app.getHttpServer()).get('/health');
    const body = JSON.stringify(response.body);

    expect(body).not.toMatch(/postgres|password|localhost|5433|DATABASE_URL/i);
  });
});
