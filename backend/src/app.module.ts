import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
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
    HealthModule,
  ],
})
export class AppModule {}
