import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { CsrfGuard } from './common/guards/csrf.guard';
import { RateLimitGuard } from './common/guards/rate-limit.guard';
import { NodeEnv, type EnvironmentVariables } from './config/env.validation';

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

  // Nombre de relais devant le service. Sans ce réglage, toutes les requêtes
  // sembleraient venir du reverse proxy et la limitation de débit bloquerait
  // tout le monde d'un coup.
  app
    .getHttpAdapter()
    .getInstance()
    .set('trust proxy', config.get('TRUST_PROXY_HOPS', { infer: true }));

  // `/health` reste hors préfixe : c'est l'URL que SRC branche sur sa sonde.
  app.setGlobalPrefix('api', { exclude: ['health'] });

  // Les jetons de session vivent dans des cookies : sans cet analyseur,
  // `request.cookies` reste vide et personne n'est jamais authentifié.
  app.use(cookieParser());

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
  app.useGlobalGuards(
    new CsrfGuard(),
    new RateLimitGuard(
      app.get(Reflector),
      config.get('RATE_LIMIT_ENABLED', { infer: true }),
    ),
  );

  // En test, seuls les avertissements et les erreurs sont affichés : le journal
  // d'une ligne par requête noierait la sortie de la suite sous des centaines
  // de lignes sans rapport avec ce qui est vérifié.
  if (config.get('NODE_ENV', { infer: true }) === NodeEnv.Test) {
    app.useLogger(['warn', 'error']);
  }

  app.enableCors({
    // Une seule origine, jamais de joker : `credentials: true` et `origin: '*'`
    // sont de toute façon incompatibles, et c'est tant mieux.
    origin: config.get('FRONTEND_ORIGIN', { infer: true }),
    // Indispensable pour que le navigateur accepte d'envoyer nos cookies.
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
  });
}
