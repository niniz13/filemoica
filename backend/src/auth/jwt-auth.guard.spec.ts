import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AccessTokenPayload } from './token.service';
import { TokenService } from './token.service';

describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let verifyAccessToken: jest.Mock;
  let getAllAndOverride: jest.Mock;

  const PAYLOAD: AccessTokenPayload = {
    sub: 'user-1',
    email: 'alice@example.fr',
    jti: 'jeton-1',
  };

  /** Construit un contexte portant les cookies donnés. */
  function createContext(cookies: Record<string, string> = {}): {
    context: ExecutionContext;
    request: Request;
  } {
    const request = { cookies } as unknown as Request;

    return {
      request,
      context: {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as unknown as ExecutionContext,
    };
  }

  beforeEach(() => {
    verifyAccessToken = jest.fn();
    getAllAndOverride = jest.fn().mockReturnValue(false);

    guard = new JwtAuthGuard(
      { verifyAccessToken } as unknown as TokenService,
      { getAllAndOverride } as unknown as Reflector,
    );
  });

  it('laisse passer une route marquée publique', async () => {
    getAllAndOverride.mockReturnValue(true);
    const { context } = createContext();

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  it('accepte une session valide et expose l\'utilisateur', async () => {
    verifyAccessToken.mockResolvedValue(PAYLOAD);
    const { context, request } = createContext({ access_token: 'jeton' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(PAYLOAD);
  });

  it('refuse une requête sans cookie de session', async () => {
    const { context } = createContext();

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(verifyAccessToken).not.toHaveBeenCalled();
  });

  // Distinguer les deux cas aide le front : « pas connecté » mène à la page de
  // connexion, « session invalide » à une tentative de rafraîchissement.
  it('distingue l\'absence de session d\'une session invalide', async () => {
    const sansCookie = createContext();
    const avecCookieInvalide = createContext({ access_token: 'périmé' });
    verifyAccessToken.mockResolvedValue(null);

    await expect(
      guard.canActivate(sansCookie.context).catch((e: UnauthorizedException) =>
        e.getResponse(),
      ),
    ).resolves.toMatchObject({ error: 'NOT_AUTHENTICATED' });

    await expect(
      guard
        .canActivate(avecCookieInvalide.context)
        .catch((e: UnauthorizedException) => e.getResponse()),
    ).resolves.toMatchObject({ error: 'SESSION_INVALID' });
  });

  // Le jeton peut être révoqué sans être expiré : c'est `verifyAccessToken`
  // qui consulte la liste de refus, et le garde doit respecter son verdict.
  it('refuse un jeton révoqué même si sa signature est valide', async () => {
    verifyAccessToken.mockResolvedValue(null);
    const { context, request } = createContext({ access_token: 'révoqué' });

    await expect(guard.canActivate(context)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(request.user).toBeUndefined();
  });
});
