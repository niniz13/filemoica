import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { QuotaService } from '../files/quota.service';
import { Plan, Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** Un compte tel que l'administration le voit. */
export interface ManagedUser {
  id: string;
  email: string;
  role: Role;
  plan: Plan;
  createdAt: Date;
  /** Nombre de fichiers déposés — jamais leur nom ni leur contenu. */
  fileCount: number;
  /** Volume déposé ce mois-ci, en octets. */
  usedBytesThisMonth: number;
  /** Volume mensuel autorisé par l'offre, en octets. */
  quotaBytes: number;
}

/** Vue d'ensemble du service. */
export interface ServiceStats {
  users: { total: number; free: number; premium: number };
  files: { total: number; totalBytes: number };
  shares: { total: number; active: number };
}

/**
 * Administration des comptes.
 *
 * ## La frontière à ne pas franchir
 *
 * L'administration porte sur les **comptes**, jamais sur le **contenu**. Aucune
 * méthode de ce service ne renvoie un nom de fichier, un contenu, ou de quoi en
 * déchiffrer un. Un administrateur voit *combien* de fichiers un compte
 * possède, pas *lesquels*.
 *
 * C'est une frontière de conception, pas une limitation technique : le serveur
 * détient les clés et pourrait tout lire. Ne pas offrir ce chemin dans l'API
 * est précisément ce qui rend la promesse de confidentialité défendable.
 */
@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly quota: QuotaService,
  ) {}

  /** Liste les comptes, du plus récent au plus ancien. */
  async listUsers(): Promise<ManagedUser[]> {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        plan: true,
        createdAt: true,
        // Un décompte, pas les fichiers eux-mêmes.
        _count: { select: { files: true } },
      },
    });

    return Promise.all(
      users.map(async (user) => {
        const quota = await this.quota.statusFor(user.id);

        return {
          id: user.id,
          email: user.email,
          role: user.role,
          plan: user.plan,
          createdAt: user.createdAt,
          fileCount: user._count.files,
          usedBytesThisMonth: quota.usedBytes,
          quotaBytes: quota.limitBytes,
        };
      }),
    );
  }

  /**
   * Change l'offre d'un compte.
   *
   * C'est ce qui remplace le passage par une transaction bancaire : le service
   * démontre la mécanique du quota, pas l'encaissement.
   */
  async changePlan(userId: string, plan: Plan): Promise<ManagedUser> {
    await this.requireUser(userId);

    await this.prisma.user.update({ where: { id: userId }, data: { plan } });

    this.logger.log(`Offre du compte ${userId} changée en ${plan}`);

    return this.requireManagedUser(userId);
  }

  /**
   * Change le rôle d'un compte.
   *
   * @throws {BadRequestException} Si un administrateur tente de se retirer
   * lui-même ses droits — voir {@link changeRole}.
   */
  async changeRole(
    actorId: string,
    userId: string,
    role: Role,
  ): Promise<ManagedUser> {
    await this.requireUser(userId);

    // Un administrateur qui se rétrograde perd l'accès au panneau, et si c'est
    // le dernier, plus personne ne peut le lui rendre sans passer par la base.
    // Le refus est plus utile qu'un service qu'il faut réparer à la main.
    if (actorId === userId && role !== Role.ADMIN) {
      throw new BadRequestException({
        error: 'CANNOT_DEMOTE_SELF',
        message:
          'Vous ne pouvez pas retirer vos propres droits d\'administration.',
      });
    }

    await this.prisma.user.update({ where: { id: userId }, data: { role } });

    this.logger.warn(
      `Rôle du compte ${userId} changé en ${role} par ${actorId}`,
    );

    return this.requireManagedUser(userId);
  }

  /**
   * Révoque toutes les sessions d'un compte.
   *
   * Utile quand un compte est soupçonné compromis : l'utilisateur devra se
   * reconnecter avec son mot de passe.
   *
   * Les access tokens déjà émis restent valides jusqu'à 15 minutes — les
   * inscrire un par un sur liste de refus demanderait de connaître leurs
   * identifiants, que le serveur ne conserve pas. C'est une limite assumée de
   * la durée courte choisie pour ces jetons.
   *
   * @returns Le nombre de sessions coupées.
   */
  async revokeSessions(userId: string): Promise<number> {
    await this.requireUser(userId);

    const revoked = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    this.logger.warn(
      `${revoked.count} session(s) révoquée(s) pour le compte ${userId}`,
    );

    return revoked.count;
  }

  /**
   * Vue d'ensemble du service.
   *
   * Sert au suivi d'exploitation et alimente l'argumentaire de coûts : le
   * volume stocké est ce qui détermine la facture d'hébergement.
   */
  async stats(): Promise<ServiceStats> {
    const now = new Date();

    const [total, premium, files, volume, shares, active] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.user.count({ where: { plan: Plan.PREMIUM } }),
      this.prisma.file.count(),
      this.prisma.file.aggregate({ _sum: { sizeBytes: true } }),
      this.prisma.share.count(),
      this.prisma.share.count({
        where: { revoked: false, consumedAt: null, expiresAt: { gt: now } },
      }),
    ]);

    return {
      users: { total, free: total - premium, premium },
      files: { total: files, totalBytes: volume._sum.sizeBytes ?? 0 },
      shares: { total: shares, active },
    };
  }

  /** Vérifie qu'un compte existe, ou échoue. */
  private async requireUser(userId: string): Promise<void> {
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!exists) {
      throw new NotFoundException({
        error: 'USER_NOT_FOUND',
        message: 'Compte introuvable.',
      });
    }
  }

  /** Recharge un compte sous sa forme administrable. */
  private async requireManagedUser(userId: string): Promise<ManagedUser> {
    const users = await this.listUsers();
    const user = users.find((candidate) => candidate.id === userId);

    if (!user) {
      throw new NotFoundException({
        error: 'USER_NOT_FOUND',
        message: 'Compte introuvable.',
      });
    }

    return user;
  }
}
