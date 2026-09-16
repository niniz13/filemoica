import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Corps d'erreur renvoyé par l'API, quelle que soit la panne.
 *
 * Décrit ici sous forme de classe uniquement pour apparaître dans la
 * documentation : le filtre d'exceptions global reste la source unique de ce
 * format. Toute route peut renvoyer cette forme.
 */
export class ApiErrorResponse {
  /**
   * Code machine stable, en majuscules. C'est sur lui que le front branche ses
   * conditions — le message, lui, peut être reformulé à tout moment.
   */
  @ApiProperty({
    example: 'SHARE_REVOKED',
    description: 'Code d\'erreur stable, exploitable par le client.',
  })
  error: string;

  /** Message lisible, destiné à être affiché à l'utilisateur. */
  @ApiProperty({ example: 'Ce lien de partage a été révoqué.' })
  message: string;

  /** Détail des champs invalides. Présent uniquement sur `VALIDATION_ERROR`. */
  @ApiPropertyOptional({
    type: [String],
    example: ['email must be an email'],
  })
  details?: string[];
}
