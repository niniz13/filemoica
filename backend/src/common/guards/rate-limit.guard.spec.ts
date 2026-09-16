import { ExecutionContext, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimitGuard, type RateLimitRule } from './rate-limit.guard';

describe('RateLimitGuard', () => {
  let guard: RateLimitGuard;
  let regle: RateLimitRule | undefined;
  let headers: Record<string, unknown>;

  /** Construit un contexte pour une adresse donnée. */
  function contexte(ip = '203.0.113.10', path = '/api/auth/login') {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ method: 'POST', ip, path, route: { path } }),
        getResponse: () => ({
          setHeader: (name: string, value: unknown) => {
            headers[name] = value;
          },
        }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    headers = {};
    regle = { limit: 3, windowSeconds: 60 };

    const reflector = {
      getAllAndOverride: () => regle,
    } as unknown as Reflector;

    guard = new RateLimitGuard(reflector);
    jest.spyOn(guard['logger'], 'warn').mockImplementation(() => undefined);
  });

  it('laisse passer une route sans règle déclarée', () => {
    regle = undefined;

    expect(guard.canActivate(contexte())).toBe(true);
  });

  it('laisse passer tant que la limite n\'est pas atteinte', () => {
    expect(guard.canActivate(contexte())).toBe(true);
    expect(guard.canActivate(contexte())).toBe(true);
    expect(guard.canActivate(contexte())).toBe(true);
  });

  it('refuse au-delà de la limite', () => {
    guard.canActivate(contexte());
    guard.canActivate(contexte());
    guard.canActivate(contexte());

    expect(() => guard.canActivate(contexte())).toThrow(HttpException);
  });

  it('répond 429 avec un code exploitable et un délai', () => {
    for (let i = 0; i < 3; i += 1) {
      guard.canActivate(contexte());
    }

    try {
      guard.canActivate(contexte());
    } catch (error) {
      const exception = error as HttpException;
      expect(exception.getStatus()).toBe(429);
      expect(exception.getResponse()).toMatchObject({
        error: 'TOO_MANY_ATTEMPTS',
      });
    }

    expect(headers['Retry-After']).toBeGreaterThan(0);
  });

  // Sans cloisonnement par adresse, un seul visiteur insistant bloquerait tout
  // le monde.
  it('compte séparément chaque adresse', () => {
    for (let i = 0; i < 3; i += 1) {
      guard.canActivate(contexte('203.0.113.10'));
    }

    expect(guard.canActivate(contexte('198.51.100.20'))).toBe(true);
  });

  it('compte séparément chaque route', () => {
    for (let i = 0; i < 3; i += 1) {
      guard.canActivate(contexte('203.0.113.10', '/api/auth/login'));
    }

    expect(
      guard.canActivate(contexte('203.0.113.10', '/api/auth/register')),
    ).toBe(true);
  });

  it('repart à zéro une fois la fenêtre écoulée', () => {
    jest.useFakeTimers();

    try {
      for (let i = 0; i < 3; i += 1) {
        guard.canActivate(contexte());
      }
      expect(() => guard.canActivate(contexte())).toThrow();

      jest.advanceTimersByTime(61_000);

      expect(guard.canActivate(contexte())).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  // Le message ne doit rien dire de ce qui a été tenté.
  it('ne divulgue rien sur la tentative', () => {
    for (let i = 0; i < 3; i += 1) {
      guard.canActivate(contexte());
    }

    try {
      guard.canActivate(contexte());
    } catch (error) {
      const corps = JSON.stringify((error as HttpException).getResponse());
      expect(corps).not.toMatch(/mot de passe|email|jeton/i);
    }
  });
});
