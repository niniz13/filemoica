import {
  createParamDecorator,
  ExecutionContext,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AccessTokenPayload } from './token.service';

/** Clé de métadonnée lue par le garde de session. */
export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Ouvre une route aux requêtes non authentifiées.
 *
 * Le garde de session est **global** : toute route est protégée par défaut, et
 * l'ouvrir demande un geste explicite. C'est l'inverse de la configuration
 * habituelle, et c'est voulu — un oubli produit alors une route inaccessible,
 * qu'on remarque immédiatement, plutôt qu'une route ouverte à tous, qu'on ne
 * remarque jamais.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Injecte l'utilisateur authentifié dans un paramètre de contrôleur.
 *
 * @example
 * ```ts
 * @Get()
 * list(@CurrentUser() user: AccessTokenPayload) {
 *   return this.files.listFor(user.sub);
 * }
 * ```
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessTokenPayload | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    return request.user as AccessTokenPayload | undefined;
  },
);
