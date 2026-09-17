import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { EmailVerificationService } from './email-verification.service';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

describe('AuthService', () => {
  let auth: AuthService;
  let findUnique: jest.Mock;
  let create: jest.Mock;
  let update: jest.Mock;
  let verify: jest.Mock;
  let verifyDummy: jest.Mock;
  let openSession: jest.Mock;
  let emettre: jest.Mock;
  let verifier: jest.Mock;

  beforeEach(async () => {
    findUnique = jest.fn();
    create = jest.fn();
    update = jest.fn();
    verify = jest.fn();
    verifyDummy = jest.fn().mockResolvedValue(false);
    emettre = jest.fn().mockResolvedValue({ challengeId: 'defi-1' });
    verifier = jest.fn();
    openSession = jest.fn().mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      refreshExpiresAt: new Date(),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: PrismaService,
          useValue: { user: { findUnique, create, update } },
        },
        {
          provide: PasswordService,
          useValue: {
            hash: jest.fn().mockResolvedValue('$argon2id$empreinte'),
            verify,
            verifyDummy,
          },
        },
        { provide: TokenService, useValue: { openSession } },
      {
        // L'envoi du lien de confirmation est hors sujet ici : ces tests
        // portent sur les identifiants, pas sur le courriel.
        provide: EmailVerificationService,
        useValue: { envoyerLien: jest.fn() },
      },
      { provide: MfaService, useValue: { emettre, verifier } },
      ],
    }).compile();

    auth = module.get(AuthService);
  });

  describe('Inscription', () => {
    it('crée un compte quand l\'email est libre', async () => {
      findUnique.mockResolvedValue(null);
      create.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
      });

      const user = await auth.register('alice@example.fr', 'phrase-longue-ok');

      expect(user.id).toBe('user-1');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ passwordHash: '$argon2id$empreinte' }),
        }),
      );
    });

    it('refuse un email déjà pris', async () => {
      findUnique.mockResolvedValue({ id: 'existant' });

      await expect(
        auth.register('alice@example.fr', 'phrase-longue-ok'),
      ).rejects.toThrow(ConflictException);
      expect(create).not.toHaveBeenCalled();
    });

    // Sans normalisation, deux comptes distincts naîtraient de la même adresse.
    it('normalise l\'email avant de chercher et d\'enregistrer', async () => {
      findUnique.mockResolvedValue(null);
      create.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
      });

      await auth.register('  ALICE@Example.FR  ', 'phrase-longue-ok');

      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'alice@example.fr' } }),
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ email: 'alice@example.fr' }),
        }),
      );
    });
  });

  describe('Connexion', () => {
    // Le cœur du second facteur, quand il est armé : de bons identifiants ne
    // suffisent plus.
    it('émet un défi au lieu d\'ouvrir une session quand le compte l\'exige', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
        emailVerifiedAt: new Date(),
        mfaEnabled: true,
      });
      verify.mockResolvedValue(true);

      const result = await auth.login('alice@example.fr', 'phrase-longue-ok');

      expect(result).toEqual({ challengeId: 'defi-1' });
      expect(emettre).toHaveBeenCalledWith('user-1', 'alice@example.fr');
      // Aucune session tant que le code n'est pas donné.
      expect(openSession).not.toHaveBeenCalled();
    });

    // Le réglage est par compte : sans second facteur, la connexion se termine
    // en une étape.
    it('ouvre directement la session quand le second facteur est coupé', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
        emailVerifiedAt: new Date(),
        mfaEnabled: false,
      });
      verify.mockResolvedValue(true);

      const result = await auth.login('alice@example.fr', 'phrase-longue-ok');

      expect(result).toMatchObject({
        accessToken: 'access',
        user: { id: 'user-1', email: 'alice@example.fr', role: 'USER' },
      });
      expect(emettre).not.toHaveBeenCalled();
    });

    it('refuse un mot de passe incorrect', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
      });
      verify.mockResolvedValue(false);

      expect(await auth.login('alice@example.fr', 'mauvais')).toBeNull();
      expect(openSession).not.toHaveBeenCalled();
    });

    it('refuse un email inconnu', async () => {
      findUnique.mockResolvedValue(null);

      expect(await auth.login('inconnu@example.fr', 'peu-importe')).toBeNull();
    });

    // La protection contre l'énumération de comptes : sans cet appel, la
    // réponse serait immédiate pour un email inconnu et bien plus lente pour
    // un email existant.
    it('consomme le même temps de calcul pour un email inconnu', async () => {
      findUnique.mockResolvedValue(null);

      await auth.login('inconnu@example.fr', 'peu-importe');

      expect(verifyDummy).toHaveBeenCalled();
    });

    // Le contrôle vient **après** la vérification du mot de passe : sinon, un
    // inconnu apprendrait quels comptes existent en lisant le code d'erreur.
    it('refuse une adresse non confirmée, malgré un mot de passe valide', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
        emailVerifiedAt: null,
      });
      verify.mockResolvedValue(true);

      await expect(
        auth.login('alice@example.fr', 'phrase-longue-ok'),
      ).rejects.toThrow(ForbiddenException);
      expect(openSession).not.toHaveBeenCalled();
    });

    // Une valeur absente ne doit pas ouvrir la porte : un contrôle de sécurité
    // qui laisse passer quand la donnée manque finira par laisser passer.
    it('refuse aussi quand la date de confirmation est absente', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
      });
      verify.mockResolvedValue(true);

      await expect(
        auth.login('alice@example.fr', 'phrase-longue-ok'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('n\'émet aucun défi quand le mot de passe est faux', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
        emailVerifiedAt: new Date(),
      });
      verify.mockResolvedValue(false);

      await auth.login('alice@example.fr', 'mauvais');

      expect(emettre).not.toHaveBeenCalled();
    });
  });

  describe('Second facteur', () => {
    it('ouvre la session quand le code est bon', async () => {
      verifier.mockResolvedValue('user-1');
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
      });

      const result = await auth.ouvrirSessionApresMfa('defi-1', '123456');

      expect(result?.user.id).toBe('user-1');
      expect(result?.accessToken).toBe('access');
    });

    it('refuse un code invalide', async () => {
      verifier.mockResolvedValue(null);

      expect(await auth.ouvrirSessionApresMfa('defi-1', '000000')).toBeNull();
      expect(openSession).not.toHaveBeenCalled();
    });

    it('ne renvoie jamais l\'empreinte du mot de passe', async () => {
      verifier.mockResolvedValue('user-1');
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
      });

      const result = await auth.ouvrirSessionApresMfa('defi-1', '123456');

      expect(JSON.stringify(result?.user)).not.toContain('argon2');
    });
  });

  describe('Réglage du second facteur', () => {
    it('enregistre l\'activation quand le mot de passe est bon', async () => {
      findUnique.mockResolvedValue({ passwordHash: '$argon2id$empreinte' });
      verify.mockResolvedValue(true);

      expect(await auth.changerMfa('user-1', true, 'phrase-longue-ok')).toBe(
        true,
      );
      expect(update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { mfaEnabled: true },
      });
    });

    // Sans cette confirmation, une session volée suffirait à désarmer la
    // protection qui rendait justement le vol difficile.
    it('ne touche à rien quand le mot de passe est faux', async () => {
      findUnique.mockResolvedValue({ passwordHash: '$argon2id$empreinte' });
      verify.mockResolvedValue(false);

      expect(await auth.changerMfa('user-1', false, 'mauvais')).toBe(false);
      expect(update).not.toHaveBeenCalled();
    });
  });
});
