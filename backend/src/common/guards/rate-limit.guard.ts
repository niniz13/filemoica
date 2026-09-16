import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';

/** Clé de métadonnée portant la règle d'une route. */
const RATE_LIMIT_KEY = 'rateLimit';

/** Règle appliquée à une route. */
export interface RateLimitRule {
  /** Nombre de tentatives autorisées dans la fenêtre. */
  limit: number;
  /** Durée de la fenêtre, en secondes. */
  windowSeconds: number;
}

/**
 * Limite le nombre de tentatives sur une route.
 *
 * @example
 * ```ts
 * @RateLimit({ limit: 10, windowSeconds: 60 })
 * @Post('login')
 * ```
 */
export const RateLimit = (rule: RateLimitRule) =>
  SetMetadata(RATE_LIMIT_KEY, rule);

/** Compteur d'une adresse sur une route. */
interface Counter {
  attempts: number;
  resetAt: number;
}

/** Fréquence du nettoyage des compteurs expirés. */
const CLEANUP_INTERVAL_MS = 60_000;

/**
 * Ralentit les tentatives répétées sur les routes sensibles.
 *
 * ## Ce qu'il protège
 *
 * Deux endroits où un secret choisi par un humain peut être deviné : la
 * connexion à un compte, et le mot de passe d'un lien de partage. Le jeton d'un
 * lien, lui, fait 32 octets aléatoires et n'a pas besoin de cette protection —
 * le deviner est hors de portée.
 *
 * Il protège aussi l'inscription, qu'un automate pourrait sinon utiliser pour
 * créer des comptes en masse.
 *
 * ## Pourquoi un compteur en mémoire
 *
 * Le service tourne sur une seule machine (voir
 * `docs/decision-stockage-fichiers.md`), donc un compteur local suffit et évite
 * d'ajouter une dépendance à un cache partagé.
 *
 * **Limite assumée :** avec plusieurs instances, chacune compterait de son côté
 * et la limite effective serait multipliée par leur nombre. Il faudrait alors un
 * compteur partagé — ou laisser le reverse proxy s'en charger.
 *
 * ## Complémentaire du reverse proxy
 *
 * Le proxy limite le volume brut par adresse ; ce garde compte les tentatives
 * sur une route précise. Les deux ne se remplacent pas : le premier protège la
 * disponibilité, le second protège les mots de passe.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly counters = new Map<string, Counter>();
  private lastCleanup = Date.now();

  constructor(
    private readonly reflector: Reflector,
    private readonly enabled: boolean = true,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.enabled) {
      return true;
    }

    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Sans règle déclarée, la route n'est pas limitée.
    if (!rule) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const response = context.switchToHttp().getResponse<Response>();

    this.cleanupIfDue();

    const key = `${request.method} ${request.route?.path ?? request.path}|${request.ip}`;
    const now = Date.now();
    const counter = this.counters.get(key);

    if (!counter || counter.resetAt <= now) {
      this.counters.set(key, {
        attempts: 1,
        resetAt: now + rule.windowSeconds * 1000,
      });
      return true;
    }

    counter.attempts += 1;

    if (counter.attempts > rule.limit) {
      const retryAfter = Math.ceil((counter.resetAt - now) / 1000);
      response.setHeader('Retry-After', retryAfter);

      // L'adresse est journalisée, jamais ce qui a été tenté.
      this.logger.warn(
        `Trop de tentatives sur ${request.method} ${request.path} depuis ${request.ip}`,
      );

      throw new HttpException(
        {
          error: 'TOO_MANY_ATTEMPTS',
          message: `Trop de tentatives. Réessayez dans ${retryAfter} secondes.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return true;
  }

  /**
   * Purge les compteurs expirés.
   *
   * Sans cela, la mémoire croîtrait avec le nombre d'adresses rencontrées. Le
   * nettoyage se fait au fil des requêtes plutôt que sur une minuterie, pour ne
   * pas maintenir le processus éveillé inutilement.
   */
  private cleanupIfDue(): void {
    const now = Date.now();

    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) {
      return;
    }

    this.lastCleanup = now;

    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) {
        this.counters.delete(key);
      }
    }
  }
}
