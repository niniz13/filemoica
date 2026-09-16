import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { redactPath } from './redact-path';

/**
 * Journalise une ligne par requête, en JSON.
 *
 * ## Ce qu'une ligne contient
 *
 * Méthode, chemin, statut, durée, identifiant de corrélation, et l'identifiant
 * de l'utilisateur quand la requête est authentifiée. De quoi répondre aux
 * questions d'exploitation : qu'est-ce qui est lent, qu'est-ce qui échoue, et
 * pour qui.
 *
 * ## Ce qu'une ligne ne contient jamais
 *
 * Ni corps de requête, ni en-têtes, ni jeton. Le corps contiendrait les mots de
 * passe à l'inscription ; les en-têtes contiendraient les cookies de session et
 * les mots de passe de liens ; le chemin contiendrait les jetons de partage.
 *
 * C'est pourquoi les chemins sensibles sont normalisés avant d'être écrits :
 * `/api/download/k3Jv8Qw2…` devient `/api/download/:token`. On garde
 * l'information utile — quelqu'un a téléchargé — sans le secret.
 *
 * ## L'identifiant de corrélation
 *
 * Renvoyé au client dans l'en-tête `X-Request-Id`. Un utilisateur qui signale
 * une erreur peut le communiquer, et on retrouve la requête exacte dans les
 * journaux — sans avoir à fouiller par horodatage.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const requestId = randomUUID();

    response.setHeader('X-Request-Id', requestId);

    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

      const entry = {
        requestId,
        method: request.method,
        path: redactPath(request.originalUrl ?? request.url),
        status: response.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        // Présent seulement si le garde de session a validé la requête.
        userId: request.user?.sub,
      };

      // Une erreur serveur mérite le niveau `error` pour ressortir dans une
      // supervision qui filtre par sévérité.
      if (response.statusCode >= 500) {
        this.logger.error(entry);
      } else {
        this.logger.log(entry);
      }
    });

    next();
  }
}
