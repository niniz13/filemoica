import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Role } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/** Clé de métadonnée portant le rôle exigé par une route. */
const REQUIRED_ROLE_KEY = 'requiredRole';

/**
 * Réserve une route à un rôle.
 *
 * @example
 * ```ts
 * @RequireRole(Role.ADMIN)
 * @Get('users')
 * ```
 */
export const RequireRole = (role: Role) => SetMetadata(REQUIRED_ROLE_KEY, role);

/**
 * Vérifie que l'utilisateur a le rôle exigé par la route.
 *
 * ## Pourquoi le rôle est relu en base
 *
 * Il serait plus rapide de le mettre dans le jeton. Mais un jeton vit 15
 * minutes : un administrateur rétrogradé garderait ses pouvoirs jusqu'à
 * l'expiration de sa session. Pour une élévation de privilèges, ce délai est
 * inacceptable — le retrait doit prendre effet immédiatement.
 *
 * Le coût est d'une requête par appel d'administration, sur un index primaire,
 * et ces routes sont rares.
 *
 * ## Ce que ce garde ne fait pas
 *
 * Il n'ouvre **aucun accès aux fichiers**. L'administration porte sur les
 * comptes, jamais sur le contenu : un administrateur ne peut ni lister, ni
 * télécharger, ni déchiffrer les fichiers d'autrui. Sans cette frontière, la
 * promesse de confidentialité du service ne tiendrait pas.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role | undefined>(
      REQUIRED_ROLE_KEY,
      [context.getHandler(), context.getClass()],
    );

    // Sans rôle exigé, la route n'est pas concernée.
    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.user?.sub;

    if (!userId) {
      // Le garde de session s'exécute avant celui-ci et a déjà tranché.
      return false;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });

    if (user?.role !== required) {
      this.logger.warn(
        `Accès refusé à ${request.method} ${request.path} pour le compte ${userId}`,
      );

      // 403 et non 404 : contrairement aux fichiers, l'existence de la partie
      // administration n'est pas un secret — elle est dans la documentation.
      // Le masquer n'apporterait rien et rendrait le refus incompréhensible.
      throw new ForbiddenException({
        error: 'INSUFFICIENT_ROLE',
        message: 'Cette action est réservée aux administrateurs.',
      });
    }

    return true;
  }
}
