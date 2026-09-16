import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Durée de validité minimale d'un lien, en heures. */
const MIN_HOURS = 1;

/**
 * Durée maximale, en heures (30 jours).
 *
 * Un partage « temporaire » qui durerait des années n'en serait plus un. La
 * borne force à choisir une durée, et limite la fenêtre pendant laquelle un
 * lien oublié reste exploitable.
 */
const MAX_HOURS = 24 * 30;

/** Durée par défaut : trois jours, le temps qu'un destinataire relève ses mails. */
const DEFAULT_HOURS = 72;

/**
 * Longueur minimale du mot de passe d'un lien.
 *
 * Plus courte que celle d'un compte : ce mot de passe est communiqué de vive
 * voix ou par un autre canal, il protège un seul fichier pour quelques jours, et
 * une exigence trop lourde pousserait simplement à ne pas en mettre.
 */
const MIN_PASSWORD_LENGTH = 6;

const MAX_PASSWORD_LENGTH = 128;

/**
 * Nombre maximal de fichiers derrière un même lien.
 *
 * Une session de dépôt reste une poignée de fichiers : au-delà, mieux vaut
 * plusieurs liens que de rendre un seul jeton disproportionnellement précieux.
 */
const MAX_FILES_PER_SHARE = 50;

export class CreateShareDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Fichiers à partager derrière ce lien — un seul jeton pour toute la session de dépôt.',
  })
  @IsArray()
  @ArrayMinSize(1, { message: 'Au moins un fichier est requis.' })
  @ArrayMaxSize(MAX_FILES_PER_SHARE)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  fileIds: string[];

  @ApiPropertyOptional({
    format: 'email',
    description:
      'Destinataire prévu. **Informatif : ne restreint pas l\'accès.** Le lien se suffit à lui-même et son destinataire n\'a pas besoin de compte. Utiliser un mot de passe pour restreindre réellement.',
  })
  @IsOptional()
  @IsEmail({}, { message: 'Email du destinataire invalide.' })
  @MaxLength(255)
  recipientEmail?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Lien à usage unique. Le lien se consume une fois que **tous** ses fichiers ont été téléchargés — et non au premier, sinon un destinataire ayant plusieurs fichiers à récupérer n\'en obtiendrait qu\'un. Chaque fichier est alors effacé du serveur s\'il ne lui reste aucun autre lien exploitable. **Irréversible** — prévenir l\'utilisateur avant de cocher.',
  })
  @IsOptional()
  @IsBoolean()
  burnAfterDownload: boolean = false;

  @ApiPropertyOptional({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: MAX_PASSWORD_LENGTH,
    description:
      'Mot de passe facultatif. Quand il est défini, le lien seul ne suffit plus à télécharger — c\'est ce qui protège un lien transféré ou intercepté.',
  })
  @IsOptional()
  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH, {
    message: `Le mot de passe du lien doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`,
  })
  @MaxLength(MAX_PASSWORD_LENGTH)
  password?: string;

  @ApiProperty({
    minimum: MIN_HOURS,
    maximum: MAX_HOURS,
    default: DEFAULT_HOURS,
    description: 'Durée de validité du lien, en heures.',
  })
  @IsInt()
  @Min(MIN_HOURS)
  @Max(MAX_HOURS)
  expiresInHours: number = DEFAULT_HOURS;
}

export {
  DEFAULT_HOURS,
  MAX_FILES_PER_SHARE,
  MAX_HOURS,
  MAX_PASSWORD_LENGTH,
  MIN_HOURS,
  MIN_PASSWORD_LENGTH,
};
