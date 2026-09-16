import type { NextFunction, Request, Response } from 'express';
import { RequestLoggerMiddleware } from './request-logger.middleware';

/** Entrée de journal telle que le middleware la produit. */
interface LogEntry {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  userId?: string;
}

describe('RequestLoggerMiddleware', () => {
  let middleware: RequestLoggerMiddleware;
  let logged: LogEntry[];
  let headers: Record<string, unknown>;
  let finish: () => void;

  /** Simule une requête, et renvoie de quoi déclencher sa fin. */
  function traiter(
    request: Partial<Request>,
    status = 200,
  ): { next: jest.Mock } {
    const next = jest.fn() as unknown as NextFunction & jest.Mock;

    const response = {
      statusCode: status,
      setHeader: (name: string, value: unknown) => {
        headers[name] = value;
      },
      on: (event: string, handler: () => void) => {
        if (event === 'finish') {
          finish = handler;
        }
      },
    } as unknown as Response;

    middleware.use(request as Request, response, next);

    return { next };
  }

  beforeEach(() => {
    middleware = new RequestLoggerMiddleware();
    logged = [];
    headers = {};

    jest
      .spyOn(middleware['logger'], 'log')
      .mockImplementation((entry: unknown) => {
        logged.push(entry as LogEntry);
      });
    jest
      .spyOn(middleware['logger'], 'error')
      .mockImplementation((entry: unknown) => {
        logged.push(entry as LogEntry);
      });
  });

  it('journalise une ligne par requête', () => {
    traiter({ method: 'GET', originalUrl: '/api/files', url: '/api/files' });
    finish();

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      method: 'GET',
      path: '/api/files',
      status: 200,
    });
  });

  it('laisse passer la requête', () => {
    const { next } = traiter({ method: 'GET', originalUrl: '/api/files' });

    expect(next).toHaveBeenCalled();
  });

  // Le test central : journaliser l'URL de téléchargement telle quelle
  // reviendrait à recopier tous les liens du service dans les journaux.
  it('ne journalise jamais un jeton de partage', () => {
    const jeton = 'k3Jv8Qw2_pLm9XcR4tYnB6dFgH1sZaE7';
    traiter({
      method: 'GET',
      originalUrl: `/api/download/${jeton}`,
      url: `/api/download/${jeton}`,
    });
    finish();

    expect(logged[0].path).toBe('/api/download/:token');
    expect(JSON.stringify(logged[0])).not.toContain(jeton);
  });

  it('masque aussi le jeton sur la route de consultation', () => {
    const jeton = 'k3Jv8Qw2_pLm9XcR4tYnB6dFgH1sZaE7';
    traiter({
      method: 'GET',
      originalUrl: `/api/download/${jeton}/info`,
      url: `/api/download/${jeton}/info`,
    });
    finish();

    expect(JSON.stringify(logged[0])).not.toContain(jeton);
  });

  it('retire la chaîne de requête', () => {
    traiter({
      method: 'GET',
      originalUrl: '/api/files?secret=valeur',
      url: '/api/files?secret=valeur',
    });
    finish();

    expect(logged[0].path).toBe('/api/files');
  });

  it('rattache la requête à son utilisateur quand elle est authentifiée', () => {
    traiter({
      method: 'GET',
      originalUrl: '/api/files',
      user: { sub: 'user-1', email: 'alice@example.fr', jti: 'jeton' },
    });
    finish();

    expect(logged[0].userId).toBe('user-1');
  });

  it('expose un identifiant de corrélation au client', () => {
    traiter({ method: 'GET', originalUrl: '/api/files' });
    finish();

    expect(headers['X-Request-Id']).toBe(logged[0].requestId);
  });

  // Une erreur serveur doit ressortir dans une supervision qui filtre par
  // sévérité.
  it('élève le niveau sur une erreur serveur', () => {
    const errorSpy = jest.spyOn(middleware['logger'], 'error');
    traiter({ method: 'GET', originalUrl: '/api/files' }, 500);
    finish();

    expect(errorSpy).toHaveBeenCalled();
  });

  it('mesure la durée de la requête', () => {
    traiter({ method: 'GET', originalUrl: '/api/files' });
    finish();

    expect(logged[0].durationMs).toBeGreaterThanOrEqual(0);
  });
});
