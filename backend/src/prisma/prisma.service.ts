import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import type { EnvironmentVariables } from '../config/env.validation';
import { PrismaClient } from '../generated/prisma/client';

/**
 * Accès à la base de données.
 *
 * Enveloppe le client Prisma dans le cycle de vie de Nest : la connexion est
 * ouverte au démarrage du module et fermée proprement à l'arrêt, ce qui évite
 * de laisser des connexions ouvertes côté PostgreSQL à chaque redéploiement.
 *
 * L'URL est passée explicitement depuis la configuration validée plutôt que
 * lue dans `process.env` : c'est la même source de vérité que le reste du
 * service, déjà vérifiée au démarrage.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService<EnvironmentVariables, true>) {
    // Prisma 7 passe par un adaptateur de pilote : c'est `pg` qui parle à
    // PostgreSQL, Prisma ne fait plus que construire les requêtes.
    super({
      adapter: new PrismaPg({
        connectionString: config.get('DATABASE_URL', { infer: true }),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connexion à la base de données établie');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Vérifie que la base répond réellement.
   *
   * Une connexion ouverte ne prouve rien : elle peut rester dans le pool alors
   * que le serveur est tombé. Cette requête triviale est le seul moyen de
   * savoir si la base est réellement joignable — c'est ce que sonde `/health`,
   * et ce qui rendra visible la panne pendant le test d'incident.
   */
  async isReachable(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error(
        'Base de données injoignable',
        error instanceof Error ? error.stack : String(error),
      );
      return false;
    }
  }
}
