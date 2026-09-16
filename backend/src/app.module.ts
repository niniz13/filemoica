import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { RequestLoggerMiddleware } from './common/logging/request-logger.middleware';
import { validateEnv } from './config/env.validation';
import { CryptoModule } from './crypto/crypto.module';
import { FilesModule } from './files/files.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { SharesModule } from './shares/shares.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      // Disponible partout sans réimporter le module dans chaque feature.
      isGlobal: true,
      // Validation au démarrage : configuration incomplète = refus de démarrer.
      validate: validateEnv,
      cache: true,
      // En test, le fichier `.env` du poste est ignoré : les tests ne doivent
      // dépendre que de `test/setup-env.ts`. Sans cela, une clé ajoutée
      // localement — lors d'une rotation, par exemple — se glisse dans la
      // configuration des tests et en fausse les hypothèses.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    CryptoModule,
    StorageModule,
    AuthModule,
    FilesModule,
    SharesModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * Branche le journal de requêtes sur **toutes** les routes.
   *
   * Un intergiciel plutôt qu'un intercepteur : il s'exécute avant les gardes,
   * donc une requête refusée pour défaut d'authentification ou de jeton CSRF
   * apparaît elle aussi dans les journaux. Ce sont justement celles qu'on veut
   * voir en cas d'incident.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
