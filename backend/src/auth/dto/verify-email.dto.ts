import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** Jeton reçu dans le lien de confirmation. */
export class VerifyEmailDto {
  @ApiProperty({
    description: 'Jeton présent dans le lien envoyé par courriel.',
    example: 'k3Jv8Qw2ZpL...',
  })
  @IsString()
  @MinLength(10)
  @MaxLength(200)
  token: string;
}

/** Demande d'un nouveau lien de confirmation. */
export class ResendVerificationDto {
  @ApiProperty({ format: 'email', example: 'alice@example.fr' })
  @IsEmail({}, { message: 'Email invalide.' })
  @MaxLength(255)
  email: string;
}
