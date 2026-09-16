import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CryptoService } from './crypto.service';

/** Nombre d'enregistrements traités par lot. */
const BATCH_SIZE = 200;

/** Ce qu'a fait — ou ferait — une rotation. */
export interface RotationReport {
  /** Version de clé vers laquelle tout est ramené. */
  targetVersion: string;
  /** Simulation : rien n'a été écrit. */
  dryRun: boolean;
  files: { scanned: number; rewrapped: number };
  shares: { scanned: number; rewrapped: number };
  durationMs: number;
}

/**
 * Bascule les données chiffrées vers la clé maître la plus récente.
 *
 * ## Ce que la rotation touche, et ce qu'elle ne touche pas
 *
 * Elle re-chiffre **uniquement** ce qui est scellé par la clé maître :
 *
 * - la clé de chaque fichier (quelques dizaines d'octets) ;
 * - les noms de fichiers et les emails de destinataires.
 *
 * Les fichiers eux-mêmes ne sont **jamais relus ni réécrits**. C'est tout
 * l'intérêt du chiffrement enveloppe : changer de clé maître coûte quelques
 * centaines d'octets par fichier, pas plusieurs gigaoctets. Une rotation reste
 * ainsi une opération de quelques secondes, faisable en direct.
 *
 * ## Ce qui rend l'opération sûre
 *
 * - **Idempotente** : une donnée déjà sur la clé cible est ignorée. La relancer
 *   ne fait rien de plus.
 * - **Reprenable** : chaque enregistrement est écrit indépendamment. Une
 *   interruption laisse un mélange d'anciennes et de nouvelles versions, que la
 *   prochaine exécution achèvera — et que le service sait lire dans
 *   l'intervalle, puisque la version voyage avec chaque donnée.
 * - **Simulable** : le mode `dryRun` compte ce qui serait réécrit sans rien
 *   modifier.
 *
 * ## Après la rotation
 *
 * Quand le rapport indique qu'il ne reste rien sur l'ancienne version, la
 * variable `ENCRYPTION_KEY_V1` peut être retirée de la configuration. C'est
 * seulement à ce moment que l'ancienne clé cesse d'être un secret à protéger.
 */
@Injectable()
export class KeyRotationService {
  private readonly logger = new Logger(KeyRotationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async rotate(
    options: { dryRun?: boolean } = {},
  ): Promise<RotationReport> {
    const dryRun = options.dryRun ?? false;
    const targetVersion = this.crypto.keyVersion;
    const startedAt = Date.now();

    this.logger.log(
      `Rotation vers ${targetVersion}${dryRun ? ' (simulation)' : ''}`,
    );

    const files = await this.rotateFiles(dryRun, targetVersion);
    const shares = await this.rotateShares(dryRun, targetVersion);

    const report: RotationReport = {
      targetVersion,
      dryRun,
      files,
      shares,
      durationMs: Date.now() - startedAt,
    };

    this.logger.log(
      `Rotation terminée : ${files.rewrapped} fichier(s) et ${shares.rewrapped} partage(s) en ${report.durationMs} ms`,
    );

    return report;
  }

  /**
   * Re-scelle la clé et le nom de chaque fichier resté sur une ancienne clé.
   *
   * Le contenu sur le disque n'est pas ouvert : seule l'enveloppe change.
   */
  private async rotateFiles(
    dryRun: boolean,
    targetVersion: string,
  ): Promise<{ scanned: number; rewrapped: number }> {
    let scanned = 0;
    let rewrapped = 0;
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.prisma.file.findMany({
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          keyVersion: true,
          dekWrapped: true,
          originalNameEnc: true,
        },
      });

      if (batch.length === 0) {
        break;
      }

      cursor = batch[batch.length - 1].id;
      scanned += batch.length;

      for (const file of batch) {
        if (file.keyVersion === targetVersion) {
          continue;
        }

        rewrapped += 1;

        if (dryRun) {
          continue;
        }

        // Déballer puis resceller : la clé du fichier est identique, seule
        // l'enveloppe change. Le fichier chiffré reste donc valide tel quel.
        const dataKey = this.crypto.open(file.dekWrapped);
        const originalName = this.crypto.open(file.originalNameEnc);

        await this.prisma.file.update({
          where: { id: file.id },
          data: {
            dekWrapped: this.crypto.seal(dataKey),
            originalNameEnc: this.crypto.seal(originalName),
            keyVersion: targetVersion,
          },
        });
      }
    }

    return { scanned, rewrapped };
  }

  /**
   * Re-scelle les emails de destinataires restés sur une ancienne clé.
   *
   * Les partages n'ont pas de colonne de version : on la lit dans la valeur
   * scellée elle-même. L'index aveugle, lui, est inchangé — il dépend de
   * `HMAC_INDEX_KEY`, qui suit son propre cycle.
   */
  private async rotateShares(
    dryRun: boolean,
    targetVersion: string,
  ): Promise<{ scanned: number; rewrapped: number }> {
    let scanned = 0;
    let rewrapped = 0;
    let cursor: string | undefined;

    for (;;) {
      const batch = await this.prisma.share.findMany({
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        where: { recipientEmailEnc: { not: null } },
        select: { id: true, recipientEmailEnc: true },
      });

      if (batch.length === 0) {
        break;
      }

      cursor = batch[batch.length - 1].id;
      scanned += batch.length;

      for (const share of batch) {
        const sealed = share.recipientEmailEnc;

        if (!sealed || this.crypto.versionOf(sealed) === targetVersion) {
          continue;
        }

        rewrapped += 1;

        if (dryRun) {
          continue;
        }

        await this.prisma.share.update({
          where: { id: share.id },
          data: { recipientEmailEnc: this.crypto.seal(this.crypto.open(sealed)) },
        });
      }
    }

    return { scanned, rewrapped };
  }
}
