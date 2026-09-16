import { ApiProperty } from '@nestjs/swagger';

/**
 * Un fichier tel qu'il est renvoyé à son propriétaire.
 *
 * Ne contient rien de ce qui permettrait de le retrouver sur le support : ni le
 * nom de rangement, ni la clé chiffrée, ni le vecteur d'initialisation. Ces
 * informations ne servent qu'au serveur.
 */
export class FileResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'rapport-annuel.pdf',
    description: 'Nom d\'origine, déchiffré pour l\'affichage.',
  })
  originalName: string;

  @ApiProperty({ example: 248_320, description: 'Taille en octets.' })
  sizeBytes: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}
