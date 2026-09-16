import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
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
export class AppModule {}
