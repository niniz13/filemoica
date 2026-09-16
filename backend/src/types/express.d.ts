import type { AccessTokenPayload } from '../auth/token.service';

/**
 * Étend la requête Express avec l'utilisateur authentifié.
 *
 * Le garde de session dépose le contenu du jeton dans `request.user`. Sans
 * cette déclaration, TypeScript ne connaîtrait pas cette propriété et chaque
 * lecture demanderait un transtypage — avec le risque d'y écrire n'importe quoi.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AccessTokenPayload;
    }
  }
}

export {};
