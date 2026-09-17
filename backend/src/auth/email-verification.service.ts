import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation';
import { CryptoService } from '../crypto/crypto.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Durée de validité d'un lien de confirmation.
 *
 * Assez long pour survivre à une nuit et à un filtre anti-spam, assez court
 * pour qu'un lien oublié dans une boîte finisse par ne plus rien ouvrir.
 */
const VALIDITE_HEURES = 24;

/**
 * Confirmation de l'adresse renseignée à l'inscription.
 *
 * ## Ce que ça protège
 *
 * Sans confirmation, n'importe qui peut créer un compte avec l'adresse d'un
 * tiers. Les liens de partage étant envoyés par le déposant lui-même, le risque
 * n'est pas l'usurpation d'envoi — c'est l'encombrement : des comptes qui ne
 * correspondent à personne, et un quota consommé par des inscriptions
 * automatisées.
 *
 * ## Le jeton
 *
 * Même principe que les liens de partage : 32 octets aléatoires, dont seule
 * l'empreinte SHA-256 est conservée. La base volée ne permet donc pas de
 * confirmer une adresse à la place de son propriétaire.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  /**
   * Émet un jeton et envoie le courriel de confirmation.
   *
   * Les jetons encore valides du compte sont invalidés au passage : un seul
   * lien doit fonctionner à la fois, sinon un lien transmis par erreur reste
   * exploitable après qu'on en a demandé un nouveau.
   */
  async envoyerLien(userId: string, email: string): Promise<void> {
    await this.prisma.emailVerification.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    const jeton = this.crypto.generateToken();

    await this.prisma.emailVerification.create({
      data: {
        userId,
        tokenHash: this.crypto.hashToken(jeton),
        expiresAt: new Date(Date.now() + VALIDITE_HEURES * 3600 * 1000),
      },
    });

    const base = this.config.get('APP_PUBLIC_URL', { infer: true });
    const lien = `${base}/verification?token=${jeton}`;

    await this.mail.envoyer({
      to: email,
      subject: 'Confirmez votre adresse — filemoica',
      text: [
        'Bienvenue sur filemoica.',
        '',
        'Confirmez votre adresse en ouvrant ce lien :',
        lien,
        '',
        `Ce lien expire dans ${VALIDITE_HEURES} heures.`,
        "Si vous n'êtes pas à l'origine de cette inscription, ignorez ce message.",
      ].join('\n'),
      html: [
        '<p>Bienvenue sur <strong>filemoica</strong>.</p>',
        `<p><a href="${lien}">Confirmer mon adresse</a></p>`,
        `<p style="color:#6b7178;font-size:13px">Ce lien expire dans ${VALIDITE_HEURES} heures. Si vous n'êtes pas à l'origine de cette inscription, ignorez ce message.</p>`,
      ].join(''),
    });
  }

  /**
   * Consomme un jeton et marque l'adresse comme confirmée.
   *
   * @throws {BadRequestException} Jeton inconnu, expiré ou déjà utilisé — les
   * trois cas donnent la **même** réponse : distinguer « ce jeton n'existe
   * pas » de « ce jeton a expiré » renseignerait sur les jetons émis.
   */
  async confirmer(jeton: string): Promise<void> {
    const enregistrement = await this.prisma.emailVerification.findUnique({
      where: { tokenHash: this.crypto.hashToken(jeton) },
      select: { id: true, userId: true, expiresAt: true, consumedAt: true },
    });

    const utilisable =
      enregistrement &&
      enregistrement.consumedAt === null &&
      enregistrement.expiresAt.getTime() > Date.now();

    if (!utilisable) {
      throw new BadRequestException({
        error: 'VERIFICATION_TOKEN_INVALID',
        message: 'Ce lien de confirmation est invalide ou a expiré.',
      });
    }

    await this.prisma.$transaction([
      this.prisma.emailVerification.update({
        where: { id: enregistrement.id },
        data: { consumedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: enregistrement.userId },
        data: { emailVerifiedAt: new Date() },
      }),
    ]);

    this.logger.log(`Adresse confirmée pour le compte ${enregistrement.userId}`);
  }

  /**
   * Renvoie un lien, sans jamais dire si le compte existe.
   *
   * La réponse est identique dans tous les cas — adresse inconnue, déjà
   * confirmée, ou en attente. Répondre différemment transformerait cette route
   * en oracle permettant de savoir qui est inscrit.
   */
  async renvoyer(email: string): Promise<void> {
    const compte = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
      select: { id: true, email: true, emailVerifiedAt: true },
    });

    if (!compte || compte.emailVerifiedAt !== null) {
      return;
    }

    await this.envoyerLien(compte.id, compte.email);
  }
}
