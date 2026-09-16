import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Chemin de la documentation interactive. */
export const API_DOCS_PATH = 'api/docs';

/**
 * Publie la documentation interactive de l'API.
 *
 * ## Ce qui est généré automatiquement
 *
 * Le plugin `@nestjs/swagger` déclaré dans `nest-cli.json` lit le code à la
 * compilation : il déduit les schémas depuis les types TypeScript, les
 * contraintes depuis les décorateurs `class-validator` (longueur minimale d'un
 * mot de passe, format d'email...) et les descriptions depuis les commentaires
 * de documentation. Annoter à la main se limite donc aux réponses d'erreur, que
 * rien ne permet de deviner.
 *
 * ## Sur l'authentification par cookie
 *
 * La documentation déclare un schéma `cookie`, mais l'essai direct depuis
 * l'interface ne fonctionne que si le navigateur détient déjà les cookies de
 * session : ils sont `httpOnly`, donc l'interface ne peut pas les poser
 * elle-même. En pratique : appeler `/auth/login` depuis cette page, puis
 * enchaîner — le navigateur joint les cookies tout seul.
 */
export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('filemoica — API')
    .setDescription(
      [
        'API de partage de fichiers chiffrés.',
        '',
        '**Deux points à respecter côté client :**',
        '',
        "1. `credentials: 'include'` sur chaque requête — la session vit dans des cookies `httpOnly`, il n'y a ni jeton à stocker ni en-tête `Authorization` à poser.",
        "2. L'en-tête `X-Requested-With: XMLHttpRequest` sur toute requête qui modifie l'état (POST, PATCH, PUT, DELETE), sinon la protection CSRF répond **403 CSRF_HEADER_MISSING**.",
        '',
        'Toutes les erreurs ont la forme `{ error, message }`. Le champ `error` est un code stable : brancher les conditions dessus plutôt que sur le message.',
      ].join('\n'),
    )
    .setVersion(process.env.APP_VERSION ?? 'dev')
    .addCookieAuth('access_token', {
      type: 'apiKey',
      in: 'cookie',
      name: 'access_token',
      description:
        'Cookie de session, posé par /auth/login et invisible au JavaScript.',
    })
    .addTag('Authentification', 'Comptes, sessions et révocation')
    .addTag('Supervision', 'Sonde de santé, consommée par l\'infrastructure')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup(API_DOCS_PATH, app, document, {
    customSiteTitle: 'filemoica — API',
    swaggerOptions: {
      // Sans cela, les essais depuis l'interface partent sans cookie et
      // répondent 401, ce qui donne l'impression que l'API est cassée.
      withCredentials: true,
      persistAuthorization: true,
    },
  });
}
