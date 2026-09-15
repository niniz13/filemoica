import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * Corps d'erreur renvoyé par l'API, quelle que soit la panne.
 *
 * Contrat figé avec le front (IW 1) : il peut brancher son affichage sur
 * `error` (code stable, testable) et afficher `message` tel quel à l'utilisateur.
 */
export interface ApiErrorBody {
  /** Code machine stable, en SCREAMING_SNAKE_CASE. Ex : `SHARE_REVOKED`. */
  error: string;
  /** Message lisible par un humain, en français. */
  message: string;
  /** Détail des champs invalides, uniquement pour les erreurs de validation. */
  details?: string[];
}

/**
 * Filtre d'exceptions global : uniformise toutes les erreurs de l'API.
 *
 * Deux raisons d'exister :
 *
 * 1. **Contrat unique** — le front n'a qu'un seul format à gérer, qu'il s'agisse
 *    d'une validation ratée, d'un partage révoqué ou d'un plantage.
 * 2. **Étanchéité** — une exception non prévue (erreur Prisma, bug) ne doit
 *    jamais fuiter sa trace, sa requête SQL ou un chemin serveur vers le client.
 *    On loggue le détail côté serveur, on renvoie un message générique.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const body = this.toErrorBody(exception, status);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // Seul endroit où la vraie erreur est visible : les logs serveur.
      this.logger.error(
        `${request.method} ${request.url} -> ${status}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.debug(
        `${request.method} ${request.url} -> ${status} (${body.error})`,
      );
    }

    response.status(status).json(body);
  }

  /**
   * Traduit une exception quelconque en corps d'erreur normalisé.
   *
   * Trois cas, du plus précis au plus générique :
   * - une exception métier levée avec `{ error, message }` : on la respecte ;
   * - une `HttpException` standard (dont celles du `ValidationPipe`) : on dérive
   *   le code depuis le statut HTTP ;
   * - tout le reste : 500 anonyme.
   */
  private toErrorBody(exception: unknown, status: number): ApiErrorBody {
    if (!(exception instanceof HttpException)) {
      return {
        error: 'INTERNAL_ERROR',
        message: 'Une erreur interne est survenue.',
      };
    }

    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { error: this.codeFromStatus(status), message: payload };
    }

    const record = payload as Record<string, unknown>;

    // Le ValidationPipe renvoie `message` sous forme de tableau de contraintes.
    if (Array.isArray(record.message)) {
      return {
        error: 'VALIDATION_ERROR',
        message: 'La requête est invalide.',
        details: record.message.map(String),
      };
    }

    return {
      // Un code métier explicite prime sur le code dérivé du statut.
      error: this.isBusinessCode(record.error)
        ? record.error
        : this.codeFromStatus(status),
      message:
        typeof record.message === 'string' && record.message.length > 0
          ? record.message
          : exception.message,
    };
  }

  /**
   * Distingue un code métier d'un libellé par défaut de Nest.
   *
   * Nest remplit lui-même le champ `error` avec un libellé lisible
   * (`"Not Found"`, `"Bad Request"`). Sans ce filtre, ce libellé se
   * retrouverait dans notre contrat à la place d'un code stable, et le front
   * brancherait ses conditions sur une chaîne susceptible de changer.
   *
   * Nos propres codes s'écrivent en SCREAMING_SNAKE_CASE : c'est ce qui les
   * rend reconnaissables.
   */
  private isBusinessCode(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
  }

  /**
   * Dérive un code par défaut depuis le statut HTTP (404 -> `NOT_FOUND`).
   *
   * Utilisé seulement quand l'appelant n'a pas fourni de code métier : il vaut
   * mieux un code générique mais stable qu'un champ absent.
   */
  private codeFromStatus(status: number): string {
    return HttpStatus[status] ?? 'ERROR';
  }
}
