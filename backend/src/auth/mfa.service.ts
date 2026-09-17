import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { PasswordService } from './password.service';

/** Longueur du code envoyé par courriel. */
const LONGUEUR_CODE = 6;

/**
 * Durée de vie d'un défi.
 *
 * Assez pour aller chercher le courriel, assez peu pour qu'un code intercepté
 * ne serve plus quand on s'en aperçoit.
 */
const VALIDITE_MINUTES = 10;

/**
 * Essais autorisés avant abandon du défi.
 *
 * Six chiffres font un million de combinaisons : c'est peu. Ce qui rend
 * l'énumération vaine, ce n'est pas la longueur du code, c'est cette limite.
 */
const ESSAIS_MAX = 5;

/** Ce qu'une connexion renvoie tant que le second facteur n'est pas donné. */
export interface DefiEmis {
  challengeId: string;
}

/**
 * Double authentification par courriel.
 *
 * ## Le déroulé
 *
 * La connexion ne rend plus de session : elle vérifie les identifiants, émet un
 * code à six chiffres, l'envoie par courriel et renvoie un identifiant de défi.
 * La session n'est ouverte qu'au second appel, avec le code.
 *
 * ## Ce qui rend six chiffres suffisants
 *
 * Un million de combinaisons se parcourt vite. Trois choses ferment cette porte,
 * et elles comptent plus que la longueur du code :
 *
 * - **cinq essais**, après quoi le défi est clos et il faut recommencer ;
 * - **dix minutes** de validité ;
 * - une empreinte **argon2id**, et non SHA-256 : même si la base fuit pendant
 *   la fenêtre, retrouver le code coûte cher.
 */
@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly mail: MailService,
  ) {}

  /**
   * Émet un défi et envoie le code.
   *
   * @throws Si le courriel ne part pas. La connexion doit alors échouer : dire
   * « code envoyé » quand rien n'est parti laisserait l'utilisateur attendre un
   * message qui n'arrivera jamais.
   */
  async emettre(userId: string, email: string): Promise<DefiEmis> {
    // Les défis encore ouverts du compte sont clos : une nouvelle tentative de
    // connexion doit invalider le code précédent, sinon deux codes coexistent.
    await this.prisma.mfaChallenge.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() },
    });

    // `randomInt` et non `Math.random` : le générateur doit être
    // cryptographique, sans quoi les codes deviennent prédictibles.
    const code = String(randomInt(0, 10 ** LONGUEUR_CODE)).padStart(
      LONGUEUR_CODE,
      '0',
    );

    const defi = await this.prisma.mfaChallenge.create({
      data: {
        userId,
        codeHash: await this.passwords.hash(code),
        expiresAt: new Date(Date.now() + VALIDITE_MINUTES * 60 * 1000),
      },
      select: { id: true },
    });

    await this.mail.envoyer({
      to: email,
      subject: `${code} — votre code de connexion filemoica`,
      text: [
        `Votre code de connexion : ${code}`,
        '',
        `Il expire dans ${VALIDITE_MINUTES} minutes et ne sert qu'une fois.`,
        "Si vous n'essayez pas de vous connecter, changez votre mot de passe :",
        "quelqu'un le connaît.",
      ].join('\n'),
      html: [
        '<p>Votre code de connexion :</p>',
        `<p style="font-size:28px;letter-spacing:6px;font-weight:600">${code}</p>`,
        `<p style="color:#6b7178;font-size:13px">Il expire dans ${VALIDITE_MINUTES} minutes et ne sert qu'une fois.</p>`,
        "<p style=\"color:#6b7178;font-size:13px\">Si vous n'essayez pas de vous connecter, changez votre mot de passe : quelqu'un le connaît.</p>",
      ].join(''),
    });

    this.logger.log(`Défi de connexion émis pour le compte ${userId}`);

    return { challengeId: defi.id };
  }

  /**
   * Vérifie un code et rend le compte associé.
   *
   * @returns L'identifiant du compte, ou `null` si le défi est inconnu, expiré,
   * déjà utilisé, épuisé, ou le code faux. Un seul retour pour tous ces cas :
   * les distinguer renseignerait sur l'état des défis en cours.
   */
  async verifier(challengeId: string, code: string): Promise<string | null> {
    const defi = await this.prisma.mfaChallenge.findUnique({
      where: { id: challengeId },
      select: {
        id: true,
        userId: true,
        codeHash: true,
        attempts: true,
        expiresAt: true,
        consumedAt: true,
      },
    });

    const ouvert =
      defi &&
      defi.consumedAt === null &&
      defi.attempts < ESSAIS_MAX &&
      defi.expiresAt.getTime() > Date.now();

    if (!ouvert) {
      return null;
    }

    const valide = await this.passwords.verify(defi.codeHash, code);

    if (!valide) {
      const { attempts } = await this.prisma.mfaChallenge.update({
        where: { id: defi.id },
        data: { attempts: { increment: 1 } },
        select: { attempts: true },
      });

      // Au dernier essai, le défi est clos : inutile de laisser une coquille
      // vide que l'on pourrait continuer d'interroger.
      if (attempts >= ESSAIS_MAX) {
        await this.prisma.mfaChallenge.update({
          where: { id: defi.id },
          data: { consumedAt: new Date() },
        });
        this.logger.warn(
          `Défi abandonné après ${ESSAIS_MAX} essais — compte ${defi.userId}`,
        );
      }

      return null;
    }

    await this.prisma.mfaChallenge.update({
      where: { id: defi.id },
      data: { consumedAt: new Date() },
    });

    return defi.userId;
  }

  /** Refus commun à tous les échecs du second facteur. */
  refuser(): never {
    throw new UnauthorizedException({
      error: 'MFA_CODE_INVALID',
      message: 'Code incorrect ou expiré. Reprenez la connexion.',
    });
  }
}
