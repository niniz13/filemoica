import { ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

describe('AuthService', () => {
  let auth: AuthService;
  let findUnique: jest.Mock;
  let create: jest.Mock;
  let verify: jest.Mock;
  let verifyDummy: jest.Mock;
  let openSession: jest.Mock;

  beforeEach(async () => {
    findUnique = jest.fn();
    create = jest.fn();
    verify = jest.fn();
    verifyDummy = jest.fn().mockResolvedValue(false);
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
          useValue: { user: { findUnique, create } },
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
    it('ouvre une session quand les identifiants sont bons', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
      });
      verify.mockResolvedValue(true);

      const result = await auth.login('alice@example.fr', 'phrase-longue-ok');

      expect(result?.user.id).toBe('user-1');
      expect(result?.accessToken).toBe('access');
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

    it('ne renvoie jamais l\'empreinte du mot de passe', async () => {
      findUnique.mockResolvedValue({
        id: 'user-1',
        email: 'alice@example.fr',
        role: 'USER',
        passwordHash: '$argon2id$empreinte',
      });
      verify.mockResolvedValue(true);

      const result = await auth.login('alice@example.fr', 'phrase-longue-ok');

      expect(JSON.stringify(result?.user)).not.toContain('argon2');
    });
  });
});
