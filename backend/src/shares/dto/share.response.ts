import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** État courant d'un partage. */
export type ShareStatus = 'ACTIVE' | 'EXPIRED' | 'REVOKED';

/** Un fichier tel qu'il apparaît dans un partage. */
export class SharedFileResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'rapport-annuel.pdf' })
  fileName: string;

  @ApiProperty({ example: 248_320, description: 'Taille en octets.' })
  sizeBytes: number;
}

/** Un partage tel que son créateur le voit. */
export class ShareResponse {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    type: [SharedFileResponse],
    description: 'Fichiers couverts par ce lien — un seul jeton pour toute la session.',
  })
  files: SharedFileResponse[];

  @ApiPropertyOptional({
    format: 'email',
    example: 'bob@example.fr',
    description:
      'Destinataire prévu, s\'il a été renseigné. Informatif : il ne conditionne pas l\'accès.',
  })
  recipientEmail?: string;

  @ApiProperty({
    description: 'Indique si le lien est protégé par un mot de passe.',
  })
  protectedByPassword: boolean;

  @ApiProperty({ enum: ['ACTIVE', 'EXPIRED', 'REVOKED'] })
  status: ShareStatus;

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

/**
 * Réponse à la création d'un partage.
 *
 * Le jeton n'apparaît **que dans cette réponse**. La base n'en conserve que
 * l'empreinte : ni le service ni un attaquant qui volerait la base ne peuvent
 * le reconstituer. Perdu, il faut créer un nouveau partage.
 */
export class CreatedShareResponse extends ShareResponse {
  @ApiProperty({
    description:
      'Jeton du lien, montré une seule fois. À transmettre au destinataire.',
    example: 'k3Jv8Qw2_pLm9XcR4tYnB6dFgH1sZaE7',
  })
  token: string;
}

/**
 * Ce qu'un lien révèle **avant** téléchargement, à qui le détient.
 *
 * Sert au front à composer sa page d'accueil : fichiers couverts, échéance, et
 * demande de mot de passe le cas échéant — plutôt que de laisser l'utilisateur
 * heurter une erreur.
 */
export class ShareInfoResponse {
  @ApiProperty({ description: 'Un mot de passe est-il exigé ?' })
  requiresPassword: boolean;

  @ApiProperty({ format: 'date-time' })
  expiresAt: Date;

  @ApiPropertyOptional({
    type: [SharedFileResponse],
    description:
      'Absent tant qu\'un mot de passe est exigé : un lien intercepté ne doit pas révéler ce qu\'il contient.',
  })
  files?: SharedFileResponse[];
}
