import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import { EnvironmentVariables, NodeEnv } from '../config/env.validation';

/** Nom du cookie portant l'access token. */
export const ACCESS_COOKIE = 'access_token';

/** Nom du cookie portant le refresh token. */
export const REFRESH_COOKIE = 'refresh_token';

/**
 * Chemin restreint du cookie de rafraîchissement.
 *
 * Le navigateur ne l'enverra que vers `/api/auth/*`, donc jamais sur les routes
 * de fichiers ou de partage. Un jeton qui ne circule pas est un jeton qu'on ne
 * peut pas intercepter au passage.
 *
 * Ce chemin couvre volontairement tout `/api/auth` et pas seulement
 * `/api/auth/refresh` : la déconnexion a elle aussi besoin de ce cookie pour
 * révoquer la session en base.
 */
const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * Pose et retire les cookies de session.
 *
 * ## Pourquoi des cookies plutôt que `localStorage`
 *
 * Un jeton rangé dans `localStorage` est lisible par n'importe quel JavaScript
 * de la page — une seule faille d'injection de script suffit à l'exfiltrer. Un
 * cookie `httpOnly` est invisible au JavaScript : même une injection réussie ne
 * permet pas de lire la session.
 *
 * La contrepartie est le risque CSRF, puisque le navigateur envoie ces cookies
 * automatiquement. Il est traité par `SameSite=Strict`, la liste blanche CORS et
 * le garde CSRF.
 */
@Injectable()
export class CookieService {
  constructor(
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Pose les deux cookies de session. */
  setSessionCookies(
    response: Response,
    tokens: { accessToken: string; refreshToken: string; refreshExpiresAt: Date },
  ): void {
    response.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...this.baseOptions(),
      path: '/',
    });

    response.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.baseOptions(),
      path: REFRESH_COOKIE_PATH,
      expires: tokens.refreshExpiresAt,
    });
  }

  /**
   * Retire les deux cookies.
   *
   * Les options doivent correspondre exactement à celles de la pose — chemin
   * compris — sinon le navigateur conserve le cookie d'origine et l'utilisateur
   * reste connecté côté client.
   */
  clearSessionCookies(response: Response): void {
    response.clearCookie(ACCESS_COOKIE, { ...this.baseOptions(), path: '/' });
    response.clearCookie(REFRESH_COOKIE, {
      ...this.baseOptions(),
      path: REFRESH_COOKIE_PATH,
    });
  }

  /**
   * Options communes aux deux cookies.
   *
   * - `httpOnly` : invisible au JavaScript de la page ;
   * - `secure` : transmis uniquement en HTTPS. Activé hors développement, sinon
   *   aucun cookie ne serait posé en local, où le service tourne en HTTP ;
   * - `sameSite: 'strict'` : jamais joint à une requête venue d'un autre site,
   *   ce qui constitue la première couche de défense CSRF.
   */
  private baseOptions(): CookieOptions {
    const nodeEnv = this.config.get('NODE_ENV', { infer: true });
    const domain = this.config.get('COOKIE_DOMAIN', { infer: true });

    return {
      httpOnly: true,
      secure: nodeEnv === NodeEnv.Production,
      sameSite: 'strict',
      ...(domain ? { domain } : {}),
    };
  }
}
