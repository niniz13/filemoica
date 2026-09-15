import { Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { PrismaService } from './../src/prisma/prisma.service';

/**
 * Contrôleur existant uniquement pour ces tests.
 *
 * Les gardes globales de Nest ne s'exécutent qu'une fois la route résolue : sur
 * une URL inexistante, le 404 part avant toute vérification. Tester la
 * protection CSRF demande donc une vraie route qui modifie l'état — sans pour
 * autant ajouter une route factice au code de production.
 */
@Controller('socle-test')
class SocleTestController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true };
  }

  @Post()
  write(): { ok: boolean } {
    return { ok: true };
  }
}

/**
 * Tests end-to-end du socle applicatif.
 *
 * On vérifie ici ce qui s'applique à *toutes* les routes — préfixe d'URL,
 * format d'erreur, protection CSRF — plutôt qu'une fonctionnalité métier.
 * Les mêmes garanties sont ainsi acquises pour les routes ajoutées ensuite.
 */
describe('Socle applicatif (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [SocleTestController],
    })
      // Ces tests portent sur le socle HTTP, pas sur les données : la base est
      // remplacée par un double pour qu'ils tournent sans PostgreSQL.
      .overrideProvider(PrismaService)
      .useValue({
        isReachable: jest.fn().mockResolvedValue(true),
        $connect: jest.fn(),
        $disconnect: jest.fn(),
      })
      .compile();

    app = moduleFixture.createNestApplication();
    // Même configuration qu'en production : sans cet appel, les tests
    // passeraient sur des requêtes que le vrai service refuserait.
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Préfixe des routes', () => {
    it('expose les routes métier sous /api', async () => {
      await request(app.getHttpServer()).get('/api/socle-test').expect(200);
    });

    it('n\'expose pas les routes métier hors du préfixe', async () => {
      await request(app.getHttpServer()).get('/socle-test').expect(404);
    });
  });

  describe('Format d\'erreur', () => {
    it('renvoie { error, message } sur une route inconnue', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/route-inexistante')
        .expect(404);

      expect(response.body).toMatchObject({
        error: 'NOT_FOUND',
        message: expect.any(String) as unknown as string,
      });
    });
  });

  describe('Protection CSRF', () => {
    it('refuse une écriture sans en-tête X-Requested-With', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/socle-test')
        .send({})
        .expect(403);

      expect(response.body.error).toBe('CSRF_HEADER_MISSING');
    });

    it('laisse passer une écriture munie de l\'en-tête', async () => {
      await request(app.getHttpServer())
        .post('/api/socle-test')
        .set('X-Requested-With', 'XMLHttpRequest')
        .send({})
        .expect(201);
    });

    it('ne bloque pas les lectures', async () => {
      await request(app.getHttpServer()).get('/api/socle-test').expect(200);
    });
  });

  describe('CORS', () => {
    it('autorise l\'origine du front avec les cookies', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/socle-test')
        .set('Origin', 'http://localhost:5173');

      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
      expect(response.headers['access-control-allow-credentials']).toBe('true');
    });

    // Le serveur renvoie toujours la même origine autorisée, jamais celle de
    // l'appelant : c'est le navigateur qui compare et bloque. Ce qu'on vérifie
    // ici, c'est qu'on ne renvoie jamais l'origine d'un tiers en écho — le
    // défaut classique d'une configuration CORS trop permissive.
    it('ne renvoie jamais l\'origine d\'un tiers en écho', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/socle-test')
        .set('Origin', 'https://site-pirate.example');

      expect(response.headers['access-control-allow-origin']).not.toBe(
        'https://site-pirate.example',
      );
      expect(response.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('refuse le contrôle préalable d\'une origine tierce', async () => {
      const response = await request(app.getHttpServer())
        .options('/api/socle-test')
        .set('Origin', 'https://site-pirate.example')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'X-Requested-With');

      expect(response.headers['access-control-allow-origin']).not.toBe(
        'https://site-pirate.example',
      );
    });
  });
});
