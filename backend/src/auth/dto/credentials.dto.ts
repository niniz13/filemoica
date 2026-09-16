import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Longueur minimale d'un mot de passe.
 *
 * La longueur est le seul critère retenu. Les règles de composition
 * (« une majuscule, un chiffre, un caractère spécial ») poussent en pratique
 * vers des mots de passe courts et prévisibles du type `Password1!`, alors
 * qu'une phrase longue résiste bien mieux. C'est aussi la recommandation
 * actuelle de l'ANSSI et du NIST.
 */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Longueur maximale.
 *
 * argon2 est volontairement coûteux : sans borne, un mot de passe d'un
 * mégaoctet occuperait le serveur à chaque tentative, ce qui en ferait un
 * moyen de déni de service.
 */
const MAX_PASSWORD_LENGTH = 128;

/** Longueur maximale d'un email, alignée sur la limite usuelle des adresses. */
const MAX_EMAIL_LENGTH = 255;

/**
 * Identifiants fournis à l'inscription comme à la connexion.
 *
 * Les contraintes sont déclarées **une seule fois**, sous forme de constantes
 * partagées entre la validation et la documentation. Le plugin Swagger saurait
 * déduire ces règles tout seul, mais il ne s'exécute qu'à travers `nest build` :
 * les annotations explicites garantissent une documentation juste quelle que
 * soit la façon dont l'application est démarrée.
 */
export class CredentialsDto {
  @ApiProperty({
    format: 'email',
    maxLength: MAX_EMAIL_LENGTH,
    example: 'alice@example.fr',
    description: 'La casse et les espaces autour sont normalisés.',
  })
  @IsEmail({}, { message: 'Email invalide.' })
  @MaxLength(MAX_EMAIL_LENGTH)
  email: string;

  @ApiProperty({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
    example: 'une phrase de passe bien plus sûre',
    description:
      'Au moins 12 caractères. Aucune règle de composition imposée : une phrase longue vaut mieux qu\'un mot court truffé de symboles.',
  })
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`,
  })
  @MaxLength(MAX_PASSWORD_LENGTH)
  password: string;
}

export { MAX_EMAIL_LENGTH, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH };
