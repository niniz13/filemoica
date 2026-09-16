import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { TokenService } from './auth/token.service';

/**
 * Commande de purge des jetons expirés.
 *
 * Destinée à une tâche planifiée par l'infrastructure — une fois par jour
 * suffit largement.
 *
 * ## Ce qu'elle supprime
 *
 * - les **refresh tokens** dont la validité est passée ;
 * - les **access tokens révoqués** dont la date d'expiration est dépassée.
 *
 * ## Pourquoi ce n'est pas une opération de sécurité
 *
 * Ces lignes ne protègent plus rien une fois la date passée : un jeton expiré
 * est de toute façon refusé par la vérification de signature, et un jeton
 * révoqué expiré ne peut plus être présenté. La purge est une opération
 * d'hygiène — elle empêche deux tables de grossir indéfiniment.
 *
 * Elle est donc **sans risque** : la manquer un jour n'ouvre aucun accès, cela
 * laisse seulement quelques lignes de plus en base.
 *
 * @example
 * ```cron
 * # Tous les jours à 4 h du matin
 * 0 4 * * * cd /srv/filemoica && npm run tokens:purge
 * ```
 */
async function main(): Promise<void> {
  const logger = new Logger('PurgeDesJetons');

  // `log` doit rester actif : c'est à ce niveau que le compte rendu de la
  // purge est écrit, et une tâche planifiée qui ne dit rien est une tâche dont
  // on ne sait pas si elle a tourné.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const purged = await app.get(TokenService).purgeExpired();

    logger.log(
      `Purge terminée : ${purged.refreshTokens} refresh token(s) et ${purged.accessTokens} jeton(s) révoqué(s) supprimés`,
    );
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  new Logger('PurgeDesJetons').error(
    'La purge a échoué',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
