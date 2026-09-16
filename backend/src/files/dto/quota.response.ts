import { ApiProperty } from '@nestjs/swagger';

/**
 * État du quota mensuel d'un compte.
 *
 * Destiné à être affiché en permanence par le front : une limite qu'on ne
 * découvre qu'en la heurtant est vécue comme une panne.
 */
export class QuotaResponse {
  @ApiProperty({
    enum: ['FREE', 'PREMIUM'],
    description: 'Offre souscrite par le compte.',
  })
  plan: string;

  @ApiProperty({ example: 52_428_800, description: 'Déjà déposé ce mois-ci.' })
  usedBytes: number;

  @ApiProperty({ example: 209_715_200, description: 'Autorisé par l\'offre.' })
  limitBytes: number;

  @ApiProperty({ example: 157_286_400, description: 'Reste à déposer.' })
  remainingBytes: number;

  @ApiProperty({ example: '2026-09', description: 'Mois concerné.' })
  period: string;
}
