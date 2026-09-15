import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      // Disponible partout sans réimporter le module dans chaque feature.
      isGlobal: true,
      // Validation au démarrage : configuration incomplète = refus de démarrer.
      validate: validateEnv,
      cache: true,
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
