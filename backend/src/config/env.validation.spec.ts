import { NodeEnv, validateEnv } from './env.validation';

/** 64 caractères hexadécimaux : le format attendu pour une clé de 32 octets. */
const VALID_KEY = 'a'.repeat(64);

/** Configuration minimale valide, dont chaque test dérive sa propre variante. */
function validEnv(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/filemoica',
    JWT_SECRET: 's'.repeat(32),
    STORAGE_PATH: './storage',
    ENCRYPTION_KEY_V1: VALID_KEY,
    HMAC_INDEX_KEY: VALID_KEY,
    FRONTEND_ORIGIN: 'http://localhost:5173',
  };
}

describe('validateEnv', () => {
  it('accepte une configuration minimale et applique les valeurs par défaut', () => {
    const config = validateEnv(validEnv());

    expect(config.NODE_ENV).toBe(NodeEnv.Development);
    expect(config.PORT).toBe(3000);
    expect(config.JWT_ACCESS_TTL).toBe('15m');
    expect(config.REFRESH_TOKEN_TTL_DAYS).toBe(7);
  });

  it('convertit les nombres, qui arrivent toujours en chaînes depuis le shell', () => {
    const config = validateEnv({
      ...validEnv(),
      PORT: '8080',
      REFRESH_TOKEN_TTL_DAYS: '30',
    });

    expect(config.PORT).toBe(8080);
    expect(config.REFRESH_TOKEN_TTL_DAYS).toBe(30);
  });

  it('refuse de démarrer si une variable obligatoire manque', () => {
    const incomplete = validEnv();
    delete incomplete.JWT_SECRET;

    expect(() => validateEnv(incomplete)).toThrow(/JWT_SECRET/);
  });

  it('signale toutes les erreurs en une fois plutôt que la première', () => {
    expect(() => validateEnv({})).toThrow(
      /DATABASE_URL[\s\S]*JWT_SECRET[\s\S]*STORAGE_PATH/,
    );
  });

  // Le cœur de la sécurité du chiffrement au repos : une clé trop courte
  // dégraderait l'AES-256 sans que personne ne s'en aperçoive.
  it.each([
    ['trop courte', 'abc'],
    ['non hexadécimale', 'z'.repeat(64)],
    ['trop longue', 'a'.repeat(65)],
  ])('refuse une clé de chiffrement %s', (_cas, key) => {
    expect(() => validateEnv({ ...validEnv(), ENCRYPTION_KEY_V1: key })).toThrow(
      /ENCRYPTION_KEY_V1/,
    );
  });

  it('refuse un secret JWT de moins de 32 caractères', () => {
    expect(() => validateEnv({ ...validEnv(), JWT_SECRET: 'court' })).toThrow(
      /JWT_SECRET/,
    );
  });

  it('accepte une clé de rotation optionnelle', () => {
    const config = validateEnv({
      ...validEnv(),
      ENCRYPTION_KEY_V2: 'b'.repeat(64),
    });

    expect(config.ENCRYPTION_KEY_V2).toBe('b'.repeat(64));
  });

  it('refuse une URL de base de données qui n\'est pas PostgreSQL', () => {
    expect(() =>
      validateEnv({ ...validEnv(), DATABASE_URL: 'mysql://localhost/db' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('refuse un environnement inconnu', () => {
    expect(() => validateEnv({ ...validEnv(), NODE_ENV: 'prod' })).toThrow(
      /NODE_ENV/,
    );
  });

  // Un message d'erreur de démarrage part dans les logs, potentiellement
  // agrégés par SRC : il ne doit jamais contenir la valeur d'un secret.
  it('ne divulgue jamais la valeur fautive dans le message d\'erreur', () => {
    const secret = 'secret-mal-forme-a-ne-pas-logguer';
    let message = '';

    try {
      validateEnv({ ...validEnv(), ENCRYPTION_KEY_V1: secret });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('ENCRYPTION_KEY_V1');
    expect(message).not.toContain(secret);
  });
});
