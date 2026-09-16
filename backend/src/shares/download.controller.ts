import {
  Controller,
  Get,
  Headers,
  Logger,
  Param,
  ParseUUIDPipe,
  Res,
} from '@nestjs/common';
import {
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { pipeline } from 'node:stream/promises';
import { Public } from '../auth/decorators';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { CryptoService } from '../crypto/crypto.service';
import { FileStorage } from '../storage/file-storage';
import { ShareInfoResponse } from './dto/share.response';
import { SharesService } from './shares.service';

/** En-tête portant le mot de passe d'un lien protégé. */
const PASSWORD_HEADER = 'x-share-password';

/**
 * Téléchargement d'un fichier partagé. **Sans compte.**
 *
 * Déposer exige un compte, recevoir non. Le destinataire clique sur le lien
 * qu'on lui a transmis, et récupère le fichier — lui demander de s'inscrire
 * reviendrait à lui imposer une démarche pour rendre service à quelqu'un
 * d'autre.
 *
 * Le jeton est donc le secret. Ce qui le rend acceptable :
 *
 * - **32 octets aléatoires**, hors de portée d'une attaque par essais ;
 * - une **durée de vie** choisie par le déposant, jamais illimitée ;
 * - un **mot de passe facultatif**, qui rend un lien intercepté inutilisable ;
 * - la **révocation**, immédiate et à tout moment.
 */
@ApiTags('Partages')
@Public()
@Controller('download')
export class DownloadController {
  private readonly logger = new Logger(DownloadController.name);

  constructor(
    private readonly shares: SharesService,
    private readonly crypto: CryptoService,
    private readonly storage: FileStorage,
  ) {}

  /**
   * Décrit le lien sans le consommer.
   *
   * Permet au front d'afficher une page d'accueil — nom du fichier, date
   * d'expiration — et de demander le mot de passe avant de lancer le
   * téléchargement, plutôt que de heurter une erreur.
   *
   * Déclarée avant la route de téléchargement pour que « info » ne soit pas
   * pris pour un jeton.
   */
  @ApiOperation({
    summary: 'Consulter un lien',
    description:
      'Sans compte. Quand le lien est protégé, la liste des fichiers n\'est pas divulguée : seul le fait qu\'un mot de passe est requis.',
  })
  @ApiOkResponse({ type: ShareInfoResponse })
  @ApiResponse({
    status: 403,
    description: '`SHARE_REVOKED` — lien révoqué.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description: '`SHARE_NOT_FOUND` — ce lien n\'existe pas.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 410,
    description: '`SHARE_EXPIRED` — le lien a existé, sa durée est écoulée.',
    type: ApiErrorResponse,
  })
  @ApiHeader({
    name: 'X-Share-Password',
    required: false,
    description:
      'Mot de passe du lien, s\'il est protégé. Fourni ici, il révèle la liste des fichiers sans qu\'il soit nécessaire de le ressaisir pour chaque téléchargement.',
  })
  @ApiResponse({
    status: 403,
    description: '`SHARE_PASSWORD_INVALID` — mot de passe fourni mais incorrect.',
    type: ApiErrorResponse,
  })
  @Get(':token/info')
  async info(
    @Param('token') token: string,
    @Headers(PASSWORD_HEADER) password: string | undefined,
  ): Promise<ShareInfoResponse> {
    return this.shares.describe(token, password);
  }

  @ApiOperation({
    summary: 'Télécharger un fichier du partage',
    description:
      'Sans compte : le lien suffit. Le fichier demandé doit faire partie du partage. Le contenu est déchiffré à la volée, sans jamais être écrit en clair sur le serveur.',
  })
  @ApiHeader({
    name: 'X-Share-Password',
    required: false,
    description:
      'Mot de passe du lien, s\'il est protégé. Transmis en en-tête et non dans l\'URL, pour qu\'il n\'atterrisse ni dans l\'historique du navigateur ni dans les journaux des serveurs traversés.',
  })
  @ApiResponse({ status: 200, description: 'Contenu du fichier.' })
  @ApiResponse({
    status: 401,
    description: '`SHARE_PASSWORD_REQUIRED` — lien protégé, mot de passe absent.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 403,
    description:
      '`SHARE_REVOKED` — lien révoqué, ou `SHARE_PASSWORD_INVALID` — mot de passe incorrect.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 404,
    description:
      '`SHARE_NOT_FOUND` — ce lien n\'existe pas, ou `FILE_NOT_IN_SHARE` — ce fichier n\'en fait pas partie.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 410,
    description: '`SHARE_EXPIRED` — le lien a existé, sa durée est écoulée.',
    type: ApiErrorResponse,
  })
  // Le jeton fait 32 octets aléatoires : le deviner est hors de portée, et ce
  // n'est pas lui qu'on protège ici. C'est le **mot de passe du lien**, choisi
  // par un humain, qu'on empêche d'éprouver par essais successifs.
  //
  // La limite est large : un lien couvre désormais plusieurs fichiers, et son
  // destinataire les télécharge légitimement les uns après les autres.
  @RateLimit({ limit: 60, windowSeconds: 300 })
  @Get(':token/file/:fileId')
  async download(
    @Param('token') token: string,
    @Param('fileId', ParseUUIDPipe) fileId: string,
    @Headers(PASSWORD_HEADER) password: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    // Lève 404, 403, 410 ou 401 selon le contrôle qui échoue. Rien n'est ouvert
    // tant qu'ils ne sont pas tous passés.
    const granted = await this.shares.authorizeDownload(token, fileId, password);

    // Sur un lien à usage unique, le fichier est réservé **avant** l'envoi :
    // deux téléchargements simultanés du même fichier ne doivent pas réussir
    // tous les deux. La réservation porte sur le fichier et non sur le lien,
    // puisque celui-ci en couvre potentiellement plusieurs.
    if (granted.burnAfterDownload) {
      await this.shares.claimFile(granted.shareId, fileId);
    }

    this.harden(response, granted.originalName);

    const dataKey = this.crypto.open(granted.dekWrapped);
    const decipher = this.crypto.createContentDecipher(
      dataKey,
      Buffer.from(granted.contentIv, 'base64'),
      Buffer.from(granted.contentAuthTag, 'base64'),
    );

    try {
      // Déchiffrement à la volée : le fichier n'existe en clair que dans le
      // flux qui part vers le destinataire, jamais sur le disque du serveur.
      //
      // `end: false` laisse la réponse ouverte : sans cela elle se refermerait
      // dès le dernier octet, et la consommation du lien s'exécuterait après
      // coup — invisible du client, et impossible à signaler en cas d'échec.
      await pipeline(
        await this.storage.openRead(granted.storageName),
        decipher,
        response,
        { end: false },
      );
    } catch (error) {
      // L'intégrité GCM se vérifie à la fin du flux, donc après l'envoi des
      // en-têtes : impossible de changer le statut à ce stade. On coupe la
      // connexion, ce qui donne au destinataire un téléchargement manifestement
      // interrompu plutôt qu'un fichier corrompu qu'il croirait valide.
      this.logger.error(
        `Échec du déchiffrement de ${granted.storageName} — fichier altéré ou clé invalide`,
        error instanceof Error ? error.stack : String(error),
      );

      // Le transfert a échoué : le fichier est rendu. Le compter comme
      // téléchargé alors que le destinataire n'a rien reçu serait le pire des
      // deux mondes.
      if (granted.burnAfterDownload) {
        await this.shares.releaseFile(granted.shareId, fileId);
      }

      response.destroy();
      return;
    }

    // Le fichier est parti en entier. Si c'était le dernier du lien, celui-ci
    // est définitivement consommé et ses fichiers effacés du serveur.
    if (granted.burnAfterDownload) {
      try {
        await this.shares.completeIfFullyDownloaded(granted.shareId);
      } catch (error) {
        // Le contenu est déjà parti : on ne peut plus rien signaler au client,
        // et tenter de le faire échouerait sur une réponse déjà entamée. Le
        // fichier reste marqué téléchargé, donc inutilisable par ce lien — il
        // ne subsiste au pire que des octets qui auraient dû disparaître.
        this.logger.error(
          `Le partage ${granted.shareId} n'a pas pu être consommé après un téléchargement à usage unique`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    response.end();
  }

  /**
   * Pose les en-têtes qui protègent le fichier et le lien.
   *
   * ## Empêcher le navigateur d'interpréter le fichier
   *
   * C'est **la** protection réelle contre un fichier malveillant, bien plus que
   * la liste des formats acceptés. Sans elle, un document HTML ou une image
   * vectorielle téléchargés depuis notre domaine s'exécuteraient dans notre
   * origine, avec accès à tout ce qui s'y trouve.
   *
   * ## Empêcher le lien de fuiter
   *
   * Le jeton étant le seul secret, il ne doit pas s'échapper par un chemin
   * détourné : `no-referrer` l'empêche de partir vers un site tiers, et
   * `no-store` évite qu'un relais ou un cache conserve le fichier déchiffré.
   */
  private harden(response: Response, originalName: string): void {
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader(
      'Content-Disposition',
      // Deux formes : la version simplifiée pour les clients anciens, et la
      // version encodée qui préserve accents et caractères non latins.
      `attachment; filename="${this.asciiFallback(originalName)}"; filename*=UTF-8''${encodeURIComponent(originalName)}`,
    );
  }

  /**
   * Réduit un nom de fichier à de l'ASCII sans guillemet.
   *
   * Un guillemet non échappé dans un nom de fichier casserait l'en-tête et
   * permettrait d'y injecter des directives.
   */
  private asciiFallback(name: string): string {
    return name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  }
}
