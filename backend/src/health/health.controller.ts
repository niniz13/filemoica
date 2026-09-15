import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { HealthReport, HealthService } from './health.service';

/**
 * Sonde de supervision, consommée par l'équipe SRC.
 *
 * Volontairement hors du préfixe `/api` et sans authentification : c'est une
 * URL d'infrastructure, appelée par le reverse proxy et l'orchestrateur, pas
 * par le front. Elle ne révèle que l'état des dépendances et la version — rien
 * qui puisse servir à un attaquant.
 */
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Le statut HTTP porte l'information, pas seulement le corps de la réponse :
   * un orchestrateur regarde le code, pas le JSON. Base injoignable donc
   * **503**, ce qui permet de retirer l'instance du service au lieu de lui
   * envoyer des requêtes vouées à échouer.
   */
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
