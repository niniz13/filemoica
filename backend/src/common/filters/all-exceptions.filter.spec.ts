import {
  ArgumentsHost,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { AllExceptionsFilter, ApiErrorBody } from './all-exceptions.filter';

/**
 * Simule le contexte HTTP attendu par le filtre et expose le corps réellement
 * renvoyé, pour pouvoir l'inspecter dans les assertions.
 */
function createHost(): {
  host: ArgumentsHost;
  getStatus: () => number;
  getBody: () => ApiErrorBody;
} {
  let status = 0;
  let body = {} as ApiErrorBody;

  const response = {
    status: (code: number) => {
      status = code;
      return response;
    },
    json: (payload: ApiErrorBody) => {
      body = payload;
      return response;
    },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'POST', url: '/api/files' }),
    }),
  } as unknown as ArgumentsHost;

  return { host, getStatus: () => status, getBody: () => body };
}

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    // Le filtre loggue les 500 : on coupe le bruit sans masquer les assertions.
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
    jest.spyOn(filter['logger'], 'debug').mockImplementation(() => undefined);
  });

  it('respecte le code métier fourni par l\'appelant', () => {
    const { host, getStatus, getBody } = createHost();

    filter.catch(
      new ForbiddenException({
        error: 'SHARE_REVOKED',
        message: 'Ce lien de partage a été révoqué.',
      }),
      host,
    );

    expect(getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(getBody()).toEqual({
      error: 'SHARE_REVOKED',
      message: 'Ce lien de partage a été révoqué.',
    });
  });

  // Nest place un libellé humain (« Not Found ») dans son propre champ `error`.
  // Le laisser passer donnerait au front une chaîne instable à tester.
  it('ignore le libellé par défaut de Nest au profit d\'un code stable', () => {
    const { host, getBody } = createHost();

    filter.catch(new NotFoundException('Fichier introuvable.'), host);

    expect(getBody().error).toBe('NOT_FOUND');
    expect(getBody().message).toBe('Fichier introuvable.');
  });

  it('regroupe les erreurs du ValidationPipe dans `details`', () => {
    const { host, getStatus, getBody } = createHost();

    // Forme exacte de ce que produit le ValidationPipe de Nest.
    filter.catch(
      new BadRequestException({
        message: ['email must be an email', 'password should not be empty'],
        error: 'Bad Request',
        statusCode: 400,
      }),
      host,
    );

    expect(getStatus()).toBe(HttpStatus.BAD_REQUEST);
    expect(getBody()).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'La requête est invalide.',
      details: ['email must be an email', 'password should not be empty'],
    });
  });

  // Le test qui compte pour le critère « accès vérifiés » : une erreur interne
  // ne doit rien révéler de l'implémentation à un attaquant.
  it('masque les détails d\'une exception non prévue', () => {
    const { host, getStatus, getBody } = createHost();

    filter.catch(
      new Error('connect ECONNREFUSED 10.0.0.5:5432 — prisma schema "users"'),
      host,
    );

    expect(getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(getBody()).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Une erreur interne est survenue.',
    });
    expect(JSON.stringify(getBody())).not.toContain('5432');
  });

  it('gère une HttpException dont la réponse est une simple chaîne', () => {
    const { host, getBody } = createHost();

    filter.catch(new HttpException('Trop de requêtes.', 429), host);

    expect(getBody()).toEqual({
      error: 'TOO_MANY_REQUESTS',
      message: 'Trop de requêtes.',
    });
  });

  it('loggue la trace complète des erreurs serveur, côté serveur uniquement', () => {
    const { host } = createHost();
    const logSpy = jest.spyOn(filter['logger'], 'error');

    filter.catch(new Error('boom'), host);

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('POST /api/files'),
      expect.stringContaining('boom'),
    );
  });
});
