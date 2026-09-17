import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
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
import { AuthService, estUnDefi } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { MfaService } from './mfa.service';
import { CookieService, REFRESH_COOKIE } from './cookie.service';
import { CurrentUser, Public } from './decorators';
import { CredentialsDto } from './dto/credentials.dto';
import {
  MfaChallengeResponse,
  MfaSettingResponse,
  SetMfaDto,
  VerifyMfaDto,
  type LoginResponse,
} from './dto/mfa.dto';
import {
  ResendVerificationDto,
  VerifyEmailDto,
} from './dto/verify-email.dto';
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
    private readonly verification: EmailVerificationService,
    private readonly mfa: MfaService,
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
   * Confirme une adresse à partir du jeton reçu par courriel.
   *
   * Publique, et c'est nécessaire : on ne peut pas être connecté puisque la
   * connexion est justement refusée tant que l'adresse n'est pas confirmée.
   */
  @Public()
  @ApiOperation({ summary: 'Confirmer son adresse' })
  @ApiResponse({ status: 204, description: 'Adresse confirmée.' })
  @ApiResponse({
    status: 400,
    description:
      '`VERIFICATION_TOKEN_INVALID` — lien inconnu, expiré ou déjà utilisé. Les trois cas donnent la même réponse.',
    type: ApiErrorResponse,
  })
  // Le jeton fait 32 octets aléatoires : il n'est pas devinable. La limite vise
  // l'acharnement automatisé, pas la découverte d'un jeton.
  @RateLimit({ limit: 20, windowSeconds: 300 })
  @HttpCode(204)
  @Post('verify-email')
  async verifyEmail(@Body() body: VerifyEmailDto): Promise<void> {
    await this.verification.confirmer(body.token);
  }

  /**
   * Renvoie un lien de confirmation.
   *
   * Répond toujours `204`, même pour une adresse inconnue ou déjà confirmée :
   * une réponse différenciée dirait qui est inscrit.
   */
  @Public()
  @ApiOperation({ summary: 'Renvoyer le lien de confirmation' })
  @ApiResponse({
    status: 204,
    description:
      'Demande enregistrée. La réponse est identique que le compte existe ou non.',
  })
  @RateLimit({ limit: 5, windowSeconds: 3600 })
  @HttpCode(204)
  @Post('resend-verification')
  async resendVerification(@Body() body: ResendVerificationDto): Promise<void> {
    await this.verification.renvoyer(body.email);
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
      'Deux issues selon le compte. **Sans second facteur**, les cookies de session sont posés et la réponse porte `mfaRequired: false`. **Avec second facteur**, un code à six chiffres part par courriel, aucun cookie n\'est posé, et il faut enchaîner sur `/api/auth/mfa/verify`.',
  })
  @ApiOkResponse({
    description:
      'Identifiants acceptés. Le champ `mfaRequired` dit laquelle des deux issues s\'applique.',
    type: MfaChallengeResponse,
  })
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
  ): Promise<LoginResponse> {
    const resultat = await this.auth.login(
      credentials.email,
      credentials.password,
    );

    if (!resultat) {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Email ou mot de passe incorrect.',
      });
    }

    // Deux issues selon le compte. Avec le second facteur, aucun cookie n'est
    // posé ici : la session naît sur `/mfa/verify`.
    if (estUnDefi(resultat)) {
      return { mfaRequired: true, challengeId: resultat.challengeId };
    }

    this.cookies.setSessionCookies(response, resultat);

    return { mfaRequired: false, user: resultat.user };
  }

  /**
   * Active ou coupe la double authentification sur son propre compte.
   *
   * Le mot de passe est redemandé : couper un facteur d'authentification ne
   * doit pas être possible avec une simple session, qui peut avoir été volée.
   */
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Activer ou couper la double authentification' })
  @ApiOkResponse({ description: 'Réglage enregistré.', type: MfaSettingResponse })
  @ApiResponse({
    status: 401,
    description:
      '`INVALID_CREDENTIALS` — mot de passe incorrect, ou `NOT_AUTHENTICATED`.',
    type: ApiErrorResponse,
  })
  @RateLimit({ limit: 10, windowSeconds: 300 })
  @HttpCode(HttpStatus.OK)
  @Patch('mfa')
  async setMfa(
    @CurrentUser() user: AccessTokenPayload,
    @Body() body: SetMfaDto,
  ): Promise<MfaSettingResponse> {
    const ok = await this.auth.changerMfa(user.sub, body.enabled, body.password);

    if (!ok) {
      throw new UnauthorizedException({
        error: 'INVALID_CREDENTIALS',
        message: 'Mot de passe incorrect.',
      });
    }

    return { mfaEnabled: body.enabled };
  }

  /**
   * Échange le code reçu par courriel contre une session.
   *
   * C'est ici, et seulement ici, que les cookies sont posés.
   */
  @Public()
  // Six chiffres font un million de combinaisons. Ce qui rend l'énumération
  // vaine, c'est la limite d'essais par défi — celle-ci ferme en plus la porte
  // à qui ouvrirait des défis en série.
  @RateLimit({ limit: 15, windowSeconds: 300 })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Valider le second facteur',
    description:
      'Vérifie le code à six chiffres reçu par courriel et ouvre la session. Cinq essais par défi, dix minutes de validité.',
  })
  @ApiOkResponse({ description: 'Session ouverte.', type: UserResponse })
  @ApiResponse({
    status: 401,
    description:
      '`MFA_CODE_INVALID` — code faux, défi expiré, déjà utilisé ou épuisé. Les quatre cas donnent la même réponse.',
    type: ApiErrorResponse,
  })
  @Post('mfa/verify')
  async verifyMfa(
    @Body() body: VerifyMfaDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<UserResponse> {
    const result = await this.auth.ouvrirSessionApresMfa(
      body.challengeId,
      body.code,
    );

    if (!result) {
      this.mfa.refuser();
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
