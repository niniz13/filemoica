import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import type { EnvironmentVariables } from './config/env.validation';

/**
 * Point d'entrée du service.
 *
 * L'application tourne en HTTP : le chiffrement du transport (HTTPS) est assuré
 * par le reverse proxy géré par l'équipe SRC, qui est le seul à exposer un port
 * au public. C'est une des deux décisions communes du sprint.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  configureApp(app);

  const config = app.get(ConfigService<EnvironmentVariables, true>);
  const port = config.get('PORT', { infer: true });

  await app.listen(port);

  Logger.log(`Service démarré sur le port ${port}`, 'Bootstrap');
}

void bootstrap();
