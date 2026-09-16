import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation';
import { Plan } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from './files.service';

/** Nombre de fichiers examinés par lot. */
const BATCH_SIZE = 200;

/** Ce qu'a fait — ou ferait — une purge. */
export interface RetentionReport {
  dryRun: boolean;
  /** Fichiers examinés. */
  scanned: number;
  /** Fichiers effacés, ou qui le seraient. */
  deleted: number;
  /** Octets libérés, ou qui le seraient. */
  freedBytes: number;
  durationMs: number;
}

/**
 * Efface les fichiers dont la durée de conservation est écoulée.
 *
 * ## La règle, et le piège qu'elle évite
 *
 * Un fichier est effacé quand **deux conditions** sont réunies :
 *
 * 1. il ne lui reste **aucun partage exploitable** — ni actif, ni à venir ;
 * 2. son inactivité dépasse la durée de conservation de l'offre de son
 *    propriétaire.
 *
 * L'inactivité se compte depuis la **fin du dernier partage**, ou depuis le
 * dépôt si le fichier n'a jamais été partagé.
 *
 * La règle naïve — « effacer les fichiers sans partage exploitable » —
 * détruirait les fichiers qu'un utilisateur vient de déposer sans les avoir
 * encore partagés. C'est sa donnée, pas un déchet.
 *
 * ## Pourquoi cette tâche existe
 *
 * Le quota mensuel compte les **dépôts**, pas le stockage. Sans conservation
 * bornée, le disque se remplirait indéfiniment sans qu'aucun compteur ne s'en
 * aperçoive — jusqu'au jour où plus aucun dépôt ne passe.
 *
 * C'est aussi un levier de l'offre : l'offre payante conserve plus longtemps.
 *
 * ## Ce qui rend l'opération sûre
 *
 * - **Simulable** — le mode `dryRun` compte sans rien effacer.
 * - **Conservatrice** — au moindre doute, le fichier est gardé. Un fichier
 *   effacé à tort est irrécupérable ; un fichier gardé un jour de trop ne coûte
 *   que des octets.
 * - **Reprenable** — chaque fichier est traité indépendamment.
 */
@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Durée de conservation d'une offre, en jours. */
  retentionDaysFor(plan: Plan): number {
    return plan === Plan.PREMIUM
      ? this.config.get('PREMIUM_PLAN_RETENTION_DAYS', { infer: true })
      : this.config.get('FREE_PLAN_RETENTION_DAYS', { infer: true });
  }

  async purge(options: { dryRun?: boolean } = {}): Promise<RetentionReport> {
    const dryRun = options.dryRun ?? false;
    const startedAt = Date.now();
    const now = new Date();

    let scanned = 0;
    let deleted = 0;
    let freedBytes = 0;
    let cursor: string | undefined;

    this.logger.log(`Purge des fichiers${dryRun ? ' (simulation)' : ''}`);

    for (;;) {
      const batch = await this.prisma.file.findMany({
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        orderBy: { id: 'asc' },
        select: {
          id: true,
          sizeBytes: true,
          createdAt: true,
          owner: { select: { plan: true } },
          shares: {
            select: {
              share: {
                select: { expiresAt: true, revoked: true, consumedAt: true },
              },
            },
          },
        },
      });

      if (batch.length === 0) {
        break;
      }

      cursor = batch[batch.length - 1].id;
      scanned += batch.length;

      for (const file of batch) {
        const shares = file.shares.map(({ share }) => share);

        // Un seul partage encore exploitable suffit à conserver le fichier.
        const encoreExploitable = shares.some(
          (share) =>
            !share.revoked &&
            share.consumedAt === null &&
            share.expiresAt.getTime() > now.getTime(),
        );

        if (encoreExploitable) {
          continue;
        }

        const inactifDepuis = this.lastActivity(file.createdAt, shares);
        const limite = new Date(
          now.getTime() -
            this.retentionDaysFor(file.owner.plan) * 24 * 60 * 60 * 1000,
        );

        if (inactifDepuis.getTime() > limite.getTime()) {
          continue;
        }

        deleted += 1;
        freedBytes += file.sizeBytes;

        if (dryRun) {
          continue;
        }

        // Passe par le service des fichiers : il revérifie l'absence de
        // partage exploitable avant d'effacer. Une vérification de trop vaut
        // mieux qu'un fichier perdu.
        const efface = await this.files.removeIfNoUsableShare(file.id);

        if (!efface) {
          deleted -= 1;
          freedBytes -= file.sizeBytes;
        }
      }
    }

    const report: RetentionReport = {
      dryRun,
      scanned,
      deleted,
      freedBytes,
      durationMs: Date.now() - startedAt,
    };

    this.logger.log(
      `Purge terminée : ${deleted} fichier(s) sur ${scanned} examiné(s), ${Math.round(freedBytes / 1024)} Ko libérés`,
    );

    return report;
  }

  /**
   * Date de dernière activité d'un fichier.
   *
   * La plus tardive entre son dépôt et la fin de ses partages. Un fichier
   * partagé jusqu'au 30 du mois reste donc conservé à partir de cette date, et
   * non de son dépôt — c'est ce qui empêche d'effacer un fichier dont le lien
   * vient tout juste d'expirer.
   */
  private lastActivity(
    createdAt: Date,
    shares: { expiresAt: Date }[],
  ): Date {
    return shares.reduce(
      (derniere, share) =>
        share.expiresAt.getTime() > derniere.getTime()
          ? share.expiresAt
          : derniere,
      createdAt,
    );
  }
}
