import { ConsoleLogger, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { NodeEnv, type EnvironmentVariables } from './config/env.validation';
import { API_DOCS_PATH, setupSwagger } from './swagger';

/**
 * Point d'entrée du service.
 *
 * L'application tourne en HTTP : le chiffrement du transport (HTTPS) est assuré
 * par le reverse proxy géré par l'équipe SRC, qui est le seul à exposer un port
 * au public. C'est une des deux décisions communes du sprint.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    // Hors développement, les journaux sortent en JSON : une ligne par
    // événement, directement exploitable par la centralisation de logs de
    // l'infrastructure, sans avoir à écrire d'expressions d'extraction.
    // En développement, on garde la sortie colorée, bien plus lisible.
    logger: new ConsoleLogger({
      json: process.env.NODE_ENV === NodeEnv.Production,
    }),
  });

  configureApp(app);

  // `docker stop` envoie SIGTERM. Sans ces crochets, Nest n'entreprend aucun
  // arrêt ordonné : `PrismaService.onModuleDestroy()` ne serait jamais appelé,
  // le pool PostgreSQL resterait ouvert côté serveur, et une requête en cours
  // serait tranchée net — sur un dépôt, cela laisse un fichier partiellement
  // écrit sur le disque. Sans effet hors conteneur, indispensable dedans.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<EnvironmentVariables, true>);
  const port = config.get('PORT', { infer: true });

  // Uniquement dans `main.ts` : la documentation n'a pas sa place dans les
  // tests, où elle ne ferait qu'allonger chaque démarrage d'application.
  if (config.get('ENABLE_API_DOCS', { infer: true })) {
    setupSwagger(app);
  }

  await app.listen(port);

  Logger.log(`Service démarré sur le port ${port}`, 'Bootstrap');

  if (config.get('ENABLE_API_DOCS', { infer: true })) {
    Logger.log(
      `Documentation de l'API : http://localhost:${port}/${API_DOCS_PATH}`,
      'Bootstrap',
    );
  }
}

void bootstrap();
