import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RetentionService } from './files/retention.service';

/**
 * Commande de purge des fichiers dont la conservation est écoulée.
 *
 * À planifier une fois par jour. Contrairement à la purge des jetons, **celle-ci
 * efface de la donnée utilisateur** : la simuler d'abord est une bonne habitude.
 *
 * @example
 * ```bash
 * npm run files:purge -- --dry-run   # compte sans rien effacer
 * npm run files:purge                # efface
 * ```
 *
 * ```cron
 * # Tous les jours à 3 h du matin, avant la purge des jetons
 * 0 3 * * * cd /srv/filemoica && npm run files:purge
 * ```
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const logger = new Logger('PurgeDesFichiers');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const report = await app.get(RetentionService).purge({ dryRun });

    logger.log('──────────────────────────────────────────────');
    logger.log(`Mode              : ${dryRun ? 'simulation' : 'réel'}`);
    logger.log(`Fichiers examinés : ${report.scanned}`);
    logger.log(
      `Fichiers effacés  : ${report.deleted}${dryRun ? ' (le seraient)' : ''}`,
    );
    logger.log(
      `Espace libéré     : ${(report.freedBytes / (1024 * 1024)).toFixed(2)} Mo`,
    );
    logger.log(`Durée             : ${report.durationMs} ms`);
    logger.log('──────────────────────────────────────────────');

    if (dryRun && report.deleted > 0) {
      logger.warn(
        'Simulation : aucun fichier n\'a été effacé. Relancer sans --dry-run pour appliquer.',
      );
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  new Logger('PurgeDesFichiers').error(
    'La purge a échoué',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
