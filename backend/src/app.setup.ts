import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CsrfGuard } from './common/guards/csrf.guard';
import type { EnvironmentVariables } from './config/env.validation';

/**
 * Applique la configuration transverse de l'application.
 *
 * Extrait de `main.ts` à dessein : les tests end-to-end appellent la même
 * fonction, donc ils s'exécutent avec exactement les mêmes pipes, filtres et
 * gardes que la production. Sans ça, un test pourrait passer au vert sur une
 * requête que le vrai service rejetterait.
 *
 * @param app Application Nest déjà créée, pas encore démarrée.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<EnvironmentVariables, true>);

  // `/health` reste hors préfixe : c'est l'URL que SRC branche sur sa sonde.
  app.setGlobalPrefix('api', { exclude: ['health'] });

  app.useGlobalPipes(
    new ValidationPipe({
      // Les champs non déclarés dans le DTO sont retirés du payload...
      whitelist: true,
      // ...et leur présence est même une erreur : un client qui tente
      // d'envoyer `role: "ADMIN"` doit être refusé, pas silencieusement ignoré.
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalGuards(new CsrfGuard());

  app.enableCors({
    // Une seule origine, jamais de joker : `credentials: true` et `origin: '*'`
    // sont de toute façon incompatibles, et c'est tant mieux.
    origin: config.get('FRONTEND_ORIGIN', { infer: true }),
    // Indispensable pour que le navigateur accepte d'envoyer nos cookies.
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
  });
}
