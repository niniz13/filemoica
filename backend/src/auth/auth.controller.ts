import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiErrorResponse } from '../common/dto/api-error.response';
import { RateLimit } from '../common/guards/rate-limit.guard';
import { AuthService } from './auth.service';
import { CookieService, REFRESH_COOKIE } from './cookie.service';
import { CurrentUser, Public } from './decorators';
import { CredentialsDto } from './dto/credentials.dto';
import {
  CurrentUserResponse,
  RefreshedResponse,
  UserResponse,
} from './dto/user.response';
import { TokenService } from './token.service';
import type { AccessTokenPayload } from './token.service';

/**
 * Routes d'authentification.
 *
 * Aucun jeton n'apparaît dans les corps de réponse : ils partent uniquement
 * dans des cookies `httpOnly`. Le front n'a donc rien à stocker ni à renvoyer,
 * et le JavaScript de la page ne peut pas lire la session.
 */
@ApiTags('Authentification')
@ApiResponse({
  status: 403,
  description:
    'En-tête `X-Requested-With` absent sur une requête modifiant l\'état (protection CSRF).',
  type: ApiErrorResponse,
})
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly cookies: CookieService,
  ) {}

  /** Crée un compte. Ne connecte pas : l'utilisateur enchaîne sur `/login`. */
  @Public()
  // Large : c'est l'usage normal d'une personne qui se trompe, pas une
  // tentative d'attaque. La limite vise la création de comptes en masse.
  @RateLimit({ limit: 10, windowSeconds: 3600 })
  @ApiOperation({ summary: 'Créer un compte' })
  @ApiResponse({ status: 201, description: 'Compte créé.', type: UserResponse })
  @ApiResponse({
    status: 400,
    description:
      '`VALIDATION_ERROR` — email invalide, mot de passe de moins de 12 caractères, ou champ non prévu.',
    type: ApiErrorResponse,
  })
  @ApiResponse({
    status: 409,
    description: '`EMAIL_ALREADY_USED` — un compte existe déjà avec cet email.',
    type: ApiErrorResponse,
  })
  @Post('register')
  async register(@Body() credentials: CredentialsDto): Promise<UserResponse> {
    return this.auth.register(credentials.email, credentials.password);
  }

  /**
   * Vérifie les identifiants et ouvre une session.
   *
   * Le message d'erreur est **identique** pour un email inconnu et pour un mot
   * de passe faux : distinguer les deux permettrait de savoir quels comptes
   * existent.
   */
  @Public()
  // Le mot de passe d'un compte est choisi par un humain, donc devinable.
  // argon2id rend chaque essai coûteux ; cette limite rend leur répétition
  // inutile.
  @RateLimit({ limit: 10, windowSeconds: 300 })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Se connecter',
    description:
      'Pose deux cookies `httpOnly` : `access_token` (15 min) et `refresh_token` (7 jours, limité au chemin `/api/auth`). Aucun jeton n\'est renvoyé dans le corps.',
  })
  @ApiOkResponse({ description: 'Session ouverte.', type: UserResponse })
  @ApiResponse({
    status: 401,
    description:
      '`INVALID_CREDENTIALS` — réponse identique pour un email inconnu et pour un mot de passe faux, afin qu\'on ne puisse pas énumérer les comptes.',
    type: ApiErrorResponse,
  })
  @Post('login')
  async login(
    @Body() credentials: CredentialsDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponse> {
    const result = await this.auth.login(
      credentials.email,
      credentials.password,
    );

    if (!result) {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Email ou mot de passe incorrect.',
      });
    }

    this.cookies.setSessionCookies(response, result);

    return result.user;
  }

  /**
   * Échange le refresh token contre un couple neuf.
   *
   * Publique au sens du garde de session : l'access token est justement expiré
   * quand on appelle cette route. C'est le refresh token, lu dans son cookie,
   * qui fait autorité.
   */
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Renouveler la session',
    description:
      'Consomme le refresh token et en émet un neuf. Rejouer un jeton déjà consommé révoque **toute la lignée** de jetons : c\'est la détection de vol de session.',
  })
  @ApiOkResponse({ description: 'Session renouvelée.', type: RefreshedResponse })
  @ApiResponse({
    status: 401,
    description:
      '`NO_REFRESH_TOKEN` (aucun cookie) ou `REFRESH_REJECTED` (jeton inconnu, expiré, ou déjà consommé). Les cookies sont retirés.',
    type: ApiErrorResponse,
  })
  @Post('refresh')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ refreshed: true }> {
    const presented = request.cookies?.[REFRESH_COOKIE] as string | undefined;

    if (!presented) {
      throw new UnauthorizedException({
        error: 'NO_REFRESH_TOKEN',
        message: 'Aucune session à rafraîchir.',
      });
    }

    const rotated = await this.tokens.rotate(presented);

    if (!rotated) {
      // Le jeton est inconnu, expiré, ou déjà consommé — ce dernier cas ayant
      // déclenché la révocation de toute la famille. On retire les cookies
      // pour que le client reparte proprement d'une connexion.
      this.cookies.clearSessionCookies(response);

      throw new UnauthorizedException({
        error: 'REFRESH_REJECTED',
        message: 'Session invalide. Reconnectez-vous.',
      });
    }

    this.cookies.setSessionCookies(response, rotated);

    return { refreshed: true };
  }

  /**
   * Ferme la session.
   *
   * Répond 204 même sans session active : une déconnexion doit toujours
   * aboutir du point de vue de l'utilisateur.
   */
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Se déconnecter',
    description:
      'Révoque le refresh token et sa lignée, et inscrit l\'access token sur liste de refus — il devient inutilisable immédiatement, et non à son expiration.',
  })
  @ApiNoContentResponse({
    description: 'Session fermée. Répond aussi 204 sans session active.',
  })
  @Post('logout')
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.tokens.closeSession({
      refreshToken: request.cookies?.[REFRESH_COOKIE] as string | undefined,
      accessPayload: await this.readAccessPayload(request),
    });

    this.cookies.clearSessionCookies(response);
  }

  /** Renvoie le compte associé à la session en cours. */
  @ApiCookieAuth('access_token')
  @ApiOperation({ summary: 'Compte courant' })
  @ApiOkResponse({ type: CurrentUserResponse })
  @ApiResponse({
    status: 401,
    description:
      '`NOT_AUTHENTICATED` (aucun cookie) ou `SESSION_INVALID` (jeton expiré, altéré, ou révoqué par une déconnexion).',
    type: ApiErrorResponse,
  })
  @Get('me')
  async me(@CurrentUser() user: AccessTokenPayload): Promise<CurrentUserResponse> {
    const account = await this.auth.findById(user.sub);

    if (!account) {
      // Le jeton est valide mais le compte a disparu entre-temps (suppression,
      // par exemple) : la session n'a plus de sens.
      throw new UnauthorizedException({
        error: 'SESSION_INVALID',
        message: 'Ce compte n\'existe plus.',
      });
    }

    return account;
  }

  /**
   * Relit l'access token du cookie pour la déconnexion.
   *
   * La route est publique, donc le garde n'a pas rempli `request.user`. On lit
   * le jeton nous-mêmes : sans son `jti`, il resterait valable jusqu'à 15
   * minutes après la déconnexion.
   */
  private async readAccessPayload(
    request: Request,
  ): Promise<(AccessTokenPayload & { exp: number }) | undefined> {
    const token = request.cookies?.access_token as string | undefined;

    if (!token) {
      return undefined;
    }

    return (await this.tokens.verifyAccessToken(token)) ?? undefined;
  }
}
