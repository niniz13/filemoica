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

      /**
       * Solde de quota mensuel, en octets, déposé par le garde de quota.
       *
       * Le moteur de réception s'en sert pour interrompre un dépôt à l'octet
       * près, sans avoir à interroger la base au milieu du flux.
       */
      quotaRemainingBytes?: number;
    }
  }
}

export {};
