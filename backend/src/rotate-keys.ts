import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { KeyRotationService } from './crypto/key-rotation.service';

/**
 * Commande de rotation des clés de chiffrement.
 *
 * ## Mode d'emploi
 *
 * 1. Générer une nouvelle clé :
 *    `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
 * 2. L'ajouter à la configuration sous `ENCRYPTION_KEY_V2`, **sans retirer**
 *    `ENCRYPTION_KEY_V1` : l'ancienne reste nécessaire pour lire l'existant.
 * 3. Simuler : `npm run keys:rotate -- --dry-run`
 * 4. Exécuter : `npm run keys:rotate`
 * 5. Une fois le rapport à zéro reste, retirer `ENCRYPTION_KEY_V1`.
 *
 * ## Pourquoi c'est rapide
 *
 * Seules les enveloppes sont réécrites — la clé de chaque fichier et quelques
 * champs. Les fichiers eux-mêmes ne sont ni relus ni réécrits : changer de clé
 * maître coûte quelques centaines d'octets par fichier, pas plusieurs
 * gigaoctets.
 *
 * ## Sans interruption de service
 *
 * La version de clé voyage avec chaque donnée. Pendant la rotation, anciennes
 * et nouvelles cohabitent et restent toutes deux lisibles : l'application peut
 * continuer de tourner.
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const logger = new Logger('RotationDesClés');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const report = await app.get(KeyRotationService).rotate({ dryRun });

    logger.log('──────────────────────────────────────────────');
    logger.log(`Version cible        : ${report.targetVersion}`);
    logger.log(`Mode                 : ${dryRun ? 'simulation' : 'réel'}`);
    logger.log(
      `Fichiers             : ${report.files.rewrapped} re-scellé(s) sur ${report.files.scanned} examiné(s)`,
    );
    logger.log(
      `Partages             : ${report.shares.rewrapped} re-scellé(s) sur ${report.shares.scanned} examiné(s)`,
    );
    logger.log(`Durée                : ${report.durationMs} ms`);
    logger.log('──────────────────────────────────────────────');

    if (dryRun) {
      logger.warn('Simulation : aucune donnée n\'a été modifiée.');
    } else if (report.files.rewrapped + report.shares.rewrapped === 0) {
      logger.log(
        'Tout était déjà sur la clé courante. L\'ancienne clé peut être retirée de la configuration.',
      );
    }
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  new Logger('RotationDesClés').error(
    'La rotation a échoué',
    error instanceof Error ? error.stack : String(error),
  );
  process.exitCode = 1;
});
