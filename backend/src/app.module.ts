import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env.validation';
import { CryptoModule } from './crypto/crypto.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';

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
    AuthModule,
    HealthModule,
  ],
})
export class AppModule {}
