import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation';
import { Plan } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** État du quota d'un compte pour le mois en cours. */
export interface QuotaStatus {
  plan: Plan;
  /** Volume déjà déposé ce mois-ci, en octets. */
  usedBytes: number;
  /** Volume mensuel autorisé par l'offre, en octets. */
  limitBytes: number;
  /** Ce qu'il reste à déposer d'ici la fin du mois, en octets. */
  remainingBytes: number;
  /** Mois concerné, au format `AAAA-MM`. */
  period: string;
}

/**
 * Quota mensuel de dépôt, par compte.
 *
 * ## Ce que le quota mesure
 *
 * Le volume **déposé** au cours du mois, pas l'espace occupé. Supprimer un
 * fichier ne rend donc pas de quota : sinon, envoyer puis effacer en boucle
 * suffirait à contourner l'offre gratuite.
 *
 * ## Le mois, pas trente jours glissants
 *
 * Le compteur repart au premier du mois. C'est plus simple à expliquer à un
 * utilisateur — « 200 Mo par mois » — et cela évite d'avoir à recalculer une
 * fenêtre glissante à chaque dépôt.
 */
@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Volume mensuel autorisé par une offre, en octets. */
  limitFor(plan: Plan): number {
    const megabytes =
      plan === Plan.PREMIUM
        ? this.config.get('PREMIUM_PLAN_QUOTA_MB', { infer: true })
        : this.config.get('FREE_PLAN_QUOTA_MB', { infer: true });

    return megabytes * 1024 * 1024;
  }

  /** Établit l'état du quota d'un compte pour le mois en cours. */
  async statusFor(userId: string): Promise<QuotaStatus> {
    const period = this.currentPeriod();

    const [user, usage] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { plan: true },
      }),
      this.prisma.monthlyUsage.findUnique({
        where: { userId_period: { userId, period } },
        select: { bytes: true },
      }),
    ]);

    const limitBytes = this.limitFor(user.plan);
    const usedBytes = Number(usage?.bytes ?? 0n);

    return {
      plan: user.plan,
      usedBytes,
      limitBytes,
      // Jamais négatif : un dépassement marginal ne doit pas afficher un
      // reste absurde à l'utilisateur.
      remainingBytes: Math.max(0, limitBytes - usedBytes),
      period,
    };
  }

  /**
   * Ajoute un dépôt au compteur du mois.
   *
   * L'opération est un `upsert` : la première ligne du mois est créée à la
   * volée, sans qu'aucune tâche n'ait à préparer le terrain le premier du mois.
   */
  async record(userId: string, bytes: number): Promise<void> {
    const period = this.currentPeriod();

    await this.prisma.monthlyUsage.upsert({
      where: { userId_period: { userId, period } },
      create: { userId, period, bytes: BigInt(bytes) },
      update: { bytes: { increment: BigInt(bytes) } },
    });

    this.logger.log(
      `Quota ${period} du compte ${userId} : +${bytes} octets`,
    );
  }

  /** Mois en cours, au format `AAAA-MM`. */
  private currentPeriod(): string {
    const now = new Date();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');

    return `${now.getUTCFullYear()}-${month}`;
  }
}
