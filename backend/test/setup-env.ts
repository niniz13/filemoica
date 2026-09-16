// Les décorateurs de class-validator lisent les métadonnées de type à
// l'exécution. En production c'est Nest qui charge ce polyfill ; en test,
// personne ne le fait à notre place.
import 'reflect-metadata';

/**
 * Variables d'environnement des tests.
 *
 * Chargé par Jest avant chaque suite (`setupFiles`). Sans ça, `AppModule`
 * refuserait de se construire : la validation de configuration est
 * volontairement stricte, y compris en test.
 *
 * Les valeurs sont factices et publiques — ce sont des clés de test, elles ne
 * protègent aucune donnée réelle. Les secrets de production vivent uniquement
 * dans le `.env` non versionné et dans les variables fournies par SRC.
 *
 * L'affectation est conditionnelle (`??=`) pour qu'une variable déjà posée par
 * l'environnement d'intégration continue reste prioritaire.
 */
process.env.NODE_ENV ??= 'test';
process.env.PORT ??= '3000';
process.env.DATABASE_URL ??=
  'postgresql://filemoica:filemoica@localhost:5433/filemoica_test';
process.env.JWT_SECRET ??= 'secret-de-test-strictement-non-productif-0000';
process.env.JWT_ACCESS_TTL ??= '15m';
process.env.REFRESH_TOKEN_TTL_DAYS ??= '7';
process.env.STORAGE_PATH ??= './storage-test';
process.env.ENCRYPTION_KEY_V1 ??= '1'.repeat(64);
process.env.HMAC_INDEX_KEY ??= '2'.repeat(64);
process.env.FRONTEND_ORIGIN ??= 'http://localhost:5173';

// Quotas réduits : vérifier un dépassement suppose de l'atteindre, et
// transférer 200 Mo dans une suite de tests coûterait des minutes pour prouver
// exactement la même chose qu'un mégaoctet.
process.env.FREE_PLAN_QUOTA_MB ??= '1';
process.env.PREMIUM_PLAN_QUOTA_MB ??= '5';

// La suite crée des dizaines de comptes d'affilée depuis la même adresse : la
// limitation de tentatives la bloquerait sans rien démontrer. Le comportement
// du garde est vérifié par ses propres tests unitaires.
process.env.RATE_LIMIT_ENABLED ??= 'false';
