import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
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
 * Variables à interpréter comme des booléens.
 *
 * Elles sont converties **avant** la validation, et non par un décorateur de
 * transformation. La conversion automatique de types appliquerait sinon
 * `Boolean("false")`, qui vaut… `true` — toute chaîne non vide étant vraie.
 * Une variable mise à `false` serait donc restée active, et l'erreur ne se
 * verrait qu'en production, au pire moment.
 */
const BOOLEAN_KEYS = ['ENABLE_API_DOCS', 'RATE_LIMIT_ENABLED'] as const;

/** Valeurs textuelles considérées comme fausses. */
const FALSY = new Set(['false', '0', 'no', 'non', '']);

/**
 * Convertit les variables booléennes avant validation.
 *
 * Absentes, elles sont laissées telles quelles pour que la valeur par défaut
 * déclarée dans la classe s'applique.
 */
function normalizeBooleans(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...raw };

  for (const key of BOOLEAN_KEYS) {
    const value = normalized[key];

    if (typeof value === 'string') {
      normalized[key] = !FALSY.has(value.trim().toLowerCase());
    }
  }

  return normalized;
}

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

  /**
   * Version applicative exposée par `/health`. Renseignée au déploiement par
   * SRC (tag git), pour pouvoir vérifier quelle version tourne réellement.
   */
  @IsString()
  APP_VERSION: string = 'dev';

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
   * Taille maximale d'un fichier déposé, en mégaoctets.
   *
   * Une borne est indispensable : sans elle, un seul dépôt peut remplir le
   * disque et empêcher tous les suivants. La valeur doit rester cohérente avec
   * l'espace alloué par l'infrastructure.
   */
  @IsInt()
  @Min(1)
  @Max(2048)
  MAX_FILE_SIZE_MB: number = 200;

  /**
   * Volume mensuel de dépôt inclus dans l'offre gratuite, en mégaoctets.
   *
   * Dans la configuration : l'offre doit pouvoir être ajustée après un retour
   * d'utilisateur sans qu'il faille modifier et redéployer le code.
   */
  @IsInt()
  @Min(1)
  FREE_PLAN_QUOTA_MB: number = 200;

  /** Volume mensuel de l'offre payante, en mégaoctets. */
  @IsInt()
  @Min(1)
  PREMIUM_PLAN_QUOTA_MB: number = 20_480;

  /**
   * Durée de conservation d'un fichier dans l'offre gratuite, en jours.
   *
   * Comptée depuis la **fin du dernier partage** du fichier, ou depuis son
   * dépôt s'il n'a jamais été partagé — jamais depuis le dépôt seul. Un fichier
   * partagé pour 30 jours survit donc à son lien, et le délai ne commence à
   * courir qu'ensuite.
   *
   * La conservation est un levier de l'offre autant qu'une mesure d'hygiène :
   * sans elle, le disque se remplit indéfiniment, puisque le quota compte les
   * dépôts et non le stockage.
   */
  @IsInt()
  @Min(1)
  FREE_PLAN_RETENTION_DAYS: number = 30;

  /** Durée de conservation dans l'offre payante, en jours. */
  @IsInt()
  @Min(1)
  PREMIUM_PLAN_RETENTION_DAYS: number = 90;

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

  /**
   * Active la limitation de tentatives sur les routes sensibles.
   *
   * Vraie par défaut. Désactivée dans la suite de tests, qui crée des dizaines
   * de comptes d'affilée depuis la même adresse et heurterait la limite sans
   * rien démontrer — le comportement du garde est vérifié par ses propres
   * tests unitaires.
   */
  @IsBoolean()
  RATE_LIMIT_ENABLED: boolean = true;

  /**
   * Nombre de relais de confiance devant le service.
   *
   * L'application tourne derrière le reverse proxy de l'infrastructure : sans ce
   * réglage, **toutes** les requêtes sembleraient venir de l'adresse du proxy,
   * et la limitation de débit bloquerait tout le monde d'un coup dès qu'un seul
   * visiteur s'agite.
   *
   * La valeur compte les relais à traverser pour retrouver l'adresse réelle.
   * Elle reste à zéro en développement — faire confiance à un en-tête
   * `X-Forwarded-For` quand personne ne le réécrit permettrait à n'importe qui
   * de se faire passer pour n'importe quelle adresse.
   */
  @IsInt()
  @Min(0)
  @Max(5)
  TRUST_PROXY_HOPS: number = 0;

  /**
   * Expose la documentation interactive sur `/api/docs`.
   *
   * Activée par défaut : elle sert au front pendant le développement et au jury
   * pendant la démonstration. Elle décrit la surface de l'API — routes,
   * paramètres, codes d'erreur — ce qui facilite autant le travail d'un
   * intégrateur que le repérage d'un attaquant. La couper reste donc possible
   * en production, sans toucher au code.
   *
   * Voir {@link BOOLEAN_KEYS} pour la conversion de la valeur textuelle.
   */
  @IsBoolean()
  ENABLE_API_DOCS: boolean = true;
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
  const config = plainToInstance(EnvironmentVariables, normalizeBooleans(raw), {
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
