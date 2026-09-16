import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators';
import type { AccessTokenPayload } from '../auth/token.service';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { CreateShareDto } from './dto/create-share.dto';
import { CreatedShareResponse, ShareResponse } from './dto/share.response';
import { SharesService } from './shares.service';

/** Création et gestion des liens de partage. */
@ApiTags('Partages')
@ApiCookieAuth('access_token')
@ApiResponse({
  status: 401,
  description: 'Session absente, expirée ou révoquée.',
  type: ApiErrorResponse,
})
@Controller('shares')
export class SharesController {
  constructor(private readonly shares: SharesService) {}

  /**
   * Crée un lien de partage nominatif et daté.
   *
   * Le jeton n'est renvoyé **qu'ici** : la base n'en garde que l'empreinte.
   */
  @ApiOperation({
    summary: 'Partager un fichier',
    description:
      'Produit un lien que le destinataire peut ouvrir **sans compte**. Le déposant en choisit la durée de vie et, s\'il le souhaite, un mot de passe. Le jeton n\'est montré qu\'ici.',
  })
  @ApiCreatedResponse({ type: CreatedShareResponse })
  @ApiResponse({
    status: 404,
    description: '`FILE_NOT_FOUND` — fichier inexistant ou appartenant à autrui.',
    type: ApiErrorResponse,
  })
  @Post()
  async create(
    @Body() input: CreateShareDto,
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<CreatedShareResponse> {
    const share = await this.shares.create(user.sub, input);
    const [detail] = (await this.shares.listOwnedBy(user.sub)).filter(
      (candidate) => candidate.id === share.id,
    );

    return {
      ...detail,
      token: share.token,
      downloadPath: `/api/download/${share.token}`,
    };
  }

  /** Liste les partages créés sur ses propres fichiers. */
  @ApiOperation({
    summary: 'Lister ses partages',
    description:
      'Chaque partage porte son état : `ACTIVE`, `EXPIRED` ou `REVOKED`. Le jeton n\'y figure pas — il n\'est montré qu\'à la création.',
  })
  @ApiOkResponse({ type: [ShareResponse] })
  @Get()
  async list(
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<ShareResponse[]> {
    return this.shares.listOwnedBy(user.sub);
  }

  /** Révoque un lien avant son expiration. */
  @ApiOperation({
    summary: 'Révoquer un partage',
    description:
      'Prend effet immédiatement. Idempotent : révoquer deux fois n\'est pas une erreur.',
  })
  @ApiNoContentResponse({ description: 'Partage révoqué.' })
  @ApiResponse({
    status: 404,
    description: '`SHARE_NOT_FOUND` — inexistant, ou portant sur le fichier d\'autrui.',
    type: ApiErrorResponse,
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Patch(':id/revoke')
  async revoke(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<void> {
    await this.shares.revoke(user.sub, id);
  }
}
