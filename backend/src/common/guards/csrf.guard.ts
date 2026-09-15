import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';

/**
 * Protection CSRF, sans token à gérer côté front.
 *
 * ## Le problème
 *
 * Nos sessions vivent dans des cookies `httpOnly` : le navigateur les envoie
 * **automatiquement** avec toute requête vers notre domaine, y compris celles
 * déclenchées par un site malveillant. Sans garde-fou, un formulaire caché sur
 * `site-pirate.fr` pourrait faire révoquer les partages d'un utilisateur connecté.
 *
 * ## La défense retenue
 *
 * Trois couches, aucune ne demandant de token au front :
 *
 * 1. `SameSite=Strict` sur les cookies — le navigateur ne les joint pas aux
 *    requêtes venues d'un autre site. C'est l'essentiel de la protection.
 * 2. Une liste blanche CORS d'une seule origine.
 * 3. Ce guard : toute requête qui modifie l'état doit porter un en-tête
 *    personnalisé. Un `<form>` HTML ne peut pas en poser, et une requête
 *    JavaScript qui en pose déclenche un contrôle préalable (preflight) que
 *    notre CORS refuse si l'origine n'est pas la bonne.
 *
 * Le double-submit token classique a été écarté : il demande un cookie
 * supplémentaire lisible en JavaScript et du code côté front, pour une
 * protection équivalente une fois `SameSite=Strict` en place.
 *
 * ## Côté front (IW 1)
 *
 * Une seule ligne à ajouter au wrapper `fetch` :
 * `headers: { 'X-Requested-With': 'XMLHttpRequest' }`.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  /** Méthodes sans effet de bord : rien à protéger, elles ne modifient pas l'état. */
  private static readonly SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

  private static readonly REQUIRED_HEADER = 'x-requested-with';

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (CsrfGuard.SAFE_METHODS.has(request.method.toUpperCase())) {
      return true;
    }

    if (!request.headers[CsrfGuard.REQUIRED_HEADER]) {
      throw new ForbiddenException({
        error: 'CSRF_HEADER_MISSING',
        message:
          "En-tête X-Requested-With absent : requête refusée par la protection CSRF.",
      });
    }

    return true;
  }
}
