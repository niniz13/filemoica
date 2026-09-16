import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Length, Matches } from 'class-validator';

/** Ce que renvoie `POST /api/auth/login` : aucun cookie, un défi à relever. */
export class MfaChallengeResponse {
  @ApiProperty({
    example: true,
    description:
      'Toujours vrai : la double authentification est exigée sur tous les comptes.',
  })
  mfaRequired: true;

  @ApiProperty({
    format: 'uuid',
    description:
      'Identifiant du défi, à renvoyer avec le code reçu par courriel. Ce n\'est pas un secret : le secret, c\'est le code.',
  })
  challengeId: string;
}

/** Code à six chiffres reçu par courriel. */
export class VerifyMfaDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4', { message: 'Identifiant de défi invalide.' })
  challengeId: string;

  @ApiProperty({ example: '482913', minLength: 6, maxLength: 6 })
  @IsString()
  @Length(6, 6, { message: 'Le code comporte six chiffres.' })
  // Uniquement des chiffres : cela écarte d'emblée les saisies fantaisistes
  // sans consommer un essai du défi.
  @Matches(/^\d{6}$/, { message: 'Le code comporte six chiffres.' })
  code: string;
}
