import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

/** État de santé renvoyé par `/health`. */
export interface HealthReport {
  /** `ok` si toutes les dépendances répondent, `degraded` sinon. */
  status: 'ok' | 'degraded';
  /** Version applicative, pour savoir quelle version tourne réellement. */
  version: string;
  /** État de chaque dépendance vérifiée. */
  checks: {
    database: 'up' | 'down';
  };
  /** Horodatage de la vérification, en ISO 8601. */
  checkedAt: string;
}

/**
 * Calcule l'état de santé du service.
 *
 * Le contrat avec SRC est simple : tant que `/health` répond 200, le service
 * est utilisable ; dès qu'il répond 503, il y a un problème à regarder.
 * Cette distinction est ce qui rendra visible la panne pendant le test
 * d'incident — une base arrêtée doit faire basculer la sonde, pas passer
 * inaperçue jusqu'à ce qu'un utilisateur tombe dessus.
 */
@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async check(): Promise<HealthReport> {
    const databaseUp = await this.prisma.isReachable();

    return {
      status: databaseUp ? 'ok' : 'degraded',
      // Renseignée au déploiement par SRC (tag git). Permet de vérifier d'un
      // coup d'œil quelle version tourne réellement — utile le jour de la
      // démonstration, où la version de référence est celle du rendu.
      version: this.config.get('APP_VERSION', { infer: true }),
      checks: {
        database: databaseUp ? 'up' : 'down',
      },
      checkedAt: new Date().toISOString(),
    };
  }
}
