import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { RequestLoggerMiddleware } from './common/logging/request-logger.middleware';
import { validateEnv } from './config/env.validation';
import { CryptoModule } from './crypto/crypto.module';
import { FilesModule } from './files/files.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { PrismaModule } from './prisma/prisma.module';
import { SharesModule } from './shares/shares.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      // Disponible partout sans r�importer le module dans chaque feature.
      isGlobal: true,
      // Validation au d�marrage : configuration incompl�te = refus de d�marrer.
      validate: validateEnv,
      cache: true,
      // En test, le fichier `.env` du poste est ignor� : les tests ne doivent
      // d�pendre que de `test/setup-env.ts`. Sans cela, une cl� ajout�e
      // localement � lors d'une rotation, par exemple � se glisse dans la
      // configuration des tests et en fausse les hypoth�ses.
      ignoreEnvFile: process.env.NODE_ENV === 'test',
    }),
    MailModule,
    PrismaModule,
    CryptoModule,
    StorageModule,
    AuthModule,
    FilesModule,
    SharesModule,
    AdminModule,
    HealthModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * Branche le journal de requ�tes sur **toutes** les routes.
   *
   * Un intergiciel plut�t qu'un intercepteur : il s'ex�cute avant les gardes,
   * donc une requ�te refus�e pour d�faut d'authentification ou de jeton CSRF
   * appara�t elle aussi dans les journaux. Ce sont justement celles qu'on veut
   * voir en cas d'incident.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggerMiddleware).forRoutes('*');
  }
}
