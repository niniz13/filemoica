import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { QuotaService } from './quota.service';

/**
 * Prépare le contrôle de quota. **Ne refuse rien lui-même.**
 *
 * ## Pourquoi un garde qui laisse toujours passer
 *
 * Les gardes sont le seul point d'extension, avec accès à l'injection de
 * dépendances, qui s'exécute **avant** la réception du corps de la requête.
 * C'est donc ici qu'on peut interroger la base pour connaître le solde du
 * compte, puis le déposer sur la requête à l'intention du moteur de réception.
 *
 * ## Pourquoi le refus n'a pas lieu ici
 *
 * Répondre avant que le client ait fini d'envoyer son fichier coupe la
 * connexion : le client reçoit une erreur réseau au lieu du message expliquant
 * que son quota est atteint. Drainer la requête à la main ne suffit pas à
 * éviter cette coupure.
 *
 * Le refus est donc porté par le moteur de réception, à l'intérieur du flux,
 * où l'interruption est gérée proprement — exactement comme l'est déjà le
 * dépassement de taille maximale. Le dépôt est interrompu dès l'octet de trop,
 * rien n'est chiffré ni écrit, et le client reçoit un vrai **402**.
 */
@Injectable()
export class QuotaGuard implements CanActivate {
  constructor(private readonly quota: QuotaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.user?.sub;

    if (userId) {
      const status = await this.quota.statusFor(userId);
      request.quotaRemainingBytes = status.remainingBytes;
    }

    return true;
  }
}
