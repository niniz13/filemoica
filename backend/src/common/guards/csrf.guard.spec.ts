import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CsrfGuard } from './csrf.guard';

/** Construit un contexte d'exécution minimal pour une requête donnée. */
function createContext(
  method: string,
  headers: Record<string, string> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method, headers }),
    }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  const guard = new CsrfGuard();

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'laisse passer %s sans en-tête : ces méthodes ne modifient rien',
    (method) => {
      expect(guard.canActivate(createContext(method))).toBe(true);
    },
  );

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'refuse %s sans en-tête X-Requested-With',
    (method) => {
      expect(() => guard.canActivate(createContext(method))).toThrow(
        ForbiddenException,
      );
    },
  );

  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])(
    'accepte %s avec l\'en-tête X-Requested-With',
    (method) => {
      const context = createContext(method, {
        'x-requested-with': 'XMLHttpRequest',
      });

      expect(guard.canActivate(context)).toBe(true);
    },
  );

  it('expose un code d\'erreur exploitable par le front', () => {
    expect.assertions(1);

    try {
      guard.canActivate(createContext('POST'));
    } catch (error) {
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        error: 'CSRF_HEADER_MISSING',
      });
    }
  });

  // Scénario réel : un formulaire posté depuis un site tiers arrive avec les
  // cookies de la victime mais ne peut pas poser d'en-tête personnalisé.
  it('bloque une soumission de formulaire inter-sites', () => {
    const attaque = createContext('POST', {
      origin: 'https://site-pirate.example',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: 'access_token=vole',
    });

    expect(() => guard.canActivate(attaque)).toThrow(ForbiddenException);
  });

  it('accepte une méthode écrite en minuscules', () => {
    expect(guard.canActivate(createContext('get'))).toBe(true);
  });
});
