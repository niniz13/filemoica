import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import { RequireRole, RolesGuard } from '../auth/roles.guard';
import type { AccessTokenPayload } from '../auth/token.service';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { Role } from '../generated/prisma/enums';
import { AdminService } from './admin.service';
import {
  ChangePlanDto,
  ChangeRoleDto,
  ManagedUserResponse,
  RevokedSessionsResponse,
  ServiceStatsResponse,
} from './dto/admin.dto';

/**
 * Administration des comptes.
 *
 * ## Deux gardes, deux questions différentes
 *
 * Le garde de session demande « qui êtes-vous ? », le garde de rôles « en avez-
 * vous le droit ? ». Les deux s'appliquent ici : une session valide ne suffit
 * pas, il faut être administrateur.
 *
 * ## Ce que ces routes ne permettent pas
 *
 * **Aucun accès au contenu.** Un administrateur voit combien de fichiers un
 * compte possède, jamais lesquels, et ne peut en télécharger aucun. La
 * confidentialité des dépôts ne souffre pas d'exception pour l'administration —
 * sans quoi elle n'en serait pas une.
 */
@ApiTags('Administration')
@ApiCookieAuth('access_token')
@ApiResponse({
  status: 401,
  description: 'Session absente, expirée ou révoquée.',
  type: ApiErrorResponse,
})
@ApiResponse({
  status: 403,
  description:
    '`INSUFFICIENT_ROLE` — session valide, mais le compte n\'est pas administrateur.',
  type: ApiErrorResponse,
})
@RequireRole(Role.ADMIN)
@UseGuards(RolesGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** Vue d'ensemble du service. */
  @ApiOperation({
    summary: 'Statistiques du service',
    description:
      'Comptes, fichiers et partages. Le volume stocké est ce qui détermine la facture d\'hébergement.',
  })
  @ApiOkResponse({ type: ServiceStatsResponse })
  @Get('stats')
  async stats(): Promise<ServiceStatsResponse> {
    return this.admin.stats();
  }

  /** Liste les comptes. */
  @ApiOperation({
    summary: 'Lister les comptes',
    description:
      'Offre, rôle, consommation du mois et **nombre** de fichiers — jamais lesquels.',
  })
  @ApiOkResponse({ type: [ManagedUserResponse] })
  @Get('users')
  async listUsers(): Promise<ManagedUserResponse[]> {
    return this.admin.listUsers();
  }

  /** Bascule un compte entre offre gratuite et payante. */
  @ApiOperation({
    summary: 'Changer l\'offre d\'un compte',
    description:
      'Remplace le passage par une transaction bancaire : le service démontre la mécanique du quota, pas l\'encaissement.',
  })
  @ApiOkResponse({ type: ManagedUserResponse })
  @ApiResponse({
    status: 404,
    description: '`USER_NOT_FOUND` — compte introuvable.',
    type: ApiErrorResponse,
  })
  @Patch('users/:id/plan')
  async changePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ChangePlanDto,
  ): Promise<ManagedUserResponse> {
    return this.admin.changePlan(id, input.plan);
  }

  /** Accorde ou retire les droits d'administration. */
  @ApiOperation({
    summary: 'Changer le rôle d\'un compte',
    description:
      'Prend effet immédiatement : le rôle est relu en base à chaque appel, et non porté par le jeton de session.',
  })
  @ApiOkResponse({ type: ManagedUserResponse })
  @ApiResponse({
    status: 400,
    description:
      '`CANNOT_DEMOTE_SELF` — un administrateur ne peut pas se retirer ses propres droits.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description: '`USER_NOT_FOUND` — compte introuvable.',
    type: ApiErrorResponse,
  })
  @Patch('users/:id/role')
  async changeRole(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ChangeRoleDto,
    @CurrentUser() actor: AccessTokenPayload,
  ): Promise<ManagedUserResponse> {
    return this.admin.changeRole(actor.sub, id, input.role);
  }

  /** Coupe toutes les sessions d'un compte. */
  @ApiOperation({
    summary: 'Révoquer les sessions d\'un compte',
    description:
      'Pour un compte soupçonné compromis. L\'utilisateur devra se reconnecter avec son mot de passe.',
  })
  @ApiOkResponse({ type: RevokedSessionsResponse })
  @ApiResponse({
    status: 404,
    description: '`USER_NOT_FOUND` — compte introuvable.',
    type: ApiErrorResponse,
  })
  @Post('users/:id/revoke-sessions')
  async revokeSessions(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<RevokedSessionsResponse> {
    return { revoked: await this.admin.revokeSessions(id) };
  }
}
