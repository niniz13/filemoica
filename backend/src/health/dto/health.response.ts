import { ApiProperty } from '@nestjs/swagger';

/** État de chaque dépendance vérifiée. */
export class HealthChecks {
  @ApiProperty({ enum: ['up', 'down'], example: 'up' })
  database: 'up' | 'down';
}

/**
 * Réponse de la sonde de supervision.
 *
 * Décrite ici pour la documentation. Volontairement pauvre : une sonde publique
 * ne doit renseigner ni sur la topologie, ni sur les identifiants.
 */
export class HealthResponse {
  @ApiProperty({
    enum: ['ok', 'degraded'],
    description: '`ok` avec un statut 200, `degraded` avec un statut 503.',
  })
  status: 'ok' | 'degraded';

  @ApiProperty({
    example: 'v1.0.0',
    description: 'Version déployée, renseignée par l\'infrastructure.',
  })
  version: string;

  @ApiProperty({ type: HealthChecks })
  checks: HealthChecks;

  @ApiProperty({ format: 'date-time' })
  checkedAt: string;
}
