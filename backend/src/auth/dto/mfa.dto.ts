import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsString,
  IsUUID,
  Length,
  Matches,
  MinLength,
} from 'class-validator';

/**
 * Ce que renvoie `POST /api/auth/login` quand le compte exige un second
 * facteur : aucun cookie, un défi à relever.
 */
export class MfaChallengeResponse {
  @ApiProperty({
    example: true,
    description:
      'Le compte exige un second facteur. Aucune session n\'est ouverte à ce stade.',
  })
  mfaRequired: true;

  @ApiProperty({
    format: 'uuid',
    description:
      'Identifiant du défi, à renvoyer avec le code reçu par courriel. Ce n\'est pas un secret : le secret, c\'est le code.',
  })
  challengeId: string;
}

/** Ce que renvoie `POST /api/auth/login` quand le compte n'exige pas de code. */
export class DirectLoginResponse {
  @ApiProperty({ example: false })
  mfaRequired: false;

  @ApiProperty({ description: 'Le compte connecté. Les cookies sont posés.' })
  user: { id: string; email: string; role: string };
}

/**
 * Les deux issues possibles d'une connexion.
 *
 * Le champ `mfaRequired` sert de discriminant : le client regarde ce seul
 * champ pour savoir s'il est connecté ou s'il doit demander un code.
 */
export type LoginResponse = MfaChallengeResponse | DirectLoginResponse;

/** Bascule de la double authentification sur son propre compte. */
export class SetMfaDto {
  @ApiProperty({ description: 'Activer ou couper le second facteur.' })
  @IsBoolean()
  enabled: boolean;

  @ApiProperty({
    description:
      'Mot de passe du compte. Redemandé parce que couper un facteur d\'authentification ne doit pas être possible avec une simple session.',
  })
  @IsString()
  @MinLength(1)
  password: string;
}

/** État du second facteur après la bascule. */
export class MfaSettingResponse {
  @ApiProperty({ example: true })
  mfaEnabled: boolean;
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
