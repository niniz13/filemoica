import { ApiProperty } from '@nestjs/swagger';

/**
 * Représentation publique d'un compte.
 *
 * Ne contient **jamais** l'empreinte du mot de passe : c'est la seule forme
 * sous laquelle un compte sort de l'API.
 */
export class UserResponse {
  @ApiProperty({
    format: 'uuid',
    example: '3f2b8c1e-9d4a-4f6b-8e2c-7a1d5b3c9e0f',
  })
  id: string;

  @ApiProperty({ format: 'email', example: 'alice@example.fr' })
  email: string;

  @ApiProperty({ enum: ['USER', 'ADMIN'], example: 'USER' })
  role: string;
}

/** Réponse de `GET /api/auth/me` : le strict nécessaire, lu depuis le jeton. */
export class CurrentUserResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'email' })
  email: string;
}

/** Réponse de `POST /api/auth/refresh`. Les jetons partent dans les cookies. */
export class RefreshedResponse {
  @ApiProperty({ example: true })
  refreshed: true;
}
