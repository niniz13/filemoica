import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

/**
 * Environnements d'exécution reconnus par le service.
 *
 * `production` durcit automatiquement certains comportements (cookies `Secure`,
 * messages d'erreur génériques), il ne doit donc jamais être une valeur libre.
 */
export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/**
 * Une clé AES-256 ou HMAC-SHA256 fait 32 octets, transmis en 64 caractères
 * hexadécimaux. On refuse toute autre longueur : une clé trop courte
 * affaiblirait silencieusement le chiffrement au repos.
 */
const HEX_32_BYTES = /^[0-9a-fA-F]{64}$/;

/** Durée façon `jsonwebtoken` : `15m`, `7d`, `3600s`... */
const DURATION = /^\d+[smhd]$/;

/**
 * Contrat de configuration du service.
 *
 * Chaque variable attendue est déclarée ici avec sa règle de validation. Les
 * secrets n'ont **jamais** de valeur par défaut : un `JWT_SECRET` ou une clé de
 * chiffrement oubliée doit empêcher le démarrage, pas laisser le service tourner
 * avec une valeur faible que personne ne remarquerait avant la mise en ligne.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  /** Chaîne de connexion PostgreSQL, consommée par Prisma. */
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'DATABASE_URL doit être une URL postgresql://',
  })
  DATABASE_URL: string;

  /** Secret de signature des access tokens (HS256). */
  @IsString()
  @MinLength(32, {
    message: 'JWT_SECRET doit faire au moins 32 caractères',
  })
  JWT_SECRET: string;

  /**
   * Durée de vie de l'access token. Court volontairement : un cookie volé
   * n'est exploitable que le temps de cette fenêtre.
   */
  @Matches(DURATION, { message: 'JWT_ACCESS_TTL doit ressembler à "15m"' })
  JWT_ACCESS_TTL: string = '15m';

  /** Durée de vie du refresh token opaque, en jours. */
  @IsInt()
  @Min(1)
  @Max(90)
  REFRESH_TOKEN_TTL_DAYS: number = 7;

  /** Répertoire où sont écrits les fichiers chiffrés. */
  @IsString()
  @MinLength(1)
  STORAGE_PATH: string;

  /**
   * Clé maître (KEK) version 1. Elle ne chiffre jamais un fichier directement :
   * elle chiffre la clé propre à chaque fichier (DEK), ce qui rend la rotation
   * possible sans retoucher aux fichiers eux-mêmes.
   */
  @Matches(HEX_32_BYTES, {
    message: 'ENCRYPTION_KEY_V1 doit faire 64 caractères hexadécimaux',
  })
  ENCRYPTION_KEY_V1: string;

  /**
   * Clé maître version 2, présente uniquement pendant une rotation de clés.
   * Absente en temps normal.
   */
  @IsOptional()
  @Matches(HEX_32_BYTES, {
    message: 'ENCRYPTION_KEY_V2 doit faire 64 caractères hexadécimaux',
  })
  ENCRYPTION_KEY_V2?: string;

  /**
   * Clé de l'index aveugle. Elle sert à calculer un HMAC des emails de
   * destinataires pour pouvoir les comparer sans les déchiffrer. Distincte de la
   * clé de chiffrement : une clé, un usage.
   */
  @Matches(HEX_32_BYTES, {
    message: 'HMAC_INDEX_KEY doit faire 64 caractères hexadécimaux',
  })
  HMAC_INDEX_KEY: string;

  /**
   * Origine exacte du front. Elle sert à la fois au CORS et à la défense CSRF :
   * une liste blanche d'une seule origine, jamais de joker.
   */
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  FRONTEND_ORIGIN: string;

  /** Domaine des cookies. Absent en local, renseigné par SRC en production. */
  @IsOptional()
  @IsString()
  COOKIE_DOMAIN?: string;
}

/**
 * Valide `process.env` au démarrage et renvoie la configuration typée.
 *
 * Appelée par `ConfigModule.forRoot({ validate })`. En cas d'erreur, on lève une
 * exception listant **tous** les problèmes d'un coup : corriger son `.env` en
 * une fois plutôt que de redémarrer six fois de suite.
 *
 * Les valeurs fautives ne sont jamais incluses dans le message — il ne faut pas
 * qu'un secret mal formé finisse dans les logs de démarrage.
 *
 * @param raw Variables d'environnement brutes (toutes des chaînes).
 * @throws {Error} Si une variable est absente ou invalide.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: true,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
    whitelist: false,
    validationError: { value: false, target: false },
  });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {});
        return `  - ${error.property} : ${constraints.join(', ')}`;
      })
      .join('\n');

    throw new Error(
      `Configuration invalide, le service ne peut pas démarrer :\n${details}\n` +
        'Voir .env.example pour la liste des variables attendues.',
    );
  }

  return config;
}
