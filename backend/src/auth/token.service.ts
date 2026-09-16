import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../config/env.validation';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

/** Contenu d'un access token. */
export interface AccessTokenPayload {
  /** Identifiant de l'utilisateur. */
  sub: string;
  /** Email, pour éviter une requête en base à chaque requête authentifiée. */
  email: string;
  /** Identifiant unique de ce jeton, ce qui permet de le révoquer. */
  jti: string;
}

/** Un couple de jetons fraîchement émis. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
}

/**
 * Émission, vérification et révocation des jetons de session.
 *
 * ## Deux jetons, deux rôles
 *
 * - **Access token** : un JWT de 15 minutes, présenté à chaque requête. Il est
 *   autoportant — le serveur n'a pas besoin de consulter la base pour le
 *   valider, ce qui le rend rapide.
 * - **Refresh token** : une valeur **opaque** de 32 octets aléatoires, valable
 *   plusieurs jours, dont le seul rôle est d'obtenir un nouvel access token.
 *
 * Pourquoi un jeton opaque et non un second JWT ? Parce qu'un JWT ne peut pas
 * être révoqué : il est valide tant qu'il n'a pas expiré. Le refresh token, lui,
 * est une ligne en base — le révoquer est immédiat. La durée de vie courte de
 * l'access token borne la fenêtre pendant laquelle un vol reste exploitable.
 *
 * ## Rotation et détection de vol
 *
 * Chaque utilisation d'un refresh token le consomme et en émet un nouveau. Les
 * jetons issus d'une même connexion partagent une `familyId`.
 *
 * Si un jeton **déjà utilisé** est présenté, il n'y a que deux explications :
 * soit il a été volé et l'attaquant le rejoue, soit il a été volé et c'est la
 * victime qui le rejoue. Dans les deux cas quelqu'un d'autre détient une copie,
 * donc on révoque **toute la famille** — l'attaquant comme la victime sont
 * déconnectés, et la victime doit se reconnecter avec son mot de passe.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /** Durée de vie du refresh token, en millisecondes. */
  get refreshTtlMs(): number {
    return (
      this.config.get('REFRESH_TOKEN_TTL_DAYS', { infer: true }) *
      24 *
      60 *
      60 *
      1000
    );
  }

  /**
   * Ouvre une session : émet un access token et un refresh token inaugurant
   * une nouvelle famille.
   */
  async openSession(user: { id: string; email: string }): Promise<IssuedTokens> {
    const accessToken = await this.issueAccessToken(user);
    const refresh = await this.issueRefreshToken(user.id, randomUUID());

    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
    };
  }

  /**
   * Échange un refresh token contre un couple neuf.
   *
   * @returns Les nouveaux jetons, ou `null` si le jeton présenté est inconnu,
   * expiré, ou déjà consommé — sans distinguer les cas, pour ne rien apprendre
   * à un attaquant.
   */
  async rotate(
    presentedToken: string,
  ): Promise<(IssuedTokens & { userId: string }) | null> {
    const tokenHash = this.crypto.hashToken(presentedToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { select: { id: true, email: true } } },
    });

    if (!stored) {
      return null;
    }

    // Jeton déjà consommé : quelqu'un détient une copie. On coupe toute la
    // lignée plutôt que de laisser cohabiter deux sessions.
    if (stored.revokedAt) {
      this.logger.warn(
        `Réutilisation d'un refresh token détectée (famille ${stored.familyId}) — révocation de la famille`,
      );
      await this.revokeFamily(stored.familyId);
      return null;
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      return null;
    }

    const accessToken = await this.issueAccessToken(stored.user);
    const refresh = await this.issueRefreshToken(
      stored.userId,
      stored.familyId,
    );

    // L'ancien jeton devient inutilisable et pointe vers son remplaçant : la
    // chaîne de rotation reste traçable pour comprendre un incident après coup.
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedById: refresh.id },
    });

    return {
      accessToken,
      refreshToken: refresh.token,
      refreshExpiresAt: refresh.expiresAt,
      userId: stored.userId,
    };
  }

  /**
   * Ferme une session.
   *
   * Deux actions complémentaires : le refresh token est révoqué en base (avec
   * toute sa famille), et l'access token encore en circulation est inscrit sur
   * liste de refus jusqu'à son expiration naturelle. Sans le second, un jeton
   * volé resterait valable jusqu'à 15 minutes après la déconnexion.
   */
  async closeSession(options: {
    refreshToken?: string;
    accessPayload?: AccessTokenPayload & { exp?: number };
  }): Promise<void> {
    if (options.refreshToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: this.crypto.hashToken(options.refreshToken) },
        select: { familyId: true },
      });

      if (stored) {
        await this.revokeFamily(stored.familyId);
      }
    }

    if (options.accessPayload?.jti) {
      await this.revokeAccessToken(
        options.accessPayload.jti,
        options.accessPayload.exp,
      );
    }
  }

  /**
   * Vérifie un access token : signature, expiration, puis liste de refus.
   *
   * @returns Le contenu du jeton, ou `null` s'il est invalide ou révoqué.
   */
  async verifyAccessToken(
    token: string,
  ): Promise<(AccessTokenPayload & { exp: number }) | null> {
    let payload: AccessTokenPayload & { exp: number };

    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      return null;
    }

    // La signature ne suffit pas : un jeton peut avoir été révoqué par une
    // déconnexion avant d'expirer.
    const revoked = await this.prisma.revokedAccessToken.findUnique({
      where: { jti: payload.jti },
      select: { jti: true },
    });

    return revoked ? null : payload;
  }

  /**
   * Supprime les jetons dont la date de validité est passée.
   *
   * Destiné à une tâche périodique côté infrastructure. Ces lignes ne servent
   * plus à rien : un access token expiré est de toute façon refusé par la
   * vérification de signature.
   */
  async purgeExpired(): Promise<{ accessTokens: number; refreshTokens: number }> {
    const now = new Date();

    const [accessTokens, refreshTokens] = await Promise.all([
      this.prisma.revokedAccessToken.deleteMany({
        where: { expiresAt: { lt: now } },
      }),
      this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } }),
    ]);

    return {
      accessTokens: accessTokens.count,
      refreshTokens: refreshTokens.count,
    };
  }

  /** Signe un nouvel access token, porteur d'un identifiant unique. */
  private async issueAccessToken(user: {
    id: string;
    email: string;
  }): Promise<string> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      jti: randomUUID(),
    };

    return this.jwt.signAsync(payload);
  }

  /**
   * Tire un refresh token et n'en garde que l'empreinte.
   *
   * La valeur en clair n'est renvoyée qu'ici, pour être posée dans le cookie :
   * elle n'existe nulle part ailleurs. Une fuite de la base ne permet donc pas
   * de rejouer une session.
   */
  private async issueRefreshToken(
    userId: string,
    familyId: string,
  ): Promise<{ id: string; token: string; expiresAt: Date }> {
    const token = this.crypto.generateToken();
    const expiresAt = new Date(Date.now() + this.refreshTtlMs);

    const stored = await this.prisma.refreshToken.create({
      data: {
        tokenHash: this.crypto.hashToken(token),
        familyId,
        userId,
        expiresAt,
      },
      select: { id: true },
    });

    return { id: stored.id, token, expiresAt };
  }

  /** Révoque tous les jetons encore actifs d'une même lignée. */
  private async revokeFamily(familyId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Inscrit un access token sur la liste de refus.
   *
   * On y stocke sa date d'expiration pour que la purge puisse nettoyer : la
   * table ne contient jamais que quelques minutes de déconnexions.
   */
  private async revokeAccessToken(
    jti: string,
    expiresAtSeconds?: number,
  ): Promise<void> {
    const expiresAt = expiresAtSeconds
      ? new Date(expiresAtSeconds * 1000)
      : new Date(Date.now() + 15 * 60 * 1000);

    await this.prisma.revokedAccessToken.upsert({
      where: { jti },
      create: { jti, expiresAt },
      update: {},
    });
  }
}
