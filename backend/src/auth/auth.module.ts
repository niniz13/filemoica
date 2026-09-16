import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import type { EnvironmentVariables } from '../config/env.validation';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { CookieService } from './cookie.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: {
          // HS256 : une seule clé partagée, suffisant tant que c'est le même
          // service qui signe et vérifie. Une signature asymétrique n'aurait
          // d'intérêt que si un tiers devait vérifier nos jetons.
          algorithm: 'HS256',
          expiresIn: config.get('JWT_ACCESS_TTL', { infer: true }),
        },
        verifyOptions: {
          // Sans cette contrainte, un attaquant pourrait présenter un jeton
          // signé avec `alg: none` ou un algorithme plus faible.
          algorithms: ['HS256'],
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    PasswordService,
    CookieService,
    {
      // Protection par défaut : toute route est fermée tant qu'elle n'est pas
      // ouverte par `@Public()`.
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  // `PasswordService` sert aussi aux mots de passe des liens de partage : une
  // seule implémentation du hachage, donc un seul endroit où se tromper.
  exports: [TokenService, PasswordService],
})
export class AuthModule {}
