import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
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
import { FileResponse } from './dto/file.response';
import { QuotaResponse } from './dto/quota.response';
import type { EncryptedUpload } from './encrypted-upload.storage';
import { FilesService } from './files.service';
import { QuotaGuard } from './quota.guard';
import { QuotaService } from './quota.service';

/**
 * Dépôt et gestion des fichiers.
 *
 * Toutes les routes exigent une session : le garde global les protège sans
 * qu'il soit nécessaire de le déclarer ici.
 */
@ApiTags('Fichiers')
@ApiCookieAuth('access_token')
@ApiResponse({
  status: 401,
  description: 'Session absente, expirée ou révoquée.',
  type: ApiErrorResponse,
})
@Controller('files')
export class FilesController {
  constructor(
    private readonly files: FilesService,
    private readonly quotas: QuotaService,
  ) {}

  /**
   * Dépose un fichier.
   *
   * Le contenu est chiffré pendant sa réception : il n'existe à aucun moment en
   * clair sur le serveur.
   */
  @ApiOperation({ summary: 'Déposer un fichier' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary' },
      },
    },
  })
  @ApiCreatedResponse({ description: 'Fichier déposé.', type: FileResponse })
  @ApiResponse({
    status: 400,
    description: '`FILE_REQUIRED` — aucun fichier dans la requête.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 413,
    description: '`FILE_TOO_LARGE` — taille maximale dépassée.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 415,
    description: '`FILE_TYPE_NOT_ALLOWED` — format refusé, d\'après ses octets de signature.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 402,
    description:
      '`QUOTA_EXCEEDED` — volume mensuel de l\'offre atteint. Le compteur repart le 1er du mois.',
    type: ApiErrorResponse,
  })
  @UseGuards(QuotaGuard)
  @Post()
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: EncryptedUpload | undefined,
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<FileResponse> {
    if (!file) {
      throw new BadRequestException({
        error: 'FILE_REQUIRED',
        message: 'Aucun fichier reçu. Le champ attendu s\'appelle « file ».',
      });
    }

    return this.files.register(user.sub, file);
  }

  /**
   * État du quota mensuel.
   *
   * Déclarée avant `:id` : sans cela, « quota » serait pris pour un
   * identifiant de fichier par la route de suppression.
   */
  @ApiOperation({
    summary: 'Consulter son quota',
    description:
      'Volume déposé ce mois-ci et solde restant. Le quota mesure ce qui a été **déposé**, pas l\'espace occupé : supprimer un fichier ne rend pas de quota.',
  })
  @ApiOkResponse({ type: QuotaResponse })
  @Get('quota')
  async quota(
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<QuotaResponse> {
    return this.quotas.statusFor(user.sub);
  }

  /** Liste les fichiers déposés par l'utilisateur connecté. */
  @ApiOperation({
    summary: 'Lister ses fichiers',
    description:
      'Ne renvoie que les fichiers de l\'utilisateur connecté. Les noms sont déchiffrés pour l\'affichage.',
  })
  @ApiOkResponse({ type: [FileResponse] })
  @Get()
  async list(@CurrentUser() user: AccessTokenPayload): Promise<FileResponse[]> {
    return this.files.listOwnedBy(user.sub);
  }

  /** Supprime définitivement un fichier et son contenu. */
  @ApiOperation({
    summary: 'Supprimer un fichier',
    description:
      'Renvoie 404 si le fichier appartient à quelqu\'un d\'autre : un 403 confirmerait son existence et permettrait de dénombrer les fichiers du service.',
  })
  @ApiNoContentResponse({ description: 'Fichier supprimé.' })
  @ApiResponse({
    status: 404,
    description: '`FILE_NOT_FOUND` — inexistant, ou appartenant à autrui.',
    type: ApiErrorResponse,
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':id')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AccessTokenPayload,
  ): Promise<void> {
    await this.files.remove(user.sub, id);
  }
}
