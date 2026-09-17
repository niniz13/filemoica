import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EmailVerificationService } from './email-verification.service';
import { MfaService, type DefiEmis } from './mfa.service';
import { PasswordService } from './password.service';
import { IssuedTokens, TokenService } from './token.service';

/** Représentation publique d'un compte — jamais l'empreinte du mot de passe. */
export interface PublicUser {
  id: string;
  email: string;
  role: string;
}

/**
 * Inscription, connexion et fermeture de session.
 *
 * Orchestre les trois services spécialisés : `PasswordService` pour les
 * empreintes, `TokenService` pour les jetons, `PrismaService` pour la base.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly verification: EmailVerificationService,
    private readonly mfa: MfaService,
  ) {}

  /**
   * Crée un compte.
   *
   * @throws {ConflictException} Si l'email est déjà utilisé.
   */
  async register(email: string, password: string): Promise<PublicUser> {
    const normalizedEmail = this.normalizeEmail(email);

    const existing = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existing) {
      // Compromis assumé : révéler qu'un email est déjà pris permet de
      // dresser la liste des comptes du service. L'inverse — accepter
      // silencieusement — rendrait l'inscription incompréhensible pour un
      // utilisateur légitime qui a simplement oublié qu'il avait un compte.
      throw new ConflictException({
        error: 'EMAIL_ALREADY_USED',
        message: 'Un compte existe déjà avec cet email.',
      });
    }

    const user = await this.prisma.user.create({
      data: {
        email: normalizedEmail,
        passwordHash: await this.passwords.hash(password),
      },
      select: { id: true, email: true, role: true },
    });

    // Le compte existe, mais il reste inutilisable tant que l'adresse n'est pas
    // confirmée : la connexion est refusée. Un échec d'envoi ne doit pas pour
    // autant annuler l'inscription — le compte est créé, et un nouveau lien
    // peut être redemandé.
    try {
      await this.verification.envoyerLien(user.id, user.email);
    } catch (error) {
      this.logger.error(
        `Inscription ${user.id} : le courriel de confirmation n'est pas parti`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    this.logger.log(`Compte créé : ${user.id}`);

    return user;
  }

  /**
   * Vérifie des identifiants et ouvre une session.
   *
   * @returns Les jetons et le compte, ou `null` si les identifiants sont
   * invalides — sans distinguer « email inconnu » de « mot de passe faux ».
   */
  async login(
    email: string,
    password: string,
  ): Promise<DefiEmis | null> {
    const user = await this.prisma.user.findUnique({
      where: { email: this.normalizeEmail(email) },
      select: {
        id: true,
        email: true,
        role: true,
        passwordHash: true,
        emailVerifiedAt: true,
      },
    });

    if (!user) {
      // Vérification factice : sans elle, la réponse serait immédiate pour un
      // email inconnu et plus lente pour un email existant. Ce simple écart de
      // temps suffirait à énumérer les comptes du service.
      await this.passwords.verifyDummy();
      return null;
    }

    const valid = await this.passwords.verify(user.passwordHash, password);

    if (!valid) {
      this.logger.warn(`Échec de connexion pour le compte ${user.id}`);
      return null;
    }

    // Contrôlé **après** le mot de passe, et jamais avant : répondre « adresse
    // non confirmée » à qui n'a pas les identifiants transformerait la
    // connexion en oracle révélant quels comptes existent.
    // `!` et non `=== null` : une valeur absente doit refuser la connexion, pas
    // la laisser passer. Un contrôle de sécurité qui s'ouvre quand la donnée
    // manque est un contrôle qui finira par s'ouvrir.
    if (!user.emailVerifiedAt) {
      this.logger.warn(`Connexion refusée : adresse non confirmée (${user.id})`);

      throw new ForbiddenException({
        error: 'EMAIL_NOT_VERIFIED',
        message:
          'Confirmez votre adresse avant de vous connecter. Vérifiez votre boîte de réception.',
      });
    }

    // Les identifiants sont bons, mais ils ne suffisent plus : la session
    // n'est ouverte qu'après le second facteur. C'est tout l'intérêt — un mot
    // de passe volé ne donne plus accès au compte à lui seul.
    return this.mfa.emettre(user.id, user.email);
  }

  /**
   * Ouvre la session une fois le second facteur validé.
   *
   * Séparé de {@link login} : les identifiants ont déjà été vérifiés à l'étape
   * précédente, c'est le défi qui fait autorité ici.
   */
  async ouvrirSessionApresMfa(
    challengeId: string,
    code: string,
  ): Promise<(IssuedTokens & { user: PublicUser }) | null> {
    const userId = await this.mfa.verifier(challengeId, code);

    if (!userId) {
      return null;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true },
    });

    if (!user) {
      return null;
    }

    const tokens = await this.tokens.openSession(user);

    return { ...tokens, user };
  }

  /**
   * Relit un compte par son identifiant.
   *
   * Le rôle n'est jamais porté par le jeton de session : il est relu en base à
   * chaque fois qu'il compte, ici comme dans l'administration, pour qu'un
   * changement de rôle prenne effet immédiatement plutôt qu'à la prochaine
   * connexion.
   */
  async findById(id: string): Promise<PublicUser | null> {
    return this.prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, role: true },
    });
  }

  /**
   * Normalise un email avant toute comparaison.
   *
   * Sans cela, `Alice@Example.fr` et `alice@example.fr` créeraient deux comptes
   * distincts, et l'utilisateur ne retrouverait pas le sien selon la façon dont
   * il l'a saisi.
   */
  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }
}
