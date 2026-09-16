import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/decorators';
import { HealthResponse } from './dto/health.response';
import { HealthReport, HealthService } from './health.service';

/**
 * Sonde de supervision, consommée par l'équipe SRC.
 *
 * Volontairement hors du préfixe `/api` et sans authentification : c'est une
 * URL d'infrastructure, appelée par le reverse proxy et l'orchestrateur, pas
 * par le front. Elle ne révèle que l'état des dépendances et la version — rien
 * qui puisse servir à un attaquant.
 */
@ApiTags('Supervision')
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Le statut HTTP porte l'information, pas seulement le corps de la réponse :
   * un orchestrateur regarde le code, pas le JSON. Base injoignable donc
   * **503**, ce qui permet de retirer l'instance du service au lieu de lui
   * envoyer des requêtes vouées à échouer.
   */
  @ApiOperation({
    summary: 'État du service',
    description:
      'Exécute un `SELECT 1` réel en base. Sans authentification et hors du préfixe `/api` : c\'est une URL d\'infrastructure.',
  })
  @ApiResponse({ status: 200, description: 'Service sain.', type: HealthResponse })
  @ApiResponse({
    status: 503,
    description: 'Base injoignable. L\'orchestrateur doit retirer l\'instance.',
    type: HealthResponse,
  })
  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const report = await this.health.check();

    response.status(
      report.status === 'ok'
        ? HttpStatus.OK
        : HttpStatus.SERVICE_UNAVAILABLE,
    );

    return report;
  }
}
