import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { ACCESS_COOKIE } from './cookie.service';
import { IS_PUBLIC_KEY } from './decorators';
import { TokenService } from './token.service';

/**
 * Garde de session, appliqué à **toutes** les routes.
 *
 * Enregistré globalement : une route est protégée tant qu'elle n'est pas
 * explicitement ouverte par `@Public()`. Un oubli produit donc une route
 * inaccessible — visible au premier essai — plutôt qu'une route ouverte à tous,
 * qui passerait inaperçue jusqu'à ce que quelqu'un la trouve.
 *
 * Le jeton est lu dans un **cookie**, pas dans l'en-tête `Authorization` : le
 * front n'a rien à porter lui-même, et le jeton reste hors de portée du
 * JavaScript de la page.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: TokenService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = request.cookies?.[ACCESS_COOKIE] as string | undefined;

    if (!token) {
      throw new UnauthorizedException({
        error: 'NOT_AUTHENTICATED',
        message: 'Vous devez être connecté pour accéder à cette ressource.',
      });
    }

    // Vérifie la signature, l'expiration, **et** la liste de refus : un jeton
    // encore valide mais révoqué par une déconnexion doit être rejeté.
    const payload = await this.tokens.verifyAccessToken(token);

    if (!payload) {
      throw new UnauthorizedException({
        error: 'SESSION_INVALID',
        message: 'Session expirée ou révoquée. Reconnectez-vous.',
      });
    }

    request.user = payload;

    return true;
  }
}
